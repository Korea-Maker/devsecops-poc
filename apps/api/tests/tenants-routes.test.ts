import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { clearOrganizationStore } from "../src/tenants/store.js";
import { clearTenantAuditLogs } from "../src/tenants/audit-log.js";
import type { UserRole } from "../src/tenants/types.js";

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
    "x-user-id": options.userId ?? "tenant-user-1",
    "x-user-role": options.role ?? "admin",
  };

  if (options.tenantId !== undefined) {
    headers["x-tenant-id"] = options.tenantId;
  }

  return headers;
}

describe("Tenant API", () => {
  const app = buildApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    clearOrganizationStore();
    clearTenantAuditLogs();
    delete process.env.TENANT_AUTH_MODE;
    delete process.env.AUTH_MODE;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.JWT_JWKS_URL;
  });

  afterEach(() => {
    restoreEnv("TENANT_AUTH_MODE", ORIGINAL_TENANT_AUTH_MODE);
    restoreEnv("AUTH_MODE", ORIGINAL_AUTH_MODE);
    restoreEnv("JWT_ISSUER", ORIGINAL_JWT_ISSUER);
    restoreEnv("JWT_AUDIENCE", ORIGINAL_JWT_AUDIENCE);
    restoreEnv("JWT_JWKS_URL", ORIGINAL_JWT_JWKS_URL);
    clearOrganizationStore();
    clearTenantAuditLogs();
  });

  it("기본 모드(disabled)에서 조직 목록은 default 조직을 포함해야 한다", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/organizations",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0]?.id).toBe("default");
  });

  it("required 모드에서 x-user-id 헤더 없이 요청하면 401이어야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/organizations",
      headers: {
        "x-user-role": "admin",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("TENANT_AUTH_USER_ID_REQUIRED");
  });

  it("required 모드에서 admin은 조직 생성 시 owner 멤버십이 자동 생성되어야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const creatorUserId = "org-owner-user";
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: creatorUserId,
        role: "admin",
      }),
      payload: {
        name: "Acme Security",
        slug: "acme-security",
      },
    });

    expect(createRes.statusCode).toBe(201);
    const orgId = createRes.json().organization.id as string;

    const membershipsRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/memberships`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: creatorUserId,
        role: "admin",
      }),
    });

    expect(membershipsRes.statusCode).toBe(200);
    expect(membershipsRes.json()).toHaveLength(1);
    expect(membershipsRes.json()[0]).toMatchObject({
      organizationId: orgId,
      userId: creatorUserId,
      role: "owner",
    });
  });

  it("required 모드에서 member는 조직 생성이 거부되어야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "tenant-member",
        role: "member",
      }),
      payload: {
        name: "Denied Org",
        slug: "denied-org",
      },
    });

    expect(createRes.statusCode).toBe(403);
    expect(createRes.json().code).toBe("TENANT_FORBIDDEN");
  });

  it("required 모드에서 조직/멤버십 관리는 tenant scope 안에서만 가능해야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "tenant-admin-a",
        role: "admin",
      }),
      payload: {
        name: "Scoped Org",
        slug: "scoped-org",
      },
    });
    const orgId = createRes.json().organization.id as string;

    const crossTenantGet = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}`,
      headers: buildTenantHeaders({
        tenantId: "other-tenant",
        userId: "tenant-admin-b",
        role: "admin",
      }),
    });

    expect(crossTenantGet.statusCode).toBe(404);
    expect(crossTenantGet.json().code).toBe("TENANT_ORG_NOT_FOUND");
  });

  it("required 모드에서 admin은 멤버십 생성/역할수정이 가능해야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "tenant-admin",
        role: "admin",
      }),
      payload: {
        name: "Membership Org",
        slug: "membership-org",
      },
    });
    const orgId = createRes.json().organization.id as string;

    const addMemberRes = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgId}/memberships`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "tenant-admin",
        role: "admin",
      }),
      payload: {
        userId: "member-user-1",
        role: "member",
      },
    });

    expect(addMemberRes.statusCode).toBe(201);
    expect(addMemberRes.json().membership).toMatchObject({
      organizationId: orgId,
      userId: "member-user-1",
      role: "member",
    });

    const patchRoleRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${orgId}/memberships/member-user-1`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "tenant-admin",
        role: "admin",
      }),
      payload: {
        role: "viewer",
      },
    });

    expect(patchRoleRes.statusCode).toBe(200);
    expect(patchRoleRes.json().membership).toMatchObject({
      organizationId: orgId,
      userId: "member-user-1",
      role: "viewer",
    });
  });

  it("required 모드에서 admin은 멤버십 삭제가 가능해야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "tenant-admin",
        role: "admin",
      }),
      payload: {
        name: "Membership Delete Org",
        slug: "membership-delete-org",
      },
    });
    const orgId = createRes.json().organization.id as string;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgId}/memberships`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "tenant-admin",
        role: "admin",
      }),
      payload: {
        userId: "member-user-delete",
        role: "member",
      },
    });

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${orgId}/memberships/member-user-delete`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "tenant-admin",
        role: "admin",
      }),
    });

    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().membership).toMatchObject({
      organizationId: orgId,
      userId: "member-user-delete",
      role: "member",
    });

    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/memberships`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "tenant-admin",
        role: "admin",
      }),
    });

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().some((m: { userId: string }) => m.userId === "member-user-delete")).toBe(false);
  });

  it("required 모드에서 마지막 owner 삭제는 409(TENANT_OWNER_MIN_REQUIRED)여야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "tenant-admin-owner",
        role: "admin",
      }),
      payload: {
        name: "Owner Guard Org",
        slug: "owner-guard-org-route",
      },
    });
    const orgId = createRes.json().organization.id as string;

    const deleteOwnerRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${orgId}/memberships/tenant-admin-owner`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "tenant-admin-owner",
        role: "admin",
      }),
    });

    expect(deleteOwnerRes.statusCode).toBe(409);
    expect(deleteOwnerRes.json().code).toBe("TENANT_OWNER_MIN_REQUIRED");
  });

  it("required 모드에서 admin은 감사 로그를 조회할 수 있어야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "audit-admin",
        role: "admin",
      }),
      payload: {
        name: "Audit Org",
        slug: "audit-org",
      },
    });
    const orgId = createRes.json().organization.id as string;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgId}/memberships`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-admin",
        role: "admin",
      }),
      payload: {
        userId: "audit-member",
        role: "member",
      },
    });

    await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${orgId}/memberships/audit-member`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-admin",
        role: "admin",
      }),
      payload: {
        role: "viewer",
      },
    });

    const logsRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/audit-logs?limit=10`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-admin",
        role: "admin",
      }),
    });

    expect(logsRes.statusCode).toBe(200);
    const logs = logsRes.json();
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    const actions = logs.map((log: { action: string }) => log.action);
    expect(actions).toContain("organization.created");
    expect(actions).toContain("membership.created");
    expect(actions).toContain("membership.role_updated");

    const invalidLimitRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/audit-logs?limit=0`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-admin",
        role: "admin",
      }),
    });

    expect(invalidLimitRes.statusCode).toBe(400);
    expect(invalidLimitRes.json().code).toBe("TENANT_INVALID_LIMIT");
  });

  it("required 모드에서 member는 멤버십/감사로그 관리 API 접근이 거부되어야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "tenant-admin",
        role: "admin",
      }),
      payload: {
        name: "RBAC Org",
        slug: "rbac-org",
      },
    });
    const orgId = createRes.json().organization.id as string;

    const memberHeaders = buildTenantHeaders({
      tenantId: orgId,
      userId: "tenant-member",
      role: "member",
    });

    const memberListRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/memberships`,
      headers: memberHeaders,
    });

    expect(memberListRes.statusCode).toBe(403);
    expect(memberListRes.json().code).toBe("TENANT_FORBIDDEN");

    const memberAuditRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/audit-logs`,
      headers: memberHeaders,
    });

    expect(memberAuditRes.statusCode).toBe(403);
    expect(memberAuditRes.json().code).toBe("TENANT_FORBIDDEN");
  });
});
