import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQueue,
  enqueueScan,
  getQueueSize,
  processNextScanJob,
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
});
