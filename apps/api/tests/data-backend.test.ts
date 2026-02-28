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

  it("postgres 초기화 시 queue/dead-letter 상태를 hydrate 해야 한다", async () => {
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
    });
  });

  it("persistQueueState는 postgres 모드에서 queue/dead-letter 스냅샷을 저장해야 한다", async () => {
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
    });

    await resetDataBackendForTests();

    const statements = mock.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("DELETE FROM scan_queue_jobs"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM scan_dead_letters"))).toBe(true);

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
  });
});
