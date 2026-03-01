import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQueue,
  getQueueStatusForTenantReadPath,
  hydrateQueueState,
  listDeadLettersForTenantReadPath,
} from "../src/scanner/queue.js";
import { hydrateScanStore } from "../src/scanner/store.js";
import {
  initializeDataBackend,
  resetDataBackendForTests,
} from "../src/storage/backend.js";

const ORIGINAL_DATA_BACKEND = process.env.DATA_BACKEND;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_TENANT_RLS_MODE = process.env.TENANT_RLS_MODE;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function createQueryResult<T extends Record<string, unknown>>(rows: T[]) {
  return {
    rows,
  } as never;
}

function createMockSqlClient(
  resolver?: (sql: string, values?: unknown[]) => Record<string, unknown>[]
) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const rows = resolver?.(sql, values) ?? [];
    return createQueryResult(rows);
  });

  const end = vi.fn(async () => undefined);

  return {
    client: {
      query,
      end,
    },
    query,
  };
}

beforeEach(() => {
  delete process.env.DATA_BACKEND;
  delete process.env.DATABASE_URL;
  delete process.env.TENANT_RLS_MODE;

  clearQueue();
  hydrateScanStore([]);
});

afterEach(async () => {
  restoreEnv("DATA_BACKEND", ORIGINAL_DATA_BACKEND);
  restoreEnv("DATABASE_URL", ORIGINAL_DATABASE_URL);
  restoreEnv("TENANT_RLS_MODE", ORIGINAL_TENANT_RLS_MODE);

  clearQueue();
  hydrateScanStore([]);
  await resetDataBackendForTests();
});

describe("queue read path selection", () => {
  it("DATA_BACKEND=postgres면 queue status/dead-letter read는 tenant-scoped DB direct query를 우선 사용해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";
    process.env.TENANT_RLS_MODE = "shadow";

    const mock = createMockSqlClient((sql, values) => {
      if (
        sql.includes("FROM scan_queue_jobs AS queue_jobs") &&
        sql.includes("WHERE scans.tenant_id = $1")
      ) {
        return [{ count: String(values?.[0] === "tenant-a" ? 3 : 0) }];
      }

      if (
        sql.includes("FROM scan_dead_letters AS dead_letters") &&
        sql.includes("COUNT(*)") &&
        sql.includes("WHERE scans.tenant_id = $1")
      ) {
        return [{ count: String(values?.[0] === "tenant-a" ? 2 : 0) }];
      }

      if (
        sql.includes("FROM scan_retry_schedules AS retry_schedules") &&
        sql.includes("WHERE scans.tenant_id = $1")
      ) {
        return [{ count: String(values?.[0] === "tenant-a" ? 1 : 0) }];
      }

      if (
        sql.includes("FROM scan_dead_letters AS dead_letters") &&
        !sql.includes("COUNT(*)") &&
        sql.includes("WHERE scans.tenant_id = $1")
      ) {
        if (values?.[0] !== "tenant-a") {
          return [];
        }

        return [
          {
            id: 101,
            scan_id: "db-dead-1",
            retry_count: 2,
            error: "db-direct dead-letter",
            code: "SCAN_EXECUTION_FAILED",
            failed_at: "2026-03-01T00:00:00.000Z",
          },
        ];
      }

      return [];
    });

    await initializeDataBackend({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      createSqlClient: () => mock.client,
    });

    // 인메모리 상태는 의도적으로 DB 결과와 다르게 구성해 우선순위를 검증한다.
    hydrateQueueState({
      queuedScanIds: ["memory-queue-1"],
      deadLetters: [
        {
          scanId: "memory-dead-1",
          retryCount: 9,
          error: "memory-only",
          code: "SCAN_EXECUTION_FAILED",
          failedAt: "2026-03-01T01:00:00.000Z",
        },
      ],
      pendingRetries: [
        {
          scanId: "memory-retry-1",
          dueAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

    const tenantAStatus = await getQueueStatusForTenantReadPath({
      tenantId: "tenant-a",
      userId: "reader-a",
      userRole: "admin",
    });

    expect(tenantAStatus).toEqual({
      queuedJobs: 3,
      deadLetters: 2,
      pendingRetryTimers: 1,
      workerRunning: false,
      processing: false,
    });

    const tenantADeadLetters = await listDeadLettersForTenantReadPath({
      tenantId: "tenant-a",
      userId: "reader-a",
      userRole: "admin",
    });

    expect(tenantADeadLetters).toEqual([
      {
        scanId: "db-dead-1",
        retryCount: 2,
        error: "db-direct dead-letter",
        code: "SCAN_EXECUTION_FAILED",
        failedAt: "2026-03-01T00:00:00.000Z",
      },
    ]);

    const tenantMismatchStatus = await getQueueStatusForTenantReadPath({
      tenantId: "tenant-b",
      userId: "reader-b",
      userRole: "admin",
    });

    expect(tenantMismatchStatus.queuedJobs).toBe(0);
    expect(tenantMismatchStatus.deadLetters).toBe(0);
    expect(tenantMismatchStatus.pendingRetryTimers).toBe(0);

    const tenantMismatchDeadLetters = await listDeadLettersForTenantReadPath({
      tenantId: "tenant-b",
      userId: "reader-b",
      userRole: "admin",
    });

    expect(tenantMismatchDeadLetters).toEqual([]);

    const statusQuery = mock.query.mock.calls.find(
      ([sql]) =>
        String(sql).includes("FROM scan_queue_jobs AS queue_jobs") &&
        String(sql).includes("WHERE scans.tenant_id = $1")
    );
    expect(statusQuery).toBeDefined();

    const deadLetterQuery = mock.query.mock.calls.find(
      ([sql]) =>
        String(sql).includes("FROM scan_dead_letters AS dead_letters") &&
        String(sql).includes("WHERE scans.tenant_id = $1")
    );
    expect(deadLetterQuery).toBeDefined();
  });

  it("memory 백엔드에서는 queue status/dead-letter의 기존 인메모리 read path를 유지해야 한다", async () => {
    process.env.DATA_BACKEND = "memory";

    await initializeDataBackend({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    hydrateScanStore([
      {
        id: "scan-memory-a",
        tenantId: "tenant-memory-a",
        engine: "semgrep",
        repoUrl: "https://github.com/test/memory-a",
        branch: "main",
        status: "queued",
        createdAt: "2026-03-01T00:00:00.000Z",
        retryCount: 0,
      },
      {
        id: "scan-memory-b",
        tenantId: "tenant-memory-b",
        engine: "trivy",
        repoUrl: "https://github.com/test/memory-b",
        branch: "main",
        status: "queued",
        createdAt: "2026-03-01T00:01:00.000Z",
        retryCount: 0,
      },
      {
        id: "scan-memory-retry-a",
        tenantId: "tenant-memory-a",
        engine: "gitleaks",
        repoUrl: "https://github.com/test/memory-retry-a",
        branch: "main",
        status: "queued",
        createdAt: "2026-03-01T00:02:00.000Z",
        retryCount: 1,
      },
      {
        id: "scan-memory-retry-b",
        tenantId: "tenant-memory-b",
        engine: "gitleaks",
        repoUrl: "https://github.com/test/memory-retry-b",
        branch: "main",
        status: "queued",
        createdAt: "2026-03-01T00:03:00.000Z",
        retryCount: 1,
      },
    ]);

    hydrateQueueState({
      queuedScanIds: ["scan-memory-a", "scan-memory-b"],
      deadLetters: [
        {
          scanId: "scan-memory-a",
          retryCount: 2,
          error: "memory dead-letter A",
          code: "SCAN_EXECUTION_FAILED",
          failedAt: "2026-03-01T00:10:00.000Z",
        },
        {
          scanId: "scan-memory-b",
          retryCount: 2,
          error: "memory dead-letter B",
          code: "SCAN_EXECUTION_FAILED",
          failedAt: "2026-03-01T00:11:00.000Z",
        },
      ],
      pendingRetries: [
        {
          scanId: "scan-memory-retry-a",
          dueAt: "2099-01-01T00:00:00.000Z",
        },
        {
          scanId: "scan-memory-retry-b",
          dueAt: "2099-01-01T00:01:00.000Z",
        },
      ],
    });

    const status = await getQueueStatusForTenantReadPath({
      tenantId: "tenant-memory-a",
      userId: "reader-memory-a",
      userRole: "admin",
    });

    expect(status).toEqual({
      queuedJobs: 1,
      deadLetters: 1,
      pendingRetryTimers: 1,
      workerRunning: false,
      processing: false,
    });

    const deadLetters = await listDeadLettersForTenantReadPath({
      tenantId: "tenant-memory-a",
      userId: "reader-memory-a",
      userRole: "admin",
    });

    expect(deadLetters).toEqual([
      {
        scanId: "scan-memory-a",
        retryCount: 2,
        error: "memory dead-letter A",
        code: "SCAN_EXECUTION_FAILED",
        failedAt: "2026-03-01T00:10:00.000Z",
      },
    ]);
  });
});
