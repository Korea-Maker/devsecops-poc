import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQueue,
  enqueueScan,
  getDeadLetterSize,
  getQueueSize,
  listDeadLetters,
  processNextScanJob,
  setScanForcedFailuresForTest,
  stopScanWorker,
} from "../src/scanner/queue.js";
import { clearStore, createScan, getScan } from "../src/scanner/store.js";

describe("Scan Queue", () => {
  beforeEach(() => {
    stopScanWorker();
    clearQueue();
    clearStore();
    vi.useRealTimers();
  });

  afterEach(() => {
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
});
