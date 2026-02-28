import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getScanForTenantReadPath,
  hydrateScanStore,
  listScansForTenantReadPath,
} from "../src/scanner/store.js";
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
  hydrateScanStore([]);
});

afterEach(async () => {
  restoreEnv("DATA_BACKEND", ORIGINAL_DATA_BACKEND);
  restoreEnv("DATABASE_URL", ORIGINAL_DATABASE_URL);
  restoreEnv("TENANT_RLS_MODE", ORIGINAL_TENANT_RLS_MODE);
  hydrateScanStore([]);
  await resetDataBackendForTests();
});

describe("scan read path selection", () => {
  it("DATA_BACKEND=postgres면 tenant-scoped DB direct query를 우선 사용해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";
    process.env.TENANT_RLS_MODE = "shadow";

    const mock = createMockSqlClient((sql, values) => {
      if (sql.includes("FROM scans") && sql.includes("WHERE tenant_id = $1")) {
        return [
          {
            id: "db-scan-list-1",
            tenant_id: String(values?.[0] ?? "tenant-a"),
            engine: "semgrep",
            repo_url: "https://github.com/test/repo-db-list",
            branch: "main",
            status: "queued",
            created_at: "2026-03-01T00:00:00.000Z",
            completed_at: null,
            retry_count: 0,
            last_error: null,
            last_error_code: null,
            findings: null,
          },
        ];
      }

      if (sql.includes("WHERE id = $1 AND tenant_id = $2")) {
        return [
          {
            id: String(values?.[0] ?? "db-scan-get-1"),
            tenant_id: String(values?.[1] ?? "tenant-a"),
            engine: "trivy",
            repo_url: "https://github.com/test/repo-db-get",
            branch: "release",
            status: "completed",
            created_at: "2026-03-01T01:00:00.000Z",
            completed_at: "2026-03-01T01:10:00.000Z",
            retry_count: 0,
            last_error: null,
            last_error_code: null,
            findings: null,
          },
        ];
      }

      return [];
    });

    await initializeDataBackend({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      createSqlClient: () => mock.client,
    });

    hydrateScanStore([
      {
        id: "memory-scan-1",
        tenantId: "tenant-a",
        engine: "gitleaks",
        repoUrl: "https://github.com/test/repo-memory",
        branch: "main",
        status: "queued",
        createdAt: "2026-03-01T00:00:00.000Z",
        retryCount: 0,
      },
    ]);

    const scans = await listScansForTenantReadPath({
      tenantId: "tenant-a",
      status: "queued",
      userId: "user-a",
      userRole: "member",
    });

    expect(scans).toHaveLength(1);
    expect(scans[0]?.id).toBe("db-scan-list-1");

    const scan = await getScanForTenantReadPath({
      id: "db-scan-get-1",
      tenantId: "tenant-a",
      userId: "user-a",
      userRole: "member",
    });

    expect(scan?.id).toBe("db-scan-get-1");
    expect(scan?.branch).toBe("release");
    expect(scan?.engine).toBe("trivy");
  });

  it("memory 백엔드에서는 기존 인메모리 read path를 유지해야 한다", async () => {
    process.env.DATA_BACKEND = "memory";

    await initializeDataBackend({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    hydrateScanStore([
      {
        id: "memory-scan-2",
        tenantId: "tenant-memory",
        engine: "semgrep",
        repoUrl: "https://github.com/test/repo-memory-only",
        branch: "main",
        status: "queued",
        createdAt: "2026-03-01T00:00:00.000Z",
        retryCount: 0,
      },
    ]);

    const scans = await listScansForTenantReadPath({
      tenantId: "tenant-memory",
      status: "queued",
    });

    expect(scans).toHaveLength(1);
    expect(scans[0]?.id).toBe("memory-scan-2");

    const scan = await getScanForTenantReadPath({
      id: "memory-scan-2",
      tenantId: "tenant-memory",
    });

    expect(scan?.id).toBe("memory-scan-2");
    expect(scan?.engine).toBe("semgrep");
  });
});
