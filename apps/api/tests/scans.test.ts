import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  clearQueue,
  processNextScanJob,
  setScanForcedFailuresForTest,
  stopScanWorker,
} from "../src/scanner/queue.js";
import { clearStore } from "../src/scanner/store.js";

const ORIGINAL_RETRY_BACKOFF_BASE_MS = process.env.SCAN_RETRY_BACKOFF_BASE_MS;
const ORIGINAL_MAX_RETRIES = process.env.SCAN_MAX_RETRIES;
const ORIGINAL_SCAN_EXECUTION_MODE = process.env.SCAN_EXECUTION_MODE;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function moveScanToDeadLetter(scanId: string): Promise<void> {
  setScanForcedFailuresForTest(scanId, 3);

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
}

describe("Scans API", () => {
  const app = buildApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    stopScanWorker();
    clearQueue();
    clearStore();
    process.env.SCAN_RETRY_BACKOFF_BASE_MS = "100";
    process.env.SCAN_MAX_RETRIES = "2";
    process.env.SCAN_EXECUTION_MODE = "mock";
    vi.useRealTimers();
  });

  afterEach(() => {
    restoreEnv("SCAN_RETRY_BACKOFF_BASE_MS", ORIGINAL_RETRY_BACKOFF_BASE_MS);
    restoreEnv("SCAN_MAX_RETRIES", ORIGINAL_MAX_RETRIES);
    restoreEnv("SCAN_EXECUTION_MODE", ORIGINAL_SCAN_EXECUTION_MODE);
    vi.useRealTimers();
  });

  describe("POST /api/v1/scans", () => {
    it("유효한 요청 시 202와 scanId를 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo", branch: "main" },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toHaveProperty("scanId");
      expect(response.json().status).toBe("queued");
    });

    it("scanId가 UUID 형식이어야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo" },
      });

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(response.json().scanId)).toBe(true);
    });

    it("git@ 형식 repoUrl이면 202를 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "git@github.com:test/repo.git" },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toHaveProperty("scanId");
      expect(response.json().status).toBe("queued");
    });

    it("로컬 디렉터리 경로 repoUrl이면 202를 반환해야 한다", async () => {
      const localDir = mkdtempSync(join(tmpdir(), "scan-route-local-"));

      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/scans",
          payload: { engine: "trivy", repoUrl: localDir },
        });

        expect(response.statusCode).toBe(202);
        expect(response.json()).toHaveProperty("scanId");
        expect(response.json().status).toBe("queued");
      } finally {
        rmSync(localDir, { recursive: true, force: true });
      }
    });

    it("branch 미지정 시 기본값 'main'이 적용되어야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo" },
      });

      const { scanId } = createRes.json();
      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().branch).toBe("main");
    });

    it("유효하지 않은 engine이면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "invalid", repoUrl: "https://github.com/test/repo" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    });

    it("engine이 누락되면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { repoUrl: "https://github.com/test/repo" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    });

    it("유효하지 않은 repoUrl이면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "not-a-url" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    });

    it("ftp:// 스킴 repoUrl이면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "ftp://example.com/repo.git" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    });

    it("repoUrl이 누락되면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    });

    it("repoUrl이 빈 문자열이면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "   " },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    });
  });

  describe("GET /api/v1/scans/:id", () => {
    it("POST로 생성한 스캔을 GET으로 조회하면 200을 반환해야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo", branch: "main" },
      });

      const { scanId } = createRes.json();
      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().id).toBe(scanId);
      expect(getRes.json().status).toBe("queued");
    });

    it("완료된 스캔 조회 시 findings 요약이 포함되어야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-findings" },
      });

      const { scanId } = createRes.json();

      vi.useFakeTimers();
      const jobPromise = processNextScanJob();
      await vi.advanceTimersByTimeAsync(40);
      await jobPromise;

      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().status).toBe("completed");
      expect(getRes.json().findings).toBeDefined();
      expect(getRes.json().findings.totalFindings).toBe(
        getRes.json().findings.critical +
          getRes.json().findings.high +
          getRes.json().findings.medium +
          getRes.json().findings.low
      );
    });

    it("존재하지 않는 스캔을 조회하면 404를 반환해야 한다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans/nonexistent-id",
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/v1/scans", () => {
    it("스캔 목록을 배열로 반환해야 한다", async () => {
      // 스캔 2개 생성
      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-a" },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo-b" },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);
    });

    it("status 쿼리 파라미터로 필터링할 수 있어야 한다", async () => {
      // 새 스캔 생성 (queued 상태)
      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "gitleaks", repoUrl: "https://github.com/test/repo-c" },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans?status=queued",
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      for (const scan of body) {
        expect(scan.status).toBe("queued");
      }
    });
  });

  describe("Dead-letter API", () => {
    it("GET /api/v1/scans/dead-letters는 dead-letter 목록을 반환해야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo-dead-letter-list" },
      });

      const { scanId } = createRes.json();
      await moveScanToDeadLetter(scanId);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans/dead-letters",
      });

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json())).toBe(true);
      expect(response.json()).toHaveLength(1);
      expect(response.json()[0]?.scanId).toBe(scanId);
    });

    it("POST /api/v1/scans/:id/redrive 성공 시 202와 queued 상태를 반환해야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "gitleaks", repoUrl: "https://github.com/test/repo-redrive-success" },
      });

      const { scanId } = createRes.json();
      await moveScanToDeadLetter(scanId);

      const redriveRes = await app.inject({
        method: "POST",
        url: `/api/v1/scans/${scanId}/redrive`,
      });

      expect(redriveRes.statusCode).toBe(202);
      expect(redriveRes.json()).toEqual({ scanId, status: "queued" });

      const deadLettersRes = await app.inject({
        method: "GET",
        url: "/api/v1/scans/dead-letters",
      });
      expect(deadLettersRes.statusCode).toBe(200);
      expect(deadLettersRes.json()).toHaveLength(0);

      const scanRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
      });
      expect(scanRes.statusCode).toBe(200);
      expect(scanRes.json().status).toBe("queued");
      expect(scanRes.json().retryCount).toBe(0);
      expect(scanRes.json().lastError).toBeUndefined();
    });

    it("dead-letter에 없는 scanId redrive 요청 시 404를 반환해야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-redrive-404" },
      });

      const { scanId } = createRes.json();

      const redriveRes = await app.inject({
        method: "POST",
        url: `/api/v1/scans/${scanId}/redrive`,
      });

      expect(redriveRes.statusCode).toBe(404);
      expect(redriveRes.json()).toHaveProperty("error");
    });

    it("orphan dead-letter redrive 요청 시 409를 반환하고 dead-letter를 유지해야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo-redrive-orphan" },
      });

      const { scanId } = createRes.json();
      await moveScanToDeadLetter(scanId);

      clearStore();

      const redriveRes = await app.inject({
        method: "POST",
        url: `/api/v1/scans/${scanId}/redrive`,
      });

      expect(redriveRes.statusCode).toBe(409);
      expect(redriveRes.json()).toHaveProperty("error");
      expect(redriveRes.json().error).toContain("orphaned_scan");

      const deadLettersRes = await app.inject({
        method: "GET",
        url: "/api/v1/scans/dead-letters",
      });
      expect(deadLettersRes.statusCode).toBe(200);
      expect(deadLettersRes.json()).toHaveLength(1);
      expect(deadLettersRes.json()[0]?.scanId).toBe(scanId);
    });
  });
});
