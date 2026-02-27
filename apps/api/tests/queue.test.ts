import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQueue,
  enqueueScan,
  getDeadLetterSize,
  getQueueSize,
  listDeadLetters,
  processNextScanJob,
  redriveDeadLetter,
  setScanForcedFailuresForTest,
  stopScanWorker,
} from "../src/scanner/queue.js";
import { clearStore, createScan, getScan } from "../src/scanner/store.js";

const ORIGINAL_RETRY_BACKOFF_BASE_MS = process.env.SCAN_RETRY_BACKOFF_BASE_MS;
const ORIGINAL_MAX_RETRIES = process.env.SCAN_MAX_RETRIES;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("Scan Queue", () => {
  beforeEach(() => {
    stopScanWorker();
    clearQueue();
    clearStore();
    process.env.SCAN_RETRY_BACKOFF_BASE_MS = "100";
    process.env.SCAN_MAX_RETRIES = "2";
    vi.useRealTimers();
  });

  afterEach(() => {
    restoreEnv("SCAN_RETRY_BACKOFF_BASE_MS", ORIGINAL_RETRY_BACKOFF_BASE_MS);
    restoreEnv("SCAN_MAX_RETRIES", ORIGINAL_MAX_RETRIES);
    vi.useRealTimers();
  });

  it("처리할 job이 없으면 false를 반환해야 한다", async () => {
    const processed = await processNextScanJob();
    expect(processed).toBe(false);
  });

  it("enqueue 후 processNextScanJob 호출 시 queued -> running -> completed로 전이되어야 한다", async () => {
    const record = createScan({
      engine: "semgrep",
      repoUrl: "https://github.com/test/repo-queue",
      branch: "main",
    });
    enqueueScan(record.id);

    expect(getQueueSize()).toBe(1);
    expect(getScan(record.id)?.status).toBe("queued");

    vi.useFakeTimers();
    const jobPromise = processNextScanJob();

    // processNextScanJob는 await 이전에 running 상태를 기록한다.
    expect(getScan(record.id)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(40);
    const processed = await jobPromise;

    expect(processed).toBe(true);
    expect(getQueueSize()).toBe(0);
    expect(getScan(record.id)?.status).toBe("completed");
    expect(getScan(record.id)?.completedAt).toBeDefined();
  });

  it("1회 실패 후 재시도 성공 시 queued -> running -> queued(retry) -> running -> completed로 전이되어야 한다", async () => {
    const record = createScan({
      engine: "semgrep",
      repoUrl: "https://github.com/test/repo-retry-success",
      branch: "main",
    });
    enqueueScan(record.id);
    setScanForcedFailuresForTest(record.id, 1);

    vi.useFakeTimers();

    const firstJobPromise = processNextScanJob();
    expect(getScan(record.id)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(40);
    await firstJobPromise;

    expect(getScan(record.id)?.status).toBe("queued");
    expect(getScan(record.id)?.retryCount).toBe(1);
    expect(getScan(record.id)?.lastError).toBeDefined();
    expect(getQueueSize()).toBe(0);
    expect(getDeadLetterSize()).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(getQueueSize()).toBe(1);

    const secondJobPromise = processNextScanJob();
    expect(getScan(record.id)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(40);
    await secondJobPromise;

    expect(getScan(record.id)?.status).toBe("completed");
    expect(getScan(record.id)?.retryCount).toBe(1);
    expect(getScan(record.id)?.lastError).toBeUndefined();
    expect(getQueueSize()).toBe(0);
    expect(getDeadLetterSize()).toBe(0);
  });

  it("최대 재시도 초과 시 failed 상태가 되고 dead-letter에 적재되어야 한다", async () => {
    const record = createScan({
      engine: "trivy",
      repoUrl: "https://github.com/test/repo-dead-letter",
      branch: "main",
    });
    enqueueScan(record.id);
    setScanForcedFailuresForTest(record.id, 3);

    vi.useFakeTimers();

    const firstJobPromise = processNextScanJob();
    expect(getScan(record.id)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(40);
    await firstJobPromise;
    expect(getScan(record.id)?.status).toBe("queued");
    expect(getScan(record.id)?.retryCount).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(getQueueSize()).toBe(1);

    const secondJobPromise = processNextScanJob();
    expect(getScan(record.id)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(40);
    await secondJobPromise;
    expect(getScan(record.id)?.status).toBe("queued");
    expect(getScan(record.id)?.retryCount).toBe(2);

    await vi.advanceTimersByTimeAsync(200);
    expect(getQueueSize()).toBe(1);

    const thirdJobPromise = processNextScanJob();
    expect(getScan(record.id)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(40);
    await thirdJobPromise;

    expect(getScan(record.id)?.status).toBe("failed");
    expect(getScan(record.id)?.completedAt).toBeDefined();
    expect(getQueueSize()).toBe(0);
    expect(getDeadLetterSize()).toBe(1);
    expect(listDeadLetters()[0]?.scanId).toBe(record.id);
  });

  it("재시도 환경변수가 잘못되면 기본값(100ms, 2회)을 사용해야 한다", async () => {
    process.env.SCAN_RETRY_BACKOFF_BASE_MS = "invalid";
    process.env.SCAN_MAX_RETRIES = "-1";

    const record = createScan({
      engine: "trivy",
      repoUrl: "https://github.com/test/repo-invalid-env-fallback",
      branch: "main",
    });
    enqueueScan(record.id);
    setScanForcedFailuresForTest(record.id, 3);

    vi.useFakeTimers();

    const firstJobPromise = processNextScanJob();
    await vi.advanceTimersByTimeAsync(40);
    await firstJobPromise;

    await vi.advanceTimersByTimeAsync(50);
    expect(getQueueSize()).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(getQueueSize()).toBe(1);

    const secondJobPromise = processNextScanJob();
    await vi.advanceTimersByTimeAsync(40);
    await secondJobPromise;

    await vi.advanceTimersByTimeAsync(100);
    expect(getQueueSize()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(getQueueSize()).toBe(1);

    const thirdJobPromise = processNextScanJob();
    await vi.advanceTimersByTimeAsync(40);
    await thirdJobPromise;

    expect(getScan(record.id)?.status).toBe("failed");
    expect(getDeadLetterSize()).toBe(1);
    expect(listDeadLetters()[0]?.scanId).toBe(record.id);
  });

  it("dead-letter 재처리 성공 시 queued 상태로 되돌리고 큐에 다시 등록해야 한다", async () => {
    const record = createScan({
      engine: "gitleaks",
      repoUrl: "https://github.com/test/repo-redrive-success",
      branch: "main",
    });
    enqueueScan(record.id);
    setScanForcedFailuresForTest(record.id, 3);

    vi.useFakeTimers();

    const firstJobPromise = processNextScanJob();
    await vi.advanceTimersByTimeAsync(40);
    await firstJobPromise;

    await vi.advanceTimersByTimeAsync(100);
    const secondJobPromise = processNextScanJob();
    await vi.advanceTimersByTimeAsync(40);
    await secondJobPromise;

    await vi.advanceTimersByTimeAsync(200);
    const thirdJobPromise = processNextScanJob();
    await vi.advanceTimersByTimeAsync(40);
    await thirdJobPromise;

    expect(getScan(record.id)?.status).toBe("failed");
    expect(getScan(record.id)?.retryCount).toBe(2);
    expect(getScan(record.id)?.lastError).toBeDefined();
    expect(getDeadLetterSize()).toBe(1);

    const redriveResult = redriveDeadLetter(record.id);
    expect(redriveResult).toBe("accepted");
    expect(getDeadLetterSize()).toBe(0);
    expect(getQueueSize()).toBe(1);
    expect(getScan(record.id)?.status).toBe("queued");
    expect(getScan(record.id)?.retryCount).toBe(0);
    expect(getScan(record.id)?.lastError).toBeUndefined();

    const redriveJobPromise = processNextScanJob();
    await vi.advanceTimersByTimeAsync(40);
    await redriveJobPromise;

    expect(getScan(record.id)?.status).toBe("completed");
    expect(getScan(record.id)?.retryCount).toBe(0);
    expect(getQueueSize()).toBe(0);
  });

  it("dead-letter에 없는 scanId를 redrive하면 not_found를 반환해야 한다", () => {
    expect(redriveDeadLetter("missing-scan-id")).toBe("not_found");
  });

  it("dead-letter는 존재하지만 store에 스캔이 없으면 orphaned_scan을 반환하고 dead-letter를 유지해야 한다", async () => {
    const record = createScan({
      engine: "semgrep",
      repoUrl: "https://github.com/test/repo-redrive-missing-store",
      branch: "main",
    });
    enqueueScan(record.id);
    setScanForcedFailuresForTest(record.id, 3);

    vi.useFakeTimers();

    const firstJobPromise = processNextScanJob();
    await vi.advanceTimersByTimeAsync(40);
    await firstJobPromise;

    await vi.advanceTimersByTimeAsync(100);
    const secondJobPromise = processNextScanJob();
    await vi.advanceTimersByTimeAsync(40);
    await secondJobPromise;

    await vi.advanceTimersByTimeAsync(200);
    const thirdJobPromise = processNextScanJob();
    await vi.advanceTimersByTimeAsync(40);
    await thirdJobPromise;

    expect(getDeadLetterSize()).toBe(1);

    clearStore();

    const redriveResult = redriveDeadLetter(record.id);
    expect(redriveResult).toBe("orphaned_scan");
    expect(getDeadLetterSize()).toBe(1);
    expect(listDeadLetters()[0]?.scanId).toBe(record.id);
    expect(getQueueSize()).toBe(0);
  });
});
