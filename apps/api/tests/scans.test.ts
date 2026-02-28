import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  clearQueue,
  processNextScanJob,
  setScanForcedFailuresForTest,
  stopScanWorker,
} from "../src/scanner/queue.js";
import { clearStore } from "../src/scanner/store.js";
import type { UserRole } from "../src/tenants/types.js";

const ORIGINAL_RETRY_BACKOFF_BASE_MS = process.env.SCAN_RETRY_BACKOFF_BASE_MS;
const ORIGINAL_MAX_RETRIES = process.env.SCAN_MAX_RETRIES;
const ORIGINAL_SCAN_EXECUTION_MODE = process.env.SCAN_EXECUTION_MODE;
const ORIGINAL_TENANT_AUTH_MODE = process.env.TENANT_AUTH_MODE;
const ORIGINAL_AUTH_MODE = process.env.AUTH_MODE;
const ORIGINAL_JWT_ISSUER = process.env.JWT_ISSUER;
const ORIGINAL_JWT_AUDIENCE = process.env.JWT_AUDIENCE;
const ORIGINAL_JWT_JWKS_URL = process.env.JWT_JWKS_URL;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function buildTenantHeaders(options: {
  tenantId?: string;
  userId?: string;
  role?: UserRole;
} = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "x-user-id": options.userId ?? "user-1",
    "x-user-role": options.role ?? "admin",
  };

  if (options.tenantId !== undefined) {
    headers["x-tenant-id"] = options.tenantId;
  }

  return headers;
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
    delete process.env.TENANT_AUTH_MODE;
    delete process.env.AUTH_MODE;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.JWT_JWKS_URL;
    vi.useRealTimers();
  });

  afterEach(() => {
    restoreEnv("SCAN_RETRY_BACKOFF_BASE_MS", ORIGINAL_RETRY_BACKOFF_BASE_MS);
    restoreEnv("SCAN_MAX_RETRIES", ORIGINAL_MAX_RETRIES);
    restoreEnv("SCAN_EXECUTION_MODE", ORIGINAL_SCAN_EXECUTION_MODE);
    restoreEnv("TENANT_AUTH_MODE", ORIGINAL_TENANT_AUTH_MODE);
    restoreEnv("AUTH_MODE", ORIGINAL_AUTH_MODE);
    restoreEnv("JWT_ISSUER", ORIGINAL_JWT_ISSUER);
    restoreEnv("JWT_AUDIENCE", ORIGINAL_JWT_AUDIENCE);
    restoreEnv("JWT_JWKS_URL", ORIGINAL_JWT_JWKS_URL);
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
      expect(response.json().code).toBe("SCAN_INVALID_ENGINE");
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
      expect(response.json().code).toBe("SCAN_INVALID_REPO_URL");
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

    it("invalid JSON 요청은 500이 아닌 4xx를 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: {
          "content-type": "application/json",
        },
        payload: '{"engine":"semgrep",',
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
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

    it("실패 후 재시도 대기 상태 조회 시 lastErrorCode를 확인할 수 있어야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-last-error-code" },
      });

      const { scanId } = createRes.json();
      setScanForcedFailuresForTest(scanId, 1);

      vi.useFakeTimers();
      const jobPromise = processNextScanJob();
      await vi.advanceTimersByTimeAsync(40);
      await jobPromise;

      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().status).toBe("queued");
      expect(getRes.json().lastError).toBeDefined();
      expect(getRes.json().lastErrorCode).toBe("SCAN_EXECUTION_FAILED");
    });

    it("존재하지 않는 스캔을 조회하면 404를 반환해야 한다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans/nonexistent-id",
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "스캔을 찾을 수 없습니다",
        code: "SCAN_NOT_FOUND",
      });
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

  describe("Queue Admin API", () => {
    it("GET /api/v1/scans/queue/status는 기본 큐 상태를 반환해야 한다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans/queue/status",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        queuedJobs: 0,
        deadLetters: 0,
        pendingRetryTimers: 0,
        workerRunning: false,
        processing: false,
      });
    });

    it("GET /api/v1/scans/queue/status는 처리 중이면 processing=true를 반환해야 한다", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-status-processing" },
      });

      vi.useFakeTimers();

      const inFlightJobPromise = processNextScanJob();

      const statusDuringProcessing = await app.inject({
        method: "GET",
        url: "/api/v1/scans/queue/status",
      });

      expect(statusDuringProcessing.statusCode).toBe(200);
      expect(statusDuringProcessing.json().processing).toBe(true);

      await vi.advanceTimersByTimeAsync(40);
      await inFlightJobPromise;

      const statusAfterProcessing = await app.inject({
        method: "GET",
        url: "/api/v1/scans/queue/status",
      });

      expect(statusAfterProcessing.statusCode).toBe(200);
      expect(statusAfterProcessing.json().processing).toBe(false);
    });

    it("POST /api/v1/scans/queue/process-next는 큐가 비어 있으면 processed=false, busy=false를 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans/queue/process-next",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ processed: false, busy: false });
    });

    it("POST /api/v1/scans/queue/process-next는 처리 중이면 busy=true를 반환해야 한다", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo-process-next-busy" },
      });

      vi.useFakeTimers();

      const inFlightJobPromise = processNextScanJob();

      const secondProcessResponse = await app.inject({
        method: "POST",
        url: "/api/v1/scans/queue/process-next",
      });

      expect(secondProcessResponse.statusCode).toBe(200);
      expect(secondProcessResponse.json()).toEqual({ processed: false, busy: true });

      await vi.advanceTimersByTimeAsync(40);
      await inFlightJobPromise;
    });

    it("POST /api/v1/scans/queue/process-next는 큐에 작업이 있으면 즉시 1건 처리해야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-process-next" },
      });

      const { scanId } = createRes.json();

      const processRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans/queue/process-next",
      });

      expect(processRes.statusCode).toBe(200);
      expect(processRes.json()).toEqual({ processed: true, busy: false });

      const scanRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
      });

      expect(scanRes.statusCode).toBe(200);
      expect(scanRes.json().status).toBe("completed");
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
      expect(scanRes.json().lastErrorCode).toBeUndefined();
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
      expect(redriveRes.json().code).toBe("DEAD_LETTER_NOT_FOUND");
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
      expect(redriveRes.json().code).toBe("DEAD_LETTER_ORPHANED_SCAN");
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

  describe("Tenant auth mode (required)", () => {
    beforeEach(() => {
      process.env.TENANT_AUTH_MODE = "required";
    });

    it("x-user-id 헤더가 없으면 401을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: {
          "x-user-role": "admin",
        },
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-auth-missing-user" },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_USER_ID_REQUIRED");
    });

    it("x-user-role 헤더가 없으면 401을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: {
          "x-user-id": "user-auth-missing-role",
        },
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-auth-missing-role" },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_USER_ROLE_REQUIRED");
    });

    it("x-user-role 값이 유효하지 않으면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: {
          "x-user-id": "user-auth-invalid-role",
          "x-user-role": "super-admin",
        },
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-auth-invalid-role" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("TENANT_AUTH_INVALID_USER_ROLE");
    });

    it("AUTH_MODE가 잘못된 값이어도 header 모드로 fallback 되어야 한다", async () => {
      process.env.AUTH_MODE = "invalid-mode";

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: {
          "x-user-id": "user-auth-fallback",
          "x-user-role": "admin",
        },
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-auth-fallback" },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toHaveProperty("scanId");
    });

    it("x-tenant-id가 없으면 default tenant로 처리해야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: {
          "x-user-id": "user-default-tenant",
          "x-user-role": "member",
        },
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-default-tenant" },
      });

      expect(createRes.statusCode).toBe(202);
      const { scanId } = createRes.json();

      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
        headers: {
          "x-user-id": "user-default-tenant",
          "x-user-role": "member",
        },
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().tenantId).toBe("default");
    });
  });

  describe("Tenant auth mode (jwt)", () => {
    const jwksUrl = "https://issuer.example.com/.well-known/jwks.json";
    let signingKey!: CryptoKey;
    let invalidSigningKey!: CryptoKey;
    let originalFetch: typeof global.fetch;

    const jwtIssuer = "https://issuer.example.com";
    const jwtAudience = "devsecops-api";
    const jwtKid = "test-rs256-kid";

    type JwtIssueOptions = {
      claims?: Record<string, unknown>;
      issuer?: string;
      audience?: string;
      signingPrivateKey?: CryptoKey;
    };

    beforeAll(async () => {
      const validKeyPair = await generateKeyPair("RS256");
      const invalidKeyPair = await generateKeyPair("RS256");

      signingKey = validKeyPair.privateKey;
      invalidSigningKey = invalidKeyPair.privateKey;

      const publicJwk = await exportJWK(validKeyPair.publicKey);
      publicJwk.kid = jwtKid;
      publicJwk.use = "sig";
      publicJwk.alg = "RS256";

      originalFetch = global.fetch;
      global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (requestUrl === jwksUrl) {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        }

        return originalFetch(input as RequestInfo, init);
      }) as typeof fetch;
    });

    afterAll(async () => {
      global.fetch = originalFetch;
    });

    beforeEach(() => {
      process.env.TENANT_AUTH_MODE = "required";
      process.env.AUTH_MODE = "jwt";
      process.env.JWT_ISSUER = jwtIssuer;
      process.env.JWT_AUDIENCE = jwtAudience;
      process.env.JWT_JWKS_URL = jwksUrl;
    });

    async function issueToken(options: JwtIssueOptions = {}): Promise<string> {
      const signer = options.signingPrivateKey ?? signingKey;

      return new SignJWT(options.claims ?? {})
        .setProtectedHeader({
          alg: "RS256",
          typ: "JWT",
          kid: jwtKid,
        })
        .setIssuedAt()
        .setExpirationTime("10m")
        .setIssuer(options.issuer ?? jwtIssuer)
        .setAudience(options.audience ?? jwtAudience)
        .sign(signer);
    }

    it("Authorization 헤더가 없으면 401을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_BEARER_TOKEN_REQUIRED");
    });

    it("Authorization 헤더가 Bearer 형식이 아니면 401을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: "Basic abc123",
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_INVALID_AUTHORIZATION_HEADER");
    });

    it("Bearer 토큰이 JWT 형식이 아니면 401을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: "Bearer invalid-token-format",
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_INVALID_BEARER_TOKEN");
    });

    it("JWT 구성값이 누락되면 503을 반환해야 한다", async () => {
      delete process.env.JWT_JWKS_URL;

      const token = await issueToken({
        claims: {
          sub: "jwt-user-config-missing",
          tenant_id: "tenant-jwt-config-missing",
          role: "admin",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("TENANT_AUTH_JWT_CONFIG_INCOMPLETE");
    });

    it("JWT_JWKS_URL 형식이 잘못되면 503을 반환해야 한다", async () => {
      process.env.JWT_JWKS_URL = "ftp://issuer.example.com/jwks.json";

      const token = await issueToken({
        claims: {
          sub: "jwt-user-config-invalid",
          tenant_id: "tenant-jwt-config-invalid",
          role: "admin",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("TENANT_AUTH_JWT_CONFIG_INVALID");
    });

    it("유효한 JWT면 JWKS 서명 검증 후 요청이 통과해야 한다", async () => {
      const token = await issueToken({
        claims: {
          sub: "jwt-user-valid",
          tenant_id: "tenant-jwt-valid",
          role: "admin",
        },
      });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-jwt-valid" },
      });

      expect(createRes.statusCode).toBe(202);
      const scanId = createRes.json().scanId as string;

      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().tenantId).toBe("tenant-jwt-valid");
    });

    it("tenant_id가 없으면 tid, sub가 없으면 user_id, role이 없으면 roles[0]를 사용해야 한다", async () => {
      const token = await issueToken({
        claims: {
          user_id: "jwt-user-fallback",
          tid: "tenant-jwt-fallback",
          roles: ["member"],
        },
      });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo-jwt-fallback" },
      });

      expect(createRes.statusCode).toBe(202);
      const scanId = createRes.json().scanId as string;

      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().tenantId).toBe("tenant-jwt-fallback");
    });

    it("서명이 유효하지 않으면 401을 반환해야 한다", async () => {
      const token = await issueToken({
        signingPrivateKey: invalidSigningKey,
        claims: {
          sub: "jwt-user-invalid-signature",
          tenant_id: "tenant-jwt-invalid-signature",
          role: "admin",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_INVALID_BEARER_TOKEN_SIGNATURE");
    });

    it("issuer가 다르면 401을 반환해야 한다", async () => {
      const token = await issueToken({
        issuer: "https://another-issuer.example.com",
        claims: {
          sub: "jwt-user-issuer-mismatch",
          tenant_id: "tenant-jwt-issuer-mismatch",
          role: "admin",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_JWT_ISSUER_MISMATCH");
    });

    it("audience가 다르면 401을 반환해야 한다", async () => {
      const token = await issueToken({
        audience: "other-audience",
        claims: {
          sub: "jwt-user-audience-mismatch",
          tenant_id: "tenant-jwt-audience-mismatch",
          role: "admin",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_JWT_AUDIENCE_MISMATCH");
    });

    it("tenant_id/tid가 모두 없으면 401을 반환해야 한다", async () => {
      const token = await issueToken({
        claims: {
          sub: "jwt-user-missing-tenant",
          role: "admin",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_TENANT_ID_CLAIM_REQUIRED");
    });

    it("sub/user_id가 모두 없으면 401을 반환해야 한다", async () => {
      const token = await issueToken({
        claims: {
          tenant_id: "tenant-jwt-missing-user",
          role: "admin",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_USER_ID_CLAIM_REQUIRED");
    });

    it("role/roles[0]가 모두 없으면 401을 반환해야 한다", async () => {
      const token = await issueToken({
        claims: {
          sub: "jwt-user-missing-role",
          tenant_id: "tenant-jwt-missing-role",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_USER_ROLE_CLAIM_REQUIRED");
    });

    it("JWT role이 허용되지 않은 값이면 401을 반환해야 한다", async () => {
      const token = await issueToken({
        claims: {
          sub: "jwt-user-invalid-role",
          tenant_id: "tenant-jwt-invalid-role",
          role: "super-admin",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("TENANT_AUTH_INVALID_USER_ROLE_CLAIM");
    });
  });

  describe("Tenant isolation (required auth mode)", () => {
    beforeEach(() => {
      process.env.TENANT_AUTH_MODE = "required";
    });

    it("다른 tenant의 스캔은 목록/단건 조회에서 보이지 않아야 한다", async () => {
      const tenantAHeaders = buildTenantHeaders({
        tenantId: "tenant-a",
        userId: "user-tenant-a",
        role: "member",
      });
      const tenantBHeaders = buildTenantHeaders({
        tenantId: "tenant-b",
        userId: "user-tenant-b",
        role: "member",
      });

      const createResA = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: tenantAHeaders,
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-tenant-a" },
      });
      const createResB = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: tenantBHeaders,
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo-tenant-b" },
      });

      const scanIdA = createResA.json().scanId as string;
      const scanIdB = createResB.json().scanId as string;

      const listResA = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
        headers: tenantAHeaders,
      });

      expect(listResA.statusCode).toBe(200);
      expect(listResA.json()).toHaveLength(1);
      expect(listResA.json()[0]?.id).toBe(scanIdA);
      expect(listResA.json()[0]?.tenantId).toBe("tenant-a");

      const getForeignRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanIdB}`,
        headers: tenantAHeaders,
      });

      expect(getForeignRes.statusCode).toBe(404);
      expect(getForeignRes.json().code).toBe("SCAN_NOT_FOUND");

      const getOwnRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanIdA}`,
        headers: tenantAHeaders,
      });

      expect(getOwnRes.statusCode).toBe(200);
      expect(getOwnRes.json().id).toBe(scanIdA);
    });
  });

  describe("Queue/Dead-letter authorization + tenant filter (required auth mode)", () => {
    beforeEach(() => {
      process.env.TENANT_AUTH_MODE = "required";
    });

    it("member 권한은 queue/dead-letter admin API에 접근할 수 없어야 한다", async () => {
      const adminHeaders = buildTenantHeaders({
        tenantId: "tenant-rbac-a",
        userId: "admin-rbac-a",
        role: "admin",
      });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: adminHeaders,
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-rbac-member-deny" },
      });
      const scanId = createRes.json().scanId as string;
      await moveScanToDeadLetter(scanId);

      const memberHeaders = buildTenantHeaders({
        tenantId: "tenant-rbac-a",
        userId: "member-rbac-a",
        role: "member",
      });

      const queueStatusRes = await app.inject({
        method: "GET",
        url: "/api/v1/scans/queue/status",
        headers: memberHeaders,
      });
      expect(queueStatusRes.statusCode).toBe(403);
      expect(queueStatusRes.json().code).toBe("TENANT_FORBIDDEN");

      const processNextRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans/queue/process-next",
        headers: memberHeaders,
      });
      expect(processNextRes.statusCode).toBe(403);
      expect(processNextRes.json().code).toBe("TENANT_FORBIDDEN");

      const deadLettersRes = await app.inject({
        method: "GET",
        url: "/api/v1/scans/dead-letters",
        headers: memberHeaders,
      });
      expect(deadLettersRes.statusCode).toBe(403);
      expect(deadLettersRes.json().code).toBe("TENANT_FORBIDDEN");

      const redriveRes = await app.inject({
        method: "POST",
        url: `/api/v1/scans/${scanId}/redrive`,
        headers: memberHeaders,
      });
      expect(redriveRes.statusCode).toBe(403);
      expect(redriveRes.json().code).toBe("TENANT_FORBIDDEN");
    });

    it("admin 권한에서는 queue/dead-letter가 tenant별로 분리되어 보여야 한다", async () => {
      const tenantAHeaders = buildTenantHeaders({
        tenantId: "tenant-admin-a",
        userId: "admin-a",
        role: "admin",
      });
      const tenantBHeaders = buildTenantHeaders({
        tenantId: "tenant-admin-b",
        userId: "admin-b",
        role: "admin",
      });

      const createResA = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: tenantAHeaders,
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-admin-a" },
      });
      const createResB = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: tenantBHeaders,
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo-admin-b" },
      });

      const scanIdA = createResA.json().scanId as string;
      const scanIdB = createResB.json().scanId as string;

      await moveScanToDeadLetter(scanIdA);
      await moveScanToDeadLetter(scanIdB);

      const statusResA = await app.inject({
        method: "GET",
        url: "/api/v1/scans/queue/status",
        headers: tenantAHeaders,
      });

      expect(statusResA.statusCode).toBe(200);
      expect(statusResA.json().deadLetters).toBe(1);

      const deadLettersResA = await app.inject({
        method: "GET",
        url: "/api/v1/scans/dead-letters",
        headers: tenantAHeaders,
      });

      expect(deadLettersResA.statusCode).toBe(200);
      expect(deadLettersResA.json()).toHaveLength(1);
      expect(deadLettersResA.json()[0]?.scanId).toBe(scanIdA);

      const crossTenantRedriveRes = await app.inject({
        method: "POST",
        url: `/api/v1/scans/${scanIdB}/redrive`,
        headers: tenantAHeaders,
      });
      expect(crossTenantRedriveRes.statusCode).toBe(404);
      expect(crossTenantRedriveRes.json().code).toBe("DEAD_LETTER_NOT_FOUND");

      const ownRedriveRes = await app.inject({
        method: "POST",
        url: `/api/v1/scans/${scanIdA}/redrive`,
        headers: tenantAHeaders,
      });
      expect(ownRedriveRes.statusCode).toBe(202);

      const deadLettersAfterRedrive = await app.inject({
        method: "GET",
        url: "/api/v1/scans/dead-letters",
        headers: tenantAHeaders,
      });
      expect(deadLettersAfterRedrive.statusCode).toBe(200);
      expect(deadLettersAfterRedrive.json()).toHaveLength(0);
    });

    it("admin 수동 처리(process-next)는 요청 tenant의 대기 작업만 1건 처리해야 한다", async () => {
      const tenantAHeaders = buildTenantHeaders({
        tenantId: "tenant-manual-a",
        userId: "admin-manual-a",
        role: "admin",
      });
      const tenantBHeaders = buildTenantHeaders({
        tenantId: "tenant-manual-b",
        userId: "admin-manual-b",
        role: "admin",
      });

      // 의도적으로 B를 먼저 enqueue해도, A 요청에서는 A 작업만 처리되어야 한다.
      const createResB = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: tenantBHeaders,
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo-manual-b" },
      });
      const createResA = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: tenantAHeaders,
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-manual-a" },
      });

      const scanIdB = createResB.json().scanId as string;
      const scanIdA = createResA.json().scanId as string;

      const processResA = await app.inject({
        method: "POST",
        url: "/api/v1/scans/queue/process-next",
        headers: tenantAHeaders,
      });
      expect(processResA.statusCode).toBe(200);
      expect(processResA.json()).toEqual({ processed: true, busy: false });

      const getResA = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanIdA}`,
        headers: tenantAHeaders,
      });
      expect(getResA.statusCode).toBe(200);
      expect(getResA.json().status).toBe("completed");

      const getResB = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanIdB}`,
        headers: tenantBHeaders,
      });
      expect(getResB.statusCode).toBe(200);
      expect(getResB.json().status).toBe("queued");
    });

    it("다른 tenant 작업이 처리 중이면 process-next는 busy=false로 노출을 마스킹해야 한다", async () => {
      const tenantAHeaders = buildTenantHeaders({
        tenantId: "tenant-busy-mask-a",
        userId: "admin-busy-mask-a",
        role: "admin",
      });
      const tenantBHeaders = buildTenantHeaders({
        tenantId: "tenant-busy-mask-b",
        userId: "admin-busy-mask-b",
        role: "admin",
      });

      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: tenantBHeaders,
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo-busy-mask-b" },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: tenantAHeaders,
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-busy-mask-a" },
      });

      vi.useFakeTimers();
      const inFlightTenantB = processNextScanJob({ tenantId: "tenant-busy-mask-b" });

      const processResA = await app.inject({
        method: "POST",
        url: "/api/v1/scans/queue/process-next",
        headers: tenantAHeaders,
      });

      expect(processResA.statusCode).toBe(200);
      expect(processResA.json()).toEqual({ processed: false, busy: false });

      await vi.advanceTimersByTimeAsync(40);
      await inFlightTenantB;
    });

    it("같은 tenant 작업이 처리 중이면 process-next는 busy=true를 반환해야 한다", async () => {
      const tenantAHeaders = buildTenantHeaders({
        tenantId: "tenant-busy-same-a",
        userId: "admin-busy-same-a",
        role: "admin",
      });

      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        headers: tenantAHeaders,
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-busy-same-a" },
      });

      vi.useFakeTimers();
      const inFlightTenantA = processNextScanJob({ tenantId: "tenant-busy-same-a" });

      const processResA = await app.inject({
        method: "POST",
        url: "/api/v1/scans/queue/process-next",
        headers: tenantAHeaders,
      });

      expect(processResA.statusCode).toBe(200);
      expect(processResA.json()).toEqual({ processed: false, busy: true });

      await vi.advanceTimersByTimeAsync(40);
      await inFlightTenantA;
    });
  });
});
