import { getScan, updateScanStatus } from "./store.js";

const DEFAULT_WORKER_INTERVAL_MS = 250;
const MOCK_SCAN_DURATION_MS = 30;

/** 인메모리 FIFO 스캔 작업 큐 */
const scanJobQueue: string[] = [];

let workerTimer: NodeJS.Timeout | null = null;
let isProcessing = false;

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

    updateScanStatus(scanId, "completed");
    return true;
  } catch {
    updateScanStatus(scanId, "failed");
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
}
