import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveDataBackend,
  getConfiguredDataBackend,
  initializeDataBackend,
  parseDataBackend,
  persistQueueState,
  resetDataBackendForTests,
} from "../src/storage/backend.js";

const ORIGINAL_DATA_BACKEND = process.env.DATA_BACKEND;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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
    end,
  };
}

afterEach(async () => {
  restoreEnv("DATA_BACKEND", ORIGINAL_DATA_BACKEND);
  restoreEnv("DATABASE_URL", ORIGINAL_DATABASE_URL);
  await resetDataBackendForTests();
});

describe("data backend config", () => {
  it("DATA_BACKEND 미설정/알 수 없는 값은 memory로 fallback 해야 한다", () => {
    delete process.env.DATA_BACKEND;
    expect(getConfiguredDataBackend()).toBe("memory");

    process.env.DATA_BACKEND = "unknown";
    expect(getConfiguredDataBackend()).toBe("memory");
  });

  it("parseDataBackend는 postgres를 대소문자/공백 무시하고 인식해야 한다", () => {
    expect(parseDataBackend(" postgres ")).toBe("postgres");
    expect(parseDataBackend("POSTGRES")).toBe("postgres");
    expect(parseDataBackend("memory")).toBe("memory");
  });

  it("DATA_BACKEND=postgres + DATABASE_URL 누락 시 memory로 안전 fallback 해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    delete process.env.DATABASE_URL;

    const result = await initializeDataBackend({ logger: silentLogger });

    expect(result.configuredBackend).toBe("postgres");
    expect(result.activeBackend).toBe("memory");
    expect(result.reason).toBe("missing_database_url");
    expect(result.persistedState.scans).toEqual([]);
    expect(result.persistedState.queue).toEqual({
      queuedScanIds: [],
      deadLetters: [],
      pendingRetries: [],
    });
    expect(getActiveDataBackend()).toBe("memory");
  });

  it("postgres 초기화 실패 시 memory로 fallback 해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://invalid-host/devsecops";

    const result = await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => ({
        query: async () => {
          throw new Error("bootstrap failure");
        },
        end: async () => undefined,
      }),
    });

    expect(result.configuredBackend).toBe("postgres");
    expect(result.activeBackend).toBe("memory");
    expect(result.reason).toBe("connection_failed");
    expect(getActiveDataBackend()).toBe("memory");
  });

  it("schema migration은 순서대로 한 번만 적용되어야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";

    const appliedVersions = new Set<string>();
    const mock = createMockSqlClient((sql, values) => {
      if (sql.includes("SELECT version") && sql.includes("FROM schema_migrations")) {
        return Array.from(appliedVersions)
          .sort()
          .map((version) => ({ version, applied_at: "2026-03-01T00:00:00.000Z" }));
      }

      if (sql.includes("INSERT INTO schema_migrations")) {
        appliedVersions.add(String(values?.[0]));
      }

      return [];
    });

    const createSqlClient = () => mock.client;

    await initializeDataBackend({
      logger: silentLogger,
      createSqlClient,
    });

    await resetDataBackendForTests();

    await initializeDataBackend({
      logger: silentLogger,
      createSqlClient,
    });

    const insertedMigrationVersions = mock.query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO schema_migrations"))
      .map(([, values]) => String(values?.[0]));

    expect(insertedMigrationVersions).toEqual([
      "001_scans",
      "002_tenants",
      "003_scan_queue",
      "004_scan_retry_schedule",
    ]);

    const scansTableCreateStatements = mock.query.mock.calls.filter(([sql]) =>
      String(sql).includes("CREATE TABLE IF NOT EXISTS scans")
    );
    expect(scansTableCreateStatements).toHaveLength(1);
  });

  it("startup 시 running 상태로 멈춘 scan을 queued로 복구하고 queue에 재적재해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";

    const queueRows: Array<{ scan_id: string; position: number }> = [];

    const mock = createMockSqlClient((sql, values) => {
      if (sql.includes("UPDATE scans") && sql.includes("WHERE status = 'running'")) {
        return [{ id: "scan-running-1" }];
      }

      if (sql.includes("INSERT INTO scan_queue_jobs")) {
        const scanId = String(values?.[0] ?? "");
        queueRows.push({ scan_id: scanId, position: queueRows.length + 1 });
        return [];
      }

      if (sql.includes("FROM scan_queue_jobs")) {
        return queueRows;
      }

      if (sql.includes("FROM scans")) {
        return [
          {
            id: "scan-running-1",
            tenant_id: "tenant-a",
            engine: "semgrep",
            repo_url: "https://github.com/test/repo-running-recovery",
            branch: "main",
            status: "queued",
            created_at: "2026-03-01T00:00:00.000Z",
            completed_at: null,
            retry_count: 1,
            last_error: null,
            last_error_code: null,
            findings: null,
          },
        ];
      }

      return [];
    });

    const result = await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    expect(result.activeBackend).toBe("postgres");
    expect(result.persistedState.scans).toHaveLength(1);
    expect(result.persistedState.scans[0]?.status).toBe("queued");
    expect(result.persistedState.scans[0]?.tenantId).toBe("tenant-a");
    expect(result.persistedState.queue.queuedScanIds).toEqual(["scan-running-1"]);
    expect(result.persistedState.queue.pendingRetries).toEqual([]);

    const hasRecoveryUpdateQuery = mock.query.mock.calls.some(([sql]) => {
      const statement = String(sql);
      return statement.includes("UPDATE scans") && statement.includes("WHERE status = 'running'");
    });

    expect(hasRecoveryUpdateQuery).toBe(true);
  });

  it("postgres 초기화 시 queue/dead-letter/retry 상태를 hydrate 해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";

    const mock = createMockSqlClient((sql) => {
      if (sql.includes("FROM scan_queue_jobs")) {
        return [
          { scan_id: "scan-queued-1", position: 1 },
          { scan_id: "scan-queued-2", position: 2 },
        ];
      }

      if (sql.includes("FROM scan_dead_letters")) {
        return [
          {
            id: 1,
            scan_id: "scan-dead-1",
            retry_count: 2,
            error: "스캔 실행에 실패했습니다",
            code: "SCAN_EXECUTION_FAILED",
            failed_at: "2026-03-01T00:00:00.000Z",
          },
        ];
      }

      if (sql.includes("FROM scan_retry_schedules")) {
        return [
          {
            scan_id: "scan-retry-1",
            due_at: "2026-03-01T00:00:30.000Z",
          },
        ];
      }

      return [];
    });

    const result = await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    expect(result.activeBackend).toBe("postgres");
    expect(result.persistedState.queue).toEqual({
      queuedScanIds: ["scan-queued-1", "scan-queued-2"],
      deadLetters: [
        {
          scanId: "scan-dead-1",
          retryCount: 2,
          error: "스캔 실행에 실패했습니다",
          code: "SCAN_EXECUTION_FAILED",
          failedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      pendingRetries: [
        {
          scanId: "scan-retry-1",
          dueAt: "2026-03-01T00:00:30.000Z",
        },
      ],
    });
  });

  it("persistQueueState는 postgres 모드에서 queue/dead-letter/retry 스냅샷을 저장해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";

    const mock = createMockSqlClient();

    await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    persistQueueState({
      queuedScanIds: ["scan-a", "scan-b"],
      deadLetters: [
        {
          scanId: "scan-failed-a",
          retryCount: 2,
          error: "스캔 실행에 실패했습니다",
          code: "SCAN_EXECUTION_FAILED",
          failedAt: "2026-03-01T00:10:00.000Z",
        },
      ],
      pendingRetries: [
        {
          scanId: "scan-retry-a",
          dueAt: "2026-03-01T00:20:00.000Z",
        },
      ],
    });

    await resetDataBackendForTests();

    const statements = mock.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("DELETE FROM scan_queue_jobs"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM scan_dead_letters"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM scan_retry_schedules"))).toBe(
      true
    );

    const queueInsertValues = mock.query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO scan_queue_jobs"))
      .map(([, values]) => values);
    expect(queueInsertValues).toEqual([["scan-a"], ["scan-b"]]);

    const deadLetterInsertValues = mock.query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO scan_dead_letters"))
      .map(([, values]) => values);
    expect(deadLetterInsertValues).toEqual([
      [
        "scan-failed-a",
        2,
        "스캔 실행에 실패했습니다",
        "SCAN_EXECUTION_FAILED",
        "2026-03-01T00:10:00.000Z",
      ],
    ]);

    const retryInsertValues = mock.query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO scan_retry_schedules"))
      .map(([, values]) => values);
    expect(retryInsertValues).toEqual([["scan-retry-a", "2026-03-01T00:20:00.000Z"]]);
  });
});
