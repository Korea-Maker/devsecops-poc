import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveDataBackend,
  getActiveTenantRlsMode,
  getActiveTenantRlsRuntimeGuardMode,
  getConfiguredDataBackend,
  getConfiguredTenantRlsMode,
  getConfiguredTenantRlsRuntimeGuardMode,
  getPersistedScanForTenant,
  initializeDataBackend,
  listPersistedScansForTenant,
  parseDataBackend,
  parseTenantRlsMode,
  parseTenantRlsRuntimeGuardMode,
  persistOrganizationInviteTokenRecord,
  persistQueueState,
  resetDataBackendForTests,
} from "../src/storage/backend.js";

const ORIGINAL_DATA_BACKEND = process.env.DATA_BACKEND;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_TENANT_AUDIT_LOG_RETENTION_DAYS =
  process.env.TENANT_AUDIT_LOG_RETENTION_DAYS;
const ORIGINAL_TENANT_RLS_MODE = process.env.TENANT_RLS_MODE;
const ORIGINAL_TENANT_RLS_RUNTIME_GUARD_MODE =
  process.env.TENANT_RLS_RUNTIME_GUARD_MODE;
const ORIGINAL_TENANT_RLS_RUNTIME_GUARD_STARTUP_WARN =
  process.env.TENANT_RLS_RUNTIME_GUARD_STARTUP_WARN;

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

beforeEach(() => {
  delete process.env.TENANT_AUDIT_LOG_RETENTION_DAYS;
  delete process.env.TENANT_RLS_MODE;
  delete process.env.TENANT_RLS_RUNTIME_GUARD_MODE;
  delete process.env.TENANT_RLS_RUNTIME_GUARD_STARTUP_WARN;
});

afterEach(async () => {
  restoreEnv("DATA_BACKEND", ORIGINAL_DATA_BACKEND);
  restoreEnv("DATABASE_URL", ORIGINAL_DATABASE_URL);
  restoreEnv(
    "TENANT_AUDIT_LOG_RETENTION_DAYS",
    ORIGINAL_TENANT_AUDIT_LOG_RETENTION_DAYS
  );
  restoreEnv("TENANT_RLS_MODE", ORIGINAL_TENANT_RLS_MODE);
  restoreEnv(
    "TENANT_RLS_RUNTIME_GUARD_MODE",
    ORIGINAL_TENANT_RLS_RUNTIME_GUARD_MODE
  );
  restoreEnv(
    "TENANT_RLS_RUNTIME_GUARD_STARTUP_WARN",
    ORIGINAL_TENANT_RLS_RUNTIME_GUARD_STARTUP_WARN
  );
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

  it("TENANT_RLS_MODE는 off/shadow/enforce를 대소문자/공백 무시하고 파싱해야 한다", () => {
    expect(parseTenantRlsMode(undefined)).toBe("off");
    expect(parseTenantRlsMode(" shadow ")).toBe("shadow");
    expect(parseTenantRlsMode("ENFORCE")).toBe("enforce");
    expect(parseTenantRlsMode("unknown")).toBe("off");
  });

  it("TENANT_RLS_MODE 미설정/알 수 없는 값은 off로 fallback 해야 한다", () => {
    delete process.env.TENANT_RLS_MODE;
    expect(getConfiguredTenantRlsMode()).toBe("off");

    process.env.TENANT_RLS_MODE = "invalid-mode";
    expect(getConfiguredTenantRlsMode()).toBe("off");
  });

  it("TENANT_RLS_RUNTIME_GUARD_MODE는 off/warn/enforce를 파싱해야 한다", () => {
    expect(parseTenantRlsRuntimeGuardMode(undefined)).toBe("off");
    expect(parseTenantRlsRuntimeGuardMode(" warn ")).toBe("warn");
    expect(parseTenantRlsRuntimeGuardMode("ENFORCE")).toBe("enforce");
    expect(parseTenantRlsRuntimeGuardMode("unknown")).toBe("off");
  });

  it("TENANT_RLS_RUNTIME_GUARD_MODE 미설정/알 수 없는 값은 off로 fallback 해야 한다", () => {
    delete process.env.TENANT_RLS_RUNTIME_GUARD_MODE;
    expect(getConfiguredTenantRlsRuntimeGuardMode()).toBe("off");

    process.env.TENANT_RLS_RUNTIME_GUARD_MODE = "invalid-mode";
    expect(getConfiguredTenantRlsRuntimeGuardMode()).toBe("off");
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

  it("TENANT_RLS_MODE=enforce + runtime guard off 조합은 기본값에서 startup 경고를 내지 않아야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.TENANT_RLS_MODE = "enforce";
    process.env.TENANT_RLS_RUNTIME_GUARD_MODE = "off";
    delete process.env.TENANT_RLS_RUNTIME_GUARD_STARTUP_WARN;
    delete process.env.DATABASE_URL;

    const warn = vi.fn();

    await initializeDataBackend({
      logger: { info: () => undefined, warn, error: () => undefined },
    });

    const guardWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes("TENANT_RLS_MODE=enforce")
    );
    expect(guardWarnings).toHaveLength(0);
  });

  it("TENANT_RLS_RUNTIME_GUARD_STARTUP_WARN=true면 enforce+guard off 조합에서 startup 경고를 남겨야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.TENANT_RLS_MODE = "enforce";
    process.env.TENANT_RLS_RUNTIME_GUARD_MODE = "off";
    process.env.TENANT_RLS_RUNTIME_GUARD_STARTUP_WARN = "true";
    delete process.env.DATABASE_URL;

    const warn = vi.fn();

    await initializeDataBackend({
      logger: { info: () => undefined, warn, error: () => undefined },
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("TENANT_RLS_MODE=enforce 이지만 TENANT_RLS_RUNTIME_GUARD_MODE=off")
    );
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
      "005_tenant_org_hardening",
      "006_tenant_rls_preview",
    ]);

    const scansTableCreateStatements = mock.query.mock.calls.filter(([sql]) =>
      String(sql).includes("CREATE TABLE IF NOT EXISTS scans")
    );
    expect(scansTableCreateStatements).toHaveLength(1);
  });

  it("tenant RLS migration은 role/policy idempotency 훅 SQL을 포함해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";

    const mock = createMockSqlClient();

    await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    const sqlStatements = mock.query.mock.calls.map(([sql]) => String(sql));

    expect(
      sqlStatements.some(
        (statement) =>
          statement.includes("FROM pg_roles") &&
          statement.includes("app_tenant_runtime")
      )
    ).toBe(true);

    expect(
      sqlStatements.some(
        (statement) =>
          statement.includes("FROM pg_policies") &&
          statement.includes("scans_tenant_isolation")
      )
    ).toBe(true);
  });

  it("TENANT_RLS_MODE=enforce면 초기화 시 RLS enable/force가 적용되어야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";
    process.env.TENANT_RLS_MODE = "enforce";

    const mock = createMockSqlClient();

    const result = await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    expect(result.activeBackend).toBe("postgres");
    expect(getActiveTenantRlsMode()).toBe("enforce");

    const normalizedStatements = mock.query.mock.calls.map(([sql]) =>
      String(sql).replace(/\s+/g, " ").trim()
    );

    expect(normalizedStatements).toContain("ALTER TABLE scans ENABLE ROW LEVEL SECURITY");
    expect(normalizedStatements).toContain("ALTER TABLE scans FORCE ROW LEVEL SECURITY");
  });

  it("TENANT_RLS_MODE=shadow에서는 tenant persistence 전에 session context를 주입해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";
    process.env.TENANT_RLS_MODE = "shadow";

    const mock = createMockSqlClient();

    await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    persistOrganizationInviteTokenRecord({
      token: "shadow-token-1",
      organizationId: "org-shadow-1",
      role: "member",
      createdAt: "2026-03-01T00:00:00.000Z",
      expiresAt: "2026-03-01T01:00:00.000Z",
    });

    await resetDataBackendForTests();

    const contextCall = mock.query.mock.calls.find(
      ([sql, values]) =>
        String(sql).includes("set_config('app.tenant_id'") &&
        Array.isArray(values) &&
        values[0] === "org-shadow-1"
    );

    expect(contextCall?.[1]).toEqual(["org-shadow-1", "storage-worker", "owner"]);
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

  it("persistQueueState는 postgres 모드에서 단일 transaction으로 queue/dead-letter/retry 스냅샷을 저장해야 한다", async () => {
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

    const normalizedStatements = mock.query.mock.calls.map(([sql]) =>
      String(sql).replace(/\s+/g, " ").trim()
    );

    const beginIndex = normalizedStatements.findIndex((statement) => statement === "BEGIN");
    const commitIndex = normalizedStatements.findIndex((statement) => statement === "COMMIT");

    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(beginIndex);
    expect(normalizedStatements.includes("ROLLBACK")).toBe(false);

    const queueDeleteIndex = normalizedStatements.findIndex((statement) =>
      statement.includes("DELETE FROM scan_queue_jobs")
    );
    const deadLetterDeleteIndex = normalizedStatements.findIndex((statement) =>
      statement.includes("DELETE FROM scan_dead_letters")
    );
    const retryDeleteIndex = normalizedStatements.findIndex((statement) =>
      statement.includes("DELETE FROM scan_retry_schedules")
    );

    expect(queueDeleteIndex).toBeGreaterThan(beginIndex);
    expect(deadLetterDeleteIndex).toBeGreaterThan(beginIndex);
    expect(retryDeleteIndex).toBeGreaterThan(beginIndex);
    expect(commitIndex).toBeGreaterThan(retryDeleteIndex);

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

  it("persistQueueState는 snapshot 저장 중 오류가 나면 transaction을 rollback 해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";

    const mock = createMockSqlClient((sql) => {
      if (sql.includes("INSERT INTO scan_dead_letters")) {
        throw new Error("dead-letter write failed");
      }

      return [];
    });

    await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    persistQueueState({
      queuedScanIds: ["scan-a"],
      deadLetters: [
        {
          scanId: "scan-failed-a",
          retryCount: 1,
          error: "fail",
          code: "SCAN_EXECUTION_FAILED",
          failedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      pendingRetries: [],
    });

    await resetDataBackendForTests();

    const normalizedStatements = mock.query.mock.calls.map(([sql]) =>
      String(sql).replace(/\s+/g, " ").trim()
    );

    expect(normalizedStatements.includes("BEGIN")).toBe(true);
    expect(normalizedStatements.includes("ROLLBACK")).toBe(true);
    expect(normalizedStatements.includes("COMMIT")).toBe(false);
  });

  it("TENANT_AUDIT_LOG_RETENTION_DAYS가 설정되면 초기화 시 오래된 감사 로그를 prune 해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";
    process.env.TENANT_AUDIT_LOG_RETENTION_DAYS = "7";

    const auditRows = [
      {
        id: "audit-old",
        organization_id: "org-a",
        actor_user_id: "old-user",
        action: "membership.created",
        target_user_id: "target-old",
        details: null,
        created_at: "2026-02-01T00:00:00.000Z",
      },
      {
        id: "audit-new",
        organization_id: "org-a",
        actor_user_id: "new-user",
        action: "membership.role_updated",
        target_user_id: "target-new",
        details: null,
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ];

    const mock = createMockSqlClient((sql, values) => {
      if (sql.includes("DELETE FROM tenant_audit_logs") && Array.isArray(values)) {
        const cutoff = String(values[0] ?? "");
        for (let index = auditRows.length - 1; index >= 0; index -= 1) {
          const row = auditRows[index];
          if (row && row.created_at < cutoff) {
            auditRows.splice(index, 1);
          }
        }
        return [];
      }

      if (sql.includes("FROM tenant_audit_logs")) {
        return [...auditRows];
      }

      return [];
    });

    const result = await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    expect(result.activeBackend).toBe("postgres");
    expect(result.persistedState.tenantAuditLogs).toHaveLength(1);
    expect(result.persistedState.tenantAuditLogs[0]?.id).toBe("audit-new");

    const pruneCalls = mock.query.mock.calls.filter(([sql]) =>
      String(sql).includes("DELETE FROM tenant_audit_logs")
    );
    expect(pruneCalls).toHaveLength(1);
    expect(pruneCalls[0]?.[1]).toHaveLength(1);
  });

  it("postgres 초기화 시 organization invite token 상태를 hydrate 해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";

    const mock = createMockSqlClient((sql) => {
      if (sql.includes("FROM organizations")) {
        return [
          {
            id: "org-invite-1",
            name: "Invite Org",
            slug: "invite-org",
            active: true,
            created_at: "2026-03-01T00:00:00.000Z",
            disabled_at: null,
          },
        ];
      }

      if (sql.includes("FROM organization_invite_tokens")) {
        return [
          {
            token: "token-1",
            organization_id: "org-invite-1",
            role: "member",
            email: "invitee@example.com",
            created_by_user_id: "admin-user",
            created_at: "2026-03-01T00:10:00.000Z",
            expires_at: "2026-03-01T01:10:00.000Z",
            consumed_at: null,
            consumed_by_user_id: null,
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
    expect(result.persistedState.inviteTokens).toEqual([
      {
        token: "token-1",
        organizationId: "org-invite-1",
        role: "member",
        email: "invitee@example.com",
        createdByUserId: "admin-user",
        createdAt: "2026-03-01T00:10:00.000Z",
        expiresAt: "2026-03-01T01:10:00.000Z",
      },
    ]);
  });

  it("persistOrganizationInviteTokenRecord는 postgres 모드에서 초대 토큰 upsert를 저장해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";

    const mock = createMockSqlClient();

    await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    persistOrganizationInviteTokenRecord({
      token: "token-save-1",
      organizationId: "org-save-1",
      role: "viewer",
      email: "viewer@example.com",
      createdByUserId: "admin-save",
      createdAt: "2026-03-01T00:00:00.000Z",
      expiresAt: "2026-03-01T00:30:00.000Z",
      consumedAt: "2026-03-01T00:05:00.000Z",
      consumedByUserId: "viewer-user",
    });

    await resetDataBackendForTests();

    const inviteInsertValues = mock.query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO organization_invite_tokens"))
      .map(([, values]) => values);

    expect(inviteInsertValues).toEqual([
      [
        "token-save-1",
        "org-save-1",
        "viewer",
        "viewer@example.com",
        "admin-save",
        "2026-03-01T00:00:00.000Z",
        "2026-03-01T00:30:00.000Z",
        "2026-03-01T00:05:00.000Z",
        "viewer-user",
      ],
    ]);
  });

  it("postgres read path는 tenant-scoped direct query + session context를 사용해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";
    process.env.TENANT_RLS_MODE = "shadow";

    const mock = createMockSqlClient((sql, values) => {
      if (sql.includes("FROM scans") && sql.includes("WHERE tenant_id = $1")) {
        return [
          {
            id: "scan-direct-list-1",
            tenant_id: String(values?.[0] ?? "tenant-a"),
            engine: "semgrep",
            repo_url: "https://github.com/test/repo-direct-list",
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
            id: String(values?.[0] ?? "scan-direct-get-1"),
            tenant_id: String(values?.[1] ?? "tenant-a"),
            engine: "trivy",
            repo_url: "https://github.com/test/repo-direct-get",
            branch: "release",
            status: "completed",
            created_at: "2026-03-01T01:00:00.000Z",
            completed_at: "2026-03-01T01:10:00.000Z",
            retry_count: 1,
            last_error: null,
            last_error_code: null,
            findings: {
              totalFindings: 1,
              critical: 0,
              high: 1,
              medium: 0,
              low: 0,
            },
          },
        ];
      }

      return [];
    });

    await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    const scans = await listPersistedScansForTenant({
      tenantId: "tenant-a",
      status: "queued",
      userId: "reader-a",
      userRole: "member",
    });

    expect(scans).toHaveLength(1);
    expect(scans?.[0]?.id).toBe("scan-direct-list-1");
    expect(scans?.[0]?.tenantId).toBe("tenant-a");

    const scan = await getPersistedScanForTenant({
      scanId: "scan-direct-get-1",
      tenantId: "tenant-a",
      userId: "reader-a",
      userRole: "member",
    });

    expect(scan?.id).toBe("scan-direct-get-1");
    expect(scan?.branch).toBe("release");
    expect(scan?.status).toBe("completed");

    const contextCall = mock.query.mock.calls.find(
      ([sql, values]) =>
        String(sql).includes("set_config('app.tenant_id'") &&
        Array.isArray(values) &&
        values[0] === "tenant-a" &&
        values[1] === "reader-a" &&
        values[2] === "member"
    );

    expect(contextCall).toBeDefined();
  });

  it("runtime guard warn 모드에서는 unsafe tenant/service context 사용을 경고해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";
    process.env.TENANT_RLS_MODE = "shadow";
    process.env.TENANT_RLS_RUNTIME_GUARD_MODE = "warn";

    const warnSpy = vi.fn();
    const mock = createMockSqlClient();

    await initializeDataBackend({
      logger: {
        info: () => undefined,
        warn: warnSpy,
        error: () => undefined,
      },
      createSqlClient: () => mock.client,
    });

    expect(getActiveTenantRlsRuntimeGuardMode()).toBe("warn");

    const scans = await listPersistedScansForTenant({
      tenantId: "tenant-a",
      userId: "service-reader",
      userRole: "service",
    });

    expect(scans).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("tenant RLS runtime guard 위반")
    );
  });

  it("runtime guard enforce 모드에서는 unsafe tenant/service context 사용을 차단해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";
    process.env.TENANT_RLS_MODE = "enforce";
    process.env.TENANT_RLS_RUNTIME_GUARD_MODE = "enforce";

    const mock = createMockSqlClient();

    await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => mock.client,
    });

    expect(getActiveTenantRlsRuntimeGuardMode()).toBe("enforce");

    await expect(
      getPersistedScanForTenant({
        scanId: "scan-guard-enforce-1",
        tenantId: "tenant-a",
        userId: "service-reader",
        userRole: "service",
      })
    ).rejects.toThrow(/tenant RLS runtime guard 위반/);
  });

});
