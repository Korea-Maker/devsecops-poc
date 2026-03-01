import {
  getActiveDataBackend,
  getPersistedQueueStatusForTenant,
  listPersistedDeadLettersForTenant,
  persistQueueState,
  type PersistedDeadLetterItem,
  type PersistedQueueState,
  type PersistedRetryScheduleItem,
} from "../storage/backend.js";
import { getScanExecutionMode } from "./adapters/common.js";
import { getAdapter } from "./registry.js";
import { isSourcePrepError, prepareScanSource } from "./source-prep.js";
import { getScan, updateScanMeta, updateScanStatus } from "./store.js";
import type { UserRole } from "../tenants/types.js";
import type { ScanRecord } from "./store.js";
import type { ScanErrorCode, ScanRequest } from "./types.js";

const DEFAULT_WORKER_INTERVAL_MS = 250;
const MOCK_SCAN_DURATION_MS = 30;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 100;
const DEFAULT_MAX_RETRY_COUNT = 2;
const WORKER_DRAIN_POLL_INTERVAL_MS = 10;
const DEFAULT_WORKER_DRAIN_TIMEOUT_MS = 5_000;
const SCANNER_QUEUE_LOG_PREFIX = "[scanner-queue]";

/** 인메모리 FIFO 스캔 작업 큐 */
const scanJobQueue: string[] = [];
const deadLetterQueue: DeadLetterItem[] = [];

type DeadLetterItem = PersistedDeadLetterItem;

export type RedriveDeadLetterResult = "accepted" | "not_found" | "orphaned_scan";
export type ScanRuntimeErrorCode = ScanErrorCode;

interface QueueTenantFilter {
  tenantId?: string;
}

interface QueueTenantReadPathOptions extends QueueTenantFilter {
  userId?: string;
  userRole?: UserRole;
}

interface ScanRuntimeErrorInfo {
  code: ScanRuntimeErrorCode;
  message: string;
}

export interface ScanQueueStatus {
  queuedJobs: number;
  deadLetters: number;
  pendingRetryTimers: number;
  workerRunning: boolean;
  processing: boolean;
}

export interface ProcessNextScanJobResult {
  processed: boolean;
  busy: boolean;
}

let workerTimer: NodeJS.Timeout | null = null;
let isProcessing = false;
let processingScanId: string | null = null;

interface RetrySchedule {
  scanId: string;
  dueAt: string;
  timer: NodeJS.Timeout;
}

const retrySchedules = new Map<string, RetrySchedule>();

// 테스트에서 특정 scanId를 의도적으로 n회 실패시키기 위한 주입 훅
const forcedFailureByScanId = new Map<string, number>();
// 테스트에서 cleanup 실패 관측 경로를 검증하기 위한 주입 훅
const forcedCleanupFailureByScanId = new Set<string>();

interface StopScanWorkerOptions {
  /**
   * true일 때 pending retry timer에 걸려 있던 작업을 즉시 queue로 materialize한 뒤 타이머를 정리합니다.
   * 기본값(false)은 기존 정책처럼 타이머만 취소합니다.
   */
  materializePendingRetries?: boolean;
}

function cloneDeadLetterItem(item: PersistedDeadLetterItem): DeadLetterItem {
  return {
    ...item,
  };
}

function cloneRetryScheduleItem(
  item: PersistedRetryScheduleItem
): PersistedRetryScheduleItem {
  return {
    ...item,
  };
}

function toNormalizedDueAt(value: string): string | null {
  const dueAtMs = Date.parse(value);
  if (Number.isNaN(dueAtMs)) {
    return null;
  }

  return new Date(dueAtMs).toISOString();
}

function createQueueStateSnapshot(): PersistedQueueState {
  const pendingRetries = Array.from(retrySchedules.values(), (schedule) =>
    cloneRetryScheduleItem({
      scanId: schedule.scanId,
      dueAt: schedule.dueAt,
    })
  ).sort((left, right) => {
    if (left.dueAt === right.dueAt) {
      return left.scanId.localeCompare(right.scanId);
    }

    return left.dueAt.localeCompare(right.dueAt);
  });

  return {
    queuedScanIds: [...scanJobQueue],
    deadLetters: deadLetterQueue.map(cloneDeadLetterItem),
    pendingRetries,
  };
}

function persistCurrentQueueState(): void {
  persistQueueState(createQueueStateSnapshot());
}

export function hydrateQueueState(state: PersistedQueueState): void {
  clearPendingRetryTimers();
  scanJobQueue.length = 0;
  deadLetterQueue.length = 0;

  for (const scanId of state.queuedScanIds) {
    scanJobQueue.push(scanId);
  }

  for (const item of state.deadLetters) {
    deadLetterQueue.push(cloneDeadLetterItem(item));
  }

  const queuedScanIdSet = new Set(scanJobQueue);
  const hydratedRetryScanIdSet = new Set<string>();
  const now = Date.now();

  for (const retry of state.pendingRetries ?? []) {
    const scanId = retry.scanId?.trim();
    if (!scanId || hydratedRetryScanIdSet.has(scanId)) {
      continue;
    }

    hydratedRetryScanIdSet.add(scanId);

    if (queuedScanIdSet.has(scanId)) {
      continue;
    }

    const normalizedDueAt = toNormalizedDueAt(retry.dueAt);
    if (!normalizedDueAt) {
      enqueueScanInternal(scanId, { persist: false });
      queuedScanIdSet.add(scanId);
      continue;
    }

    const dueAtMs = Date.parse(normalizedDueAt);
    if (dueAtMs <= now) {
      enqueueScanInternal(scanId, { persist: false });
      queuedScanIdSet.add(scanId);
      continue;
    }

    scheduleRetry(scanId, dueAtMs - now, {
      dueAt: normalizedDueAt,
      persist: false,
    });
  }

  forcedFailureByScanId.clear();
  forcedCleanupFailureByScanId.clear();
  isProcessing = false;
  processingScanId = null;
  persistCurrentQueueState();
}


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toScanRequest(scan: ScanRecord): ScanRequest {
  return {
    id: scan.id,
    engine: scan.engine,
    repoUrl: scan.repoUrl,
    branch: scan.branch,
    status: scan.status,
    createdAt: new Date(scan.createdAt),
  };
}

function readEnvIntWithFallback(
  key: string,
  fallback: number,
  options: { min: number }
): number {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < options.min) {
    return fallback;
  }

  return parsed;
}

function getRetryBackoffBaseMs(): number {
  return readEnvIntWithFallback(
    "SCAN_RETRY_BACKOFF_BASE_MS",
    DEFAULT_RETRY_BACKOFF_BASE_MS,
    { min: 1 }
  );
}

function getMaxRetryCount(): number {
  return readEnvIntWithFallback("SCAN_MAX_RETRIES", DEFAULT_MAX_RETRY_COUNT, {
    min: 0,
  });
}

function findDeadLetterIndexes(scanId: string): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < deadLetterQueue.length; index += 1) {
    if (deadLetterQueue[index]?.scanId === scanId) {
      indexes.push(index);
    }
  }
  return indexes;
}

function removeDeadLetterIndexes(indexes: number[]): void {
  for (const index of indexes.sort((a, b) => b - a)) {
    deadLetterQueue.splice(index, 1);
  }
}

function matchesTenantFilter(scanId: string, filter?: QueueTenantFilter): boolean {
  if (!filter?.tenantId) {
    return true;
  }

  const scan = getScan(scanId);
  return scan?.tenantId === filter.tenantId;
}

function dequeueNextScanId(filter?: QueueTenantFilter): string | undefined {
  if (!filter?.tenantId) {
    const nextScanId = scanJobQueue.shift();
    if (nextScanId) {
      persistCurrentQueueState();
    }
    return nextScanId;
  }

  const targetIndex = scanJobQueue.findIndex((scanId) =>
    matchesTenantFilter(scanId, filter)
  );

  if (targetIndex < 0) {
    return undefined;
  }

  const [scanId] = scanJobQueue.splice(targetIndex, 1);
  if (scanId) {
    persistCurrentQueueState();
  }
  return scanId;
}

function isTenantScopedProcessingBusy(filter?: QueueTenantFilter): boolean {
  if (!isProcessing || processingScanId === null) {
    return false;
  }

  return matchesTenantFilter(processingScanId, filter);
}

function enqueueScanInternal(
  scanId: string,
  options: { persist?: boolean } = {}
): void {
  scanJobQueue.push(scanId);

  if (options.persist ?? true) {
    persistCurrentQueueState();
  }
}

/**
 * 스캔 작업을 큐에 추가합니다.
 */
export function enqueueScan(scanId: string): void {
  enqueueScanInternal(scanId);
}

/**
 * 현재 대기 중인 큐 길이를 반환합니다.
 */
export function getQueueSize(): number {
  return scanJobQueue.length;
}

/**
 * 현재 dead-letter 큐 길이를 반환합니다.
 */
export function getDeadLetterSize(filter?: QueueTenantFilter): number {
  if (!filter?.tenantId) {
    return deadLetterQueue.length;
  }

  return deadLetterQueue.filter((item) => matchesTenantFilter(item.scanId, filter)).length;
}

/**
 * dead-letter 항목 목록을 반환합니다.
 */
export function listDeadLetters(filter?: QueueTenantFilter): DeadLetterItem[] {
  const source = filter?.tenantId
    ? deadLetterQueue.filter((item) => matchesTenantFilter(item.scanId, filter))
    : deadLetterQueue;

  return source.map((item) => ({ ...item }));
}

/**
 * 요청 경로 read 최적화:
 * - DATA_BACKEND=postgres일 때 tenant-scoped direct query를 우선 사용
 * - 그 외(memory 포함)는 기존 인메모리 큐 상태를 사용
 */
export async function listDeadLettersForTenantReadPath(
  options?: QueueTenantReadPathOptions
): Promise<DeadLetterItem[]> {
  if (getActiveDataBackend() === "postgres") {
    const persistedDeadLetters = await listPersistedDeadLettersForTenant({
      tenantId: options?.tenantId,
      userId: options?.userId,
      userRole: options?.userRole,
    });

    if (persistedDeadLetters) {
      return persistedDeadLetters.map(cloneDeadLetterItem);
    }
  }

  return listDeadLetters(options);
}

/**
 * dead-letter 항목을 재처리 큐에 다시 올립니다.
 * - dead-letter가 없으면 `not_found`를 반환합니다.
 * - tenant 필터가 전달되면 해당 tenant의 scan만 재처리할 수 있습니다(불일치 시 `not_found`).
 * - tenant 필터가 없고 store에 scan 레코드가 없으면 `orphaned_scan`을 반환합니다.
 * - 성공 시(`accepted`)에만 dead-letter 제거 + queued 전이 + enqueue를 수행합니다.
 */
export function redriveDeadLetter(
  scanId: string,
  filter?: QueueTenantFilter
): RedriveDeadLetterResult {
  const deadLetterIndexes = findDeadLetterIndexes(scanId);
  if (deadLetterIndexes.length === 0) {
    return "not_found";
  }

  const scan = getScan(scanId);
  if (!scan) {
    return filter?.tenantId ? "not_found" : "orphaned_scan";
  }

  if (filter?.tenantId && scan.tenantId !== filter.tenantId) {
    return "not_found";
  }

  const updatedMeta = updateScanMeta(scanId, {
    retryCount: 0,
    lastError: null,
    lastErrorCode: null,
    findings: null,
  });
  const updatedStatus = updateScanStatus(scanId, "queued");

  if (!updatedMeta || !updatedStatus) {
    return "orphaned_scan";
  }

  removeDeadLetterIndexes(deadLetterIndexes);
  enqueueScanInternal(scanId, { persist: false });
  persistCurrentQueueState();
  return "accepted";
}

/**
 * 테스트 훅: 특정 scanId를 n회 강제로 실패시킵니다.
 */
export function setScanForcedFailuresForTest(scanId: string, failures: number): void {
  if (failures <= 0) {
    forcedFailureByScanId.delete(scanId);
    return;
  }
  forcedFailureByScanId.set(scanId, failures);
}

/**
 * 테스트 훅: 특정 scanId의 cleanup을 의도적으로 실패시킵니다.
 */
export function setCleanupFailureForTest(scanId: string, shouldFail: boolean): void {
  if (shouldFail) {
    forcedCleanupFailureByScanId.add(scanId);
    return;
  }
  forcedCleanupFailureByScanId.delete(scanId);
}

function consumeForcedFailure(scanId: string): boolean {
  const remaining = forcedFailureByScanId.get(scanId);
  if (!remaining || remaining <= 0) {
    return false;
  }

  if (remaining === 1) {
    forcedFailureByScanId.delete(scanId);
  } else {
    forcedFailureByScanId.set(scanId, remaining - 1);
  }

  return true;
}

interface ScheduleRetryOptions {
  dueAt?: string;
  persist?: boolean;
}

function materializeRetrySchedule(scanId: string, retryTimer?: NodeJS.Timeout): void {
  const scheduled = retrySchedules.get(scanId);
  if (!scheduled) {
    return;
  }

  if (retryTimer && scheduled.timer !== retryTimer) {
    return;
  }

  clearTimeout(scheduled.timer);
  retrySchedules.delete(scanId);

  if (!scanJobQueue.includes(scanId)) {
    enqueueScanInternal(scanId, { persist: false });
  }

  persistCurrentQueueState();
}

function scheduleRetry(
  scanId: string,
  backoffMs: number,
  options: ScheduleRetryOptions = {}
): void {
  const normalizedBackoffMs = Math.max(0, Math.trunc(backoffMs));
  const normalizedDueAt = options.dueAt ? toNormalizedDueAt(options.dueAt) : null;
  const dueAtMs = normalizedDueAt
    ? Date.parse(normalizedDueAt)
    : Date.now() + normalizedBackoffMs;
  const delayMs = Math.max(0, dueAtMs - Date.now());

  const existingSchedule = retrySchedules.get(scanId);
  if (existingSchedule) {
    clearTimeout(existingSchedule.timer);
    retrySchedules.delete(scanId);
  }

  const retryTimer = setTimeout(() => {
    materializeRetrySchedule(scanId, retryTimer);
  }, delayMs);

  retryTimer.unref?.();

  retrySchedules.set(scanId, {
    scanId,
    dueAt: new Date(dueAtMs).toISOString(),
    timer: retryTimer,
  });

  if (options.persist ?? true) {
    persistCurrentQueueState();
  }
}

function clearPendingRetryTimers(options: { materializeIntoQueue?: boolean } = {}): void {
  const bufferedScanIds: string[] = [];
  const bufferedScanIdSet = new Set<string>();

  for (const schedule of retrySchedules.values()) {
    clearTimeout(schedule.timer);

    if (
      options.materializeIntoQueue &&
      !scanJobQueue.includes(schedule.scanId) &&
      !bufferedScanIdSet.has(schedule.scanId)
    ) {
      bufferedScanIds.push(schedule.scanId);
      bufferedScanIdSet.add(schedule.scanId);
    }
  }

  retrySchedules.clear();

  if (options.materializeIntoQueue) {
    for (const scanId of bufferedScanIds) {
      enqueueScanInternal(scanId, { persist: false });
    }
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "알 수 없는 오류";
}

function normalizeScanRuntimeError(error: unknown): ScanRuntimeErrorInfo {
  if (isSourcePrepError(error)) {
    if (error.code === "SOURCE_PREP_UNSUPPORTED_REPO_URL") {
      return {
        code: error.code,
        message: "지원하지 않는 저장소 주소 형식입니다",
      };
    }

    return {
      code: error.code,
      message: "스캔 소스 준비에 실패했습니다",
    };
  }

  if (error instanceof Error) {
    return {
      code: "SCAN_EXECUTION_FAILED",
      message: "스캔 실행에 실패했습니다",
    };
  }

  return {
    code: "SCAN_UNKNOWN_ERROR",
    message: "스캔 실행 중 알 수 없는 오류가 발생했습니다",
  };
}

/**
 * 현재 대기 중인 retry 타이머 개수를 반환합니다.
 */
export function getPendingRetryTimerCount(filter?: QueueTenantFilter): number {
  if (!filter?.tenantId) {
    return retrySchedules.size;
  }

  let count = 0;
  for (const schedule of retrySchedules.values()) {
    if (matchesTenantFilter(schedule.scanId, filter)) {
      count += 1;
    }
  }

  return count;
}

/**
 * 워커가 현재 실행 중인지 반환합니다.
 */
export function isScanWorkerRunning(): boolean {
  return workerTimer !== null;
}

/**
 * 큐 운영 상태를 요약해 반환합니다.
 */
function getQueueProcessingStatus(filter?: QueueTenantFilter): boolean {
  if (!filter?.tenantId) {
    return isProcessing;
  }

  return isProcessing && processingScanId !== null && matchesTenantFilter(processingScanId, filter);
}

export function getQueueStatus(filter?: QueueTenantFilter): ScanQueueStatus {
  const queuedJobs = filter?.tenantId
    ? scanJobQueue.filter((scanId) => matchesTenantFilter(scanId, filter)).length
    : getQueueSize();

  return {
    queuedJobs,
    deadLetters: getDeadLetterSize(filter),
    pendingRetryTimers: getPendingRetryTimerCount(filter),
    workerRunning: isScanWorkerRunning(),
    processing: getQueueProcessingStatus(filter),
  };
}

/**
 * 요청 경로 read 최적화:
 * - DATA_BACKEND=postgres일 때 tenant-scoped direct query를 우선 사용
 * - 그 외(memory 포함)는 기존 인메모리 큐 상태를 사용
 */
export async function getQueueStatusForTenantReadPath(
  options?: QueueTenantReadPathOptions
): Promise<ScanQueueStatus> {
  if (getActiveDataBackend() === "postgres") {
    const persistedStatus = await getPersistedQueueStatusForTenant({
      tenantId: options?.tenantId,
      userId: options?.userId,
      userRole: options?.userRole,
    });

    if (persistedStatus) {
      return {
        queuedJobs: persistedStatus.queuedJobs,
        deadLetters: persistedStatus.deadLetters,
        pendingRetryTimers: persistedStatus.pendingRetryTimers,
        workerRunning: isScanWorkerRunning(),
        processing: getQueueProcessingStatus(options),
      };
    }
  }

  return getQueueStatus(options);
}

/**
 * 현재 처리 중인 작업이 끝날 때까지 최대 timeoutMs 동안 대기합니다.
 * 반환값: true(대기 중 idle 도달), false(타임아웃)
 */
export async function waitForQueueIdle(
  timeoutMs = DEFAULT_WORKER_DRAIN_TIMEOUT_MS
): Promise<boolean> {
  const startedAt = Date.now();

  while (isProcessing) {
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }

    await delay(WORKER_DRAIN_POLL_INTERVAL_MS);
  }

  return true;
}

/**
 * 큐에서 다음 스캔 작업 하나를 처리합니다.
 * - busy: 이미 다른 작업을 처리 중인 상태
 * - empty: 처리할 작업이 없는 상태
 */
export async function processNextScanJob(
  filter?: QueueTenantFilter
): Promise<ProcessNextScanJobResult> {
  if (isProcessing) {
    if (filter?.tenantId) {
      return {
        processed: false,
        busy: isTenantScopedProcessingBusy(filter),
      };
    }

    return { processed: false, busy: true };
  }

  const scanId = dequeueNextScanId(filter);
  if (!scanId) {
    return { processed: false, busy: false };
  }

  const existingRetrySchedule = retrySchedules.get(scanId);
  if (existingRetrySchedule) {
    clearTimeout(existingRetrySchedule.timer);
    retrySchedules.delete(scanId);
    persistCurrentQueueState();
  }

  isProcessing = true;
  processingScanId = scanId;
  let sourceCleanup: (() => Promise<void>) | null = null;

  try {
    const scan = getScan(scanId);
    if (!scan) {
      return { processed: true, busy: false };
    }

    updateScanStatus(scanId, "running");

    // mock 모드에서도 기존 테스트/동작과 동일하게 짧은 처리 지연을 유지한다.
    await delay(MOCK_SCAN_DURATION_MS);

    const executionMode = getScanExecutionMode();
    const preparedSource = await prepareScanSource(
      scan.repoUrl,
      scan.branch,
      executionMode
    );
    sourceCleanup = preparedSource.cleanup;

    if (consumeForcedFailure(scanId)) {
      throw new Error("테스트 강제 실패");
    }

    const adapter = getAdapter(scan.engine);
    const result = await adapter.scan({
      ...toScanRequest(scan),
      repoUrl: preparedSource.repoUrl,
      status: "running",
    });

    updateScanMeta(scanId, {
      lastError: null,
      lastErrorCode: null,
      findings: {
        totalFindings: result.totalFindings,
        critical: result.critical,
        high: result.high,
        medium: result.medium,
        low: result.low,
      },
    });
    updateScanStatus(scanId, "completed");
    return { processed: true, busy: false };
  } catch (error) {
    const latest = getScan(scanId);
    if (!latest) {
      return { processed: true, busy: false };
    }

    const retryCount = latest.retryCount ?? 0;
    const maxRetryCount = getMaxRetryCount();
    const retryBackoffBaseMs = getRetryBackoffBaseMs();
    const runtimeError = normalizeScanRuntimeError(error);

    if (retryCount < maxRetryCount) {
      const nextRetryCount = retryCount + 1;
      const backoffMs = retryBackoffBaseMs * 2 ** (nextRetryCount - 1);

      updateScanMeta(scanId, {
        retryCount: nextRetryCount,
        lastError: runtimeError.message,
        lastErrorCode: runtimeError.code,
        findings: null,
      });
      updateScanStatus(scanId, "queued");
      scheduleRetry(scanId, backoffMs);
      return { processed: true, busy: false };
    }

    updateScanMeta(scanId, {
      lastError: runtimeError.message,
      lastErrorCode: runtimeError.code,
      findings: null,
    });
    updateScanStatus(scanId, "failed");
    deadLetterQueue.push({
      scanId,
      retryCount,
      error: runtimeError.message,
      code: runtimeError.code,
      failedAt: new Date().toISOString(),
    });
    persistCurrentQueueState();
    return { processed: true, busy: false };
  } finally {
    if (sourceCleanup) {
      try {
        await sourceCleanup();
        if (forcedCleanupFailureByScanId.has(scanId)) {
          throw new Error("테스트 cleanup 강제 실패");
        }
      } catch (cleanupError) {
        // 정리 실패는 스캔 결과 상태를 덮어쓰지 않되, 관측 가능하게 로그를 남긴다.
        console.warn(
          `${SCANNER_QUEUE_LOG_PREFIX} source cleanup 실패 (scanId=${scanId}): ${toErrorMessage(cleanupError)}`
        );
      }
    }

    isProcessing = false;
    processingScanId = null;
  }
}

/**
 * 일정 간격으로 큐를 소비하는 워커를 시작합니다.
 */
export function startScanWorker(intervalMs = DEFAULT_WORKER_INTERVAL_MS): void {
  if (workerTimer) {
    return;
  }

  workerTimer = setInterval(() => {
    void processNextScanJob();
  }, intervalMs);

  workerTimer.unref?.();
}

/**
 * 실행 중인 큐 워커를 중지합니다.
 * 기본 정책: 워커 중지 시점에 pending retry timer를 취소해 stop 이후 예기치 않은 재enqueue를 막습니다.
 *
 * - materializePendingRetries=true: shutdown 직전 복구성 강화를 위해 pending retry를 즉시 queue로 이동
 * - materializePendingRetries=false(default): 기존 동작 유지(타이머 취소만 수행)
 */
export function stopScanWorker(options: StopScanWorkerOptions = {}): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }

  clearPendingRetryTimers({
    materializeIntoQueue: options.materializePendingRetries ?? false,
  });
  persistCurrentQueueState();
}

/**
 * 워커를 중지한 뒤 현재 진행 중인 1건 처리 종료까지 대기합니다.
 * timeout 내 종료하지 못하면 경고 로그만 남기고 반환합니다.
 */
export async function stopScanWorkerAndDrain(
  options: {
    timeoutMs?: number;
    materializePendingRetries?: boolean;
  } = {}
): Promise<void> {
  stopScanWorker({
    materializePendingRetries: options.materializePendingRetries ?? true,
  });

  const drained = await waitForQueueIdle(options.timeoutMs);
  if (!drained) {
    console.warn(
      `${SCANNER_QUEUE_LOG_PREFIX} drain timeout: processing 작업이 timeout 내 종료되지 않았습니다`
    );
  }
}

/**
 * 테스트 격리를 위한 큐 초기화 유틸리티입니다.
 */
export function clearQueue(): void {
  scanJobQueue.length = 0;
  deadLetterQueue.length = 0;
  forcedFailureByScanId.clear();
  forcedCleanupFailureByScanId.clear();
  isProcessing = false;
  processingScanId = null;
  clearPendingRetryTimers();
  persistCurrentQueueState();
}
