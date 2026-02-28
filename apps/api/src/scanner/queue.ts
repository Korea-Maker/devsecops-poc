import {
  persistQueueState,
  type PersistedDeadLetterItem,
  type PersistedQueueState,
} from "../storage/backend.js";
import { getScanExecutionMode } from "./adapters/common.js";
import { getAdapter } from "./registry.js";
import { isSourcePrepError, prepareScanSource } from "./source-prep.js";
import { getScan, updateScanMeta, updateScanStatus } from "./store.js";
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
const retryTimers = new Map<NodeJS.Timeout, string>();

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

function createQueueStateSnapshot(): PersistedQueueState {
  return {
    queuedScanIds: [...scanJobQueue],
    deadLetters: deadLetterQueue.map(cloneDeadLetterItem),
  };
}

function persistCurrentQueueState(): void {
  persistQueueState(createQueueStateSnapshot());
}

export function hydrateQueueState(state: PersistedQueueState): void {
  scanJobQueue.length = 0;
  deadLetterQueue.length = 0;

  for (const scanId of state.queuedScanIds) {
    scanJobQueue.push(scanId);
  }

  for (const item of state.deadLetters) {
    deadLetterQueue.push(cloneDeadLetterItem(item));
  }

  clearPendingRetryTimers();
  forcedFailureByScanId.clear();
  forcedCleanupFailureByScanId.clear();
  isProcessing = false;
  processingScanId = null;
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

function scheduleRetry(scanId: string, backoffMs: number): void {
  const retryTimer = setTimeout(() => {
    retryTimers.delete(retryTimer);
    enqueueScan(scanId);
  }, backoffMs);

  retryTimers.set(retryTimer, scanId);
}

function clearPendingRetryTimers(options: { materializeIntoQueue?: boolean } = {}): void {
  const bufferedScanIds: string[] = [];

  for (const [retryTimer, scanId] of retryTimers.entries()) {
    clearTimeout(retryTimer);
    if (options.materializeIntoQueue) {
      bufferedScanIds.push(scanId);
    }
  }
  retryTimers.clear();

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
    return retryTimers.size;
  }

  let count = 0;
  for (const scanId of retryTimers.values()) {
    if (matchesTenantFilter(scanId, filter)) {
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
export function getQueueStatus(filter?: QueueTenantFilter): ScanQueueStatus {
  const queuedJobs = filter?.tenantId
    ? scanJobQueue.filter((scanId) => matchesTenantFilter(scanId, filter)).length
    : getQueueSize();

  const processing = filter?.tenantId
    ? isProcessing && processingScanId !== null && matchesTenantFilter(processingScanId, filter)
    : isProcessing;

  return {
    queuedJobs,
    deadLetters: getDeadLetterSize(filter),
    pendingRetryTimers: getPendingRetryTimerCount(filter),
    workerRunning: isScanWorkerRunning(),
    processing,
  };
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
