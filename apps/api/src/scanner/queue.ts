import { getScanExecutionMode } from "./adapters/common.js";
import { getAdapter } from "./registry.js";
import { prepareScanSource } from "./source-prep.js";
import { getScan, updateScanMeta, updateScanStatus } from "./store.js";
import type { ScanRecord } from "./store.js";
import type { ScanRequest } from "./types.js";

const DEFAULT_WORKER_INTERVAL_MS = 250;
const MOCK_SCAN_DURATION_MS = 30;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 100;
const DEFAULT_MAX_RETRY_COUNT = 2;

/** 인메모리 FIFO 스캔 작업 큐 */
const scanJobQueue: string[] = [];
const deadLetterQueue: DeadLetterItem[] = [];

interface DeadLetterItem {
  scanId: string;
  retryCount: number;
  error: string;
  failedAt: string;
}

export type RedriveDeadLetterResult = "accepted" | "not_found" | "orphaned_scan";

let workerTimer: NodeJS.Timeout | null = null;
let isProcessing = false;
const retryTimers = new Set<NodeJS.Timeout>();

// 테스트에서 특정 scanId를 의도적으로 n회 실패시키기 위한 주입 훅
const forcedFailureByScanId = new Map<string, number>();

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

/**
 * 스캔 작업을 큐에 추가합니다.
 */
export function enqueueScan(scanId: string): void {
  scanJobQueue.push(scanId);
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
export function getDeadLetterSize(): number {
  return deadLetterQueue.length;
}

/**
 * dead-letter 항목 목록을 반환합니다.
 */
export function listDeadLetters(): DeadLetterItem[] {
  return [...deadLetterQueue];
}

/**
 * dead-letter 항목을 재처리 큐에 다시 올립니다.
 * - dead-letter가 없으면 `not_found`를 반환합니다.
 * - dead-letter는 있지만 store에 scan 레코드가 없으면 `orphaned_scan`을 반환하고 dead-letter는 유지합니다.
 * - 성공 시(`accepted`)에만 dead-letter 제거 + queued 전이 + enqueue를 수행합니다.
 */
export function redriveDeadLetter(scanId: string): RedriveDeadLetterResult {
  const deadLetterIndexes = findDeadLetterIndexes(scanId);
  if (deadLetterIndexes.length === 0) {
    return "not_found";
  }

  if (!getScan(scanId)) {
    return "orphaned_scan";
  }

  const updatedMeta = updateScanMeta(scanId, {
    retryCount: 0,
    lastError: null,
    findings: null,
  });
  const updatedStatus = updateScanStatus(scanId, "queued");

  if (!updatedMeta || !updatedStatus) {
    return "orphaned_scan";
  }

  removeDeadLetterIndexes(deadLetterIndexes);
  enqueueScan(scanId);
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

  retryTimers.add(retryTimer);
}

/**
 * 큐에서 다음 스캔 작업 하나를 처리합니다.
 * 처리할 작업이 없으면 false를 반환합니다.
 */
export async function processNextScanJob(): Promise<boolean> {
  if (isProcessing) {
    return false;
  }

  const scanId = scanJobQueue.shift();
  if (!scanId) {
    return false;
  }

  isProcessing = true;
  let sourceCleanup: (() => Promise<void>) | null = null;

  try {
    const scan = getScan(scanId);
    if (!scan) {
      return true;
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
      findings: {
        totalFindings: result.totalFindings,
        critical: result.critical,
        high: result.high,
        medium: result.medium,
        low: result.low,
      },
    });
    updateScanStatus(scanId, "completed");
    return true;
  } catch (error) {
    const latest = getScan(scanId);
    if (!latest) {
      return true;
    }

    const retryCount = latest.retryCount ?? 0;
    const maxRetryCount = getMaxRetryCount();
    const retryBackoffBaseMs = getRetryBackoffBaseMs();
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류";

    if (retryCount < maxRetryCount) {
      const nextRetryCount = retryCount + 1;
      const backoffMs = retryBackoffBaseMs * 2 ** (nextRetryCount - 1);

      updateScanMeta(scanId, {
        retryCount: nextRetryCount,
        lastError: errorMessage,
        findings: null,
      });
      updateScanStatus(scanId, "queued");
      scheduleRetry(scanId, backoffMs);
      return true;
    }

    updateScanMeta(scanId, {
      lastError: errorMessage,
      findings: null,
    });
    updateScanStatus(scanId, "failed");
    deadLetterQueue.push({
      scanId,
      retryCount,
      error: errorMessage,
      failedAt: new Date().toISOString(),
    });
    return true;
  } finally {
    if (sourceCleanup) {
      try {
        await sourceCleanup();
      } catch {
        // 정리 실패는 스캔 결과 상태를 덮어쓰지 않도록 무시한다.
      }
    }

    isProcessing = false;
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
 */
export function stopScanWorker(): void {
  if (!workerTimer) {
    return;
  }
  clearInterval(workerTimer);
  workerTimer = null;
}

/**
 * 테스트 격리를 위한 큐 초기화 유틸리티입니다.
 */
export function clearQueue(): void {
  scanJobQueue.length = 0;
  deadLetterQueue.length = 0;
  forcedFailureByScanId.clear();

  for (const retryTimer of retryTimers) {
    clearTimeout(retryTimer);
  }
  retryTimers.clear();
}
