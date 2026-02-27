import { getScan, updateScanMeta, updateScanStatus } from "./store.js";

const DEFAULT_WORKER_INTERVAL_MS = 250;
const MOCK_SCAN_DURATION_MS = 30;
const RETRY_BACKOFF_BASE_MS = 100;
const MAX_RETRY_COUNT = 2;

/** 인메모리 FIFO 스캔 작업 큐 */
const scanJobQueue: string[] = [];
const deadLetterQueue: DeadLetterItem[] = [];

interface DeadLetterItem {
  scanId: string;
  retryCount: number;
  error: string;
  failedAt: string;
}

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
  try {
    const scan = getScan(scanId);
    if (!scan) {
      return true;
    }

    updateScanStatus(scanId, "running");

    // 실제 외부 스캐너 호출 대신 짧은 지연으로 mock 처리
    await delay(MOCK_SCAN_DURATION_MS);

    if (consumeForcedFailure(scanId)) {
      throw new Error("테스트 강제 실패");
    }

    updateScanMeta(scanId, { lastError: null });
    updateScanStatus(scanId, "completed");
    return true;
  } catch (error) {
    const latest = getScan(scanId);
    if (!latest) {
      return true;
    }

    const retryCount = latest.retryCount ?? 0;
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류";

    if (retryCount < MAX_RETRY_COUNT) {
      const nextRetryCount = retryCount + 1;
      const backoffMs = RETRY_BACKOFF_BASE_MS * 2 ** (nextRetryCount - 1);

      updateScanMeta(scanId, {
        retryCount: nextRetryCount,
        lastError: errorMessage,
      });
      updateScanStatus(scanId, "queued");
      scheduleRetry(scanId, backoffMs);
      return true;
    }

    updateScanMeta(scanId, { lastError: errorMessage });
    updateScanStatus(scanId, "failed");
    deadLetterQueue.push({
      scanId,
      retryCount,
      error: errorMessage,
      failedAt: new Date().toISOString(),
    });
    return true;
  } finally {
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
