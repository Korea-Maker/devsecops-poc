import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOrganizationForTenantReadPath,
  hydrateOrganizationStore,
  listOrganizationsForTenantReadPath,
  listMembershipsForTenantReadPath,
} from "../src/tenants/store.js";
import {
  clearTenantAuditLogs,
  createTenantAuditLog,
  listTenantAuditLogsForTenantReadPath,
} from "../src/tenants/audit-log.js";
import {
  initializeDataBackend,
  resetDataBackendForTests,
} from "../src/storage/backend.js";
import { DEFAULT_TENANT_ID } from "../src/tenants/types.js";

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

  hydrateOrganizationStore({
    organizations: [
      {
        id: DEFAULT_TENANT_ID,
        name: "Default Organization",
        slug: "default",
        active: true,
        createdAt: "2026-03-01T00:00:00.000Z",
      },
    ],
    memberships: [],
    inviteTokens: [],
  });
  clearTenantAuditLogs();
});

afterEach(async () => {
  restoreEnv("DATA_BACKEND", ORIGINAL_DATA_BACKEND);
  restoreEnv("DATABASE_URL", ORIGINAL_DATABASE_URL);
  restoreEnv("TENANT_RLS_MODE", ORIGINAL_TENANT_RLS_MODE);

  hydrateOrganizationStore({
    organizations: [
      {
        id: DEFAULT_TENANT_ID,
        name: "Default Organization",
        slug: "default",
        active: true,
        createdAt: "2026-03-01T00:00:00.000Z",
      },
    ],
    memberships: [],
    inviteTokens: [],
  });
  clearTenantAuditLogs();

  await resetDataBackendForTests();
});

describe("tenant read path selection", () => {
  it("DATA_BACKEND=postgres면 organization/membership read는 tenant-scoped DB direct query를 우선 사용해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";
    process.env.TENANT_RLS_MODE = "shadow";

    const mock = createMockSqlClient((sql, values) => {
      if (sql.includes("FROM organizations") && sql.includes("WHERE id = $1 AND id = $2")) {
        const organizationId = String(values?.[0] ?? "org-db-1");
        const tenantId = String(values?.[1] ?? "org-db-1");

        if (organizationId !== tenantId) {
          return [];
        }

        return [
          {
            id: organizationId,
            name: "DB Scoped Org",
            slug: "db-scoped-org",
            active: true,
            created_at: "2026-03-01T01:00:00.000Z",
            disabled_at: null,
          },
        ];
      }

      if (
        sql.includes("FROM organization_memberships") &&
        sql.includes("WHERE organization_id = $1 AND organization_id = $2")
      ) {
        const organizationId = String(values?.[0] ?? "org-db-1");
        const tenantId = String(values?.[1] ?? "org-db-1");

        if (organizationId !== tenantId) {
          return [];
        }

        return [
          {
            organization_id: organizationId,
            user_id: "db-member-1",
            role: "admin",
            created_at: "2026-03-01T01:05:00.000Z",
            updated_at: "2026-03-01T01:05:00.000Z",
          },
        ];
      }

      return [];
    });

    await initializeDataBackend({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      createSqlClient: () => mock.client,
    });

    hydrateOrganizationStore({
      organizations: [
        {
          id: DEFAULT_TENANT_ID,
          name: "Default Organization",
          slug: "default",
          active: true,
          createdAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: "org-db-1",
          name: "Memory Org",
          slug: "memory-org",
          active: true,
          createdAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      memberships: [
        {
          organizationId: "org-db-1",
          userId: "memory-member-1",
          role: "member",
          createdAt: "2026-03-01T00:10:00.000Z",
          updatedAt: "2026-03-01T00:10:00.000Z",
        },
      ],
      inviteTokens: [],
    });

    const organization = await getOrganizationForTenantReadPath({
      id: "org-db-1",
      tenantId: "org-db-1",
      userId: "tenant-reader",
      userRole: "member",
    });

    expect(organization?.name).toBe("DB Scoped Org");

    const memberships = await listMembershipsForTenantReadPath({
      organizationId: "org-db-1",
      tenantId: "org-db-1",
      search: "member",
      page: 1,
      limit: 20,
      userId: "tenant-reader",
      userRole: "member",
    });

    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.userId).toBe("db-member-1");

    const tenantMismatchOrg = await getOrganizationForTenantReadPath({
      id: "org-db-1",
      tenantId: "org-other",
      userId: "tenant-reader",
      userRole: "member",
    });
    expect(tenantMismatchOrg).toBeUndefined();

    const tenantMismatchMemberships = await listMembershipsForTenantReadPath({
      organizationId: "org-db-1",
      tenantId: "org-other",
      userId: "tenant-reader",
      userRole: "member",
    });
    expect(tenantMismatchMemberships).toEqual([]);

    const organizationReadQuery = mock.query.mock.calls.find(
      ([sql]) =>
        String(sql).includes("FROM organizations") &&
        String(sql).includes("WHERE id = $1 AND id = $2")
    );
    expect(organizationReadQuery).toBeDefined();

    const membershipReadQuery = mock.query.mock.calls.find(
      ([sql]) =>
        String(sql).includes("FROM organization_memberships") &&
        String(sql).includes("WHERE organization_id = $1 AND organization_id = $2")
    );
    expect(membershipReadQuery).toBeDefined();
  });

  it("DATA_BACKEND=postgres면 organizations list / audit-logs read는 tenant-scoped DB direct query를 우선 사용해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://example/devsecops";
    process.env.TENANT_RLS_MODE = "shadow";

    const mock = createMockSqlClient((sql, values) => {
      if (sql.includes("FROM organizations") && sql.includes("WHERE id = $1")) {
        const tenantId = String(values?.[0] ?? "org-db-2");
        const searchTerm = String(values?.[1] ?? "");
        if (!searchTerm.includes("db")) {
          return [];
        }

        return [
          {
            id: tenantId,
            name: "DB List Org",
            slug: "db-list-org",
            active: true,
            created_at: "2026-03-01T02:00:00.000Z",
            disabled_at: null,
          },
        ];
      }

      if (
        sql.includes("FROM tenant_audit_logs") &&
        sql.includes("WHERE organization_id = $1 AND organization_id = $2")
      ) {
        const organizationId = String(values?.[0] ?? "org-db-2");
        const tenantId = String(values?.[1] ?? "org-db-2");
        const actorOrTargetUserId = String(values?.[3] ?? "");

        if (organizationId !== tenantId || actorOrTargetUserId !== "db-user") {
          return [];
        }

        return [
          {
            id: "db-log-1",
            organization_id: organizationId,
            actor_user_id: "db-user",
            action: "membership.created",
            target_user_id: "db-user",
            details: { source: "db-direct" },
            created_at: "2026-03-01T02:10:00.000Z",
          },
        ];
      }

      return [];
    });

    await initializeDataBackend({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      createSqlClient: () => mock.client,
    });

    const organizations = await listOrganizationsForTenantReadPath({
      tenantId: "org-db-2",
      search: "db",
      page: 1,
      limit: 5,
      userId: "tenant-reader",
      userRole: "member",
    });

    expect(organizations).toHaveLength(1);
    expect(organizations[0]?.name).toBe("DB List Org");

    const auditLogs = await listTenantAuditLogsForTenantReadPath({
      organizationId: "org-db-2",
      tenantId: "org-db-2",
      tenantUserId: "tenant-reader",
      userRole: "admin",
      limit: 10,
      action: "membership.created",
      userId: "db-user",
      since: "2026-03-01T00:00:00.000Z",
      until: "2026-03-02T00:00:00.000Z",
    });

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.id).toBe("db-log-1");

    const listQuery = mock.query.mock.calls.find(
      ([sql]) =>
        String(sql).includes("FROM organizations") && String(sql).includes("WHERE id = $1")
    );
    expect(listQuery).toBeDefined();

    const auditQuery = mock.query.mock.calls.find(
      ([sql]) =>
        String(sql).includes("FROM tenant_audit_logs") &&
        String(sql).includes("WHERE organization_id = $1 AND organization_id = $2")
    );
    expect(auditQuery).toBeDefined();
  });

  it("memory 백엔드에서는 기존 인메모리 read path를 유지해야 한다", async () => {
    process.env.DATA_BACKEND = "memory";

    await initializeDataBackend({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    hydrateOrganizationStore({
      organizations: [
        {
          id: DEFAULT_TENANT_ID,
          name: "Default Organization",
          slug: "default",
          active: true,
          createdAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: "org-memory-1",
          name: "Memory Org",
          slug: "memory-org",
          active: true,
          createdAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      memberships: [
        {
          organizationId: "org-memory-1",
          userId: "member-1",
          role: "member",
          createdAt: "2026-03-01T00:01:00.000Z",
          updatedAt: "2026-03-01T00:01:00.000Z",
        },
        {
          organizationId: "org-memory-1",
          userId: "member-2",
          role: "member",
          createdAt: "2026-03-01T00:02:00.000Z",
          updatedAt: "2026-03-01T00:02:00.000Z",
        },
      ],
      inviteTokens: [],
    });

    const organization = await getOrganizationForTenantReadPath({
      id: "org-memory-1",
      tenantId: "org-memory-1",
    });
    expect(organization?.id).toBe("org-memory-1");

    const pagedMemberships = await listMembershipsForTenantReadPath({
      organizationId: "org-memory-1",
      tenantId: "org-memory-1",
      search: "member-",
      page: 2,
      limit: 1,
    });

    expect(pagedMemberships).toHaveLength(1);
    expect(pagedMemberships[0]?.userId).toBe("member-2");

    const tenantMismatchOrg = await getOrganizationForTenantReadPath({
      id: "org-memory-1",
      tenantId: "org-other",
    });
    expect(tenantMismatchOrg).toBeUndefined();

    const tenantMismatchMemberships = await listMembershipsForTenantReadPath({
      organizationId: "org-memory-1",
      tenantId: "org-other",
    });
    expect(tenantMismatchMemberships).toEqual([]);

    const organizations = await listOrganizationsForTenantReadPath({
      tenantId: "org-memory-1",
      search: "memory",
      page: 1,
      limit: 10,
    });
    expect(organizations).toHaveLength(1);
    expect(organizations[0]?.id).toBe("org-memory-1");

    createTenantAuditLog({
      organizationId: "org-memory-1",
      actorUserId: "memory-admin",
      action: "membership.created",
      targetUserId: "memory-member",
      details: { source: "memory" },
    });

    const auditLogs = await listTenantAuditLogsForTenantReadPath({
      organizationId: "org-memory-1",
      tenantId: "org-memory-1",
      userId: "memory-member",
      limit: 5,
      action: "membership.created",
    });
    expect(auditLogs).toHaveLength(1);

    const tenantMismatchAuditLogs = await listTenantAuditLogsForTenantReadPath({
      organizationId: "org-memory-1",
      tenantId: "org-other",
      limit: 5,
    });
    expect(tenantMismatchAuditLogs).toEqual([]);
  });
});
