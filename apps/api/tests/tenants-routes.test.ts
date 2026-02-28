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
const ORIGINAL_TENANT_AUDIT_LOG_RETENTION_DAYS =
  process.env.TENANT_AUDIT_LOG_RETENTION_DAYS;

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
    delete process.env.TENANT_AUDIT_LOG_RETENTION_DAYS;
  });

  afterEach(() => {
    restoreEnv("TENANT_AUTH_MODE", ORIGINAL_TENANT_AUTH_MODE);
    restoreEnv("AUTH_MODE", ORIGINAL_AUTH_MODE);
    restoreEnv("JWT_ISSUER", ORIGINAL_JWT_ISSUER);
    restoreEnv("JWT_AUDIENCE", ORIGINAL_JWT_AUDIENCE);
    restoreEnv("JWT_JWKS_URL", ORIGINAL_JWT_JWKS_URL);
    restoreEnv(
      "TENANT_AUDIT_LOG_RETENTION_DAYS",
      ORIGINAL_TENANT_AUDIT_LOG_RETENTION_DAYS
    );
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

  it("required 모드에서 감사 로그는 action/userId/time window 필터를 지원해야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "audit-filter-admin",
        role: "admin",
      }),
      payload: {
        name: "Audit Filter Org",
        slug: "audit-filter-org",
      },
    });
    const orgId = createRes.json().organization.id as string;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgId}/memberships`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-filter-admin",
        role: "admin",
      }),
      payload: {
        userId: "audit-member-2",
        role: "member",
      },
    });

    await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${orgId}/memberships/audit-member-2`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-filter-admin",
        role: "admin",
      }),
      payload: {
        role: "viewer",
      },
    });

    const filteredRes = await app.inject({
      method: "GET",
      url:
        `/api/v1/organizations/${orgId}/audit-logs` +
        "?action=membership.created" +
        "&userId=audit-member-2" +
        "&since=2000-01-01T00:00:00.000Z" +
        "&until=2100-01-01T00:00:00.000Z",
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-filter-admin",
        role: "admin",
      }),
    });

    expect(filteredRes.statusCode).toBe(200);
    const filteredLogs = filteredRes.json();
    expect(filteredLogs.length).toBeGreaterThanOrEqual(1);
    expect(
      filteredLogs.every((log: { action: string }) => log.action === "membership.created")
    ).toBe(true);
    expect(
      filteredLogs.every(
        (log: { actorUserId?: string; targetUserId?: string }) =>
          log.actorUserId === "audit-member-2" || log.targetUserId === "audit-member-2"
      )
    ).toBe(true);

    const futureWindowRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/audit-logs?since=2999-01-01T00:00:00.000Z`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-filter-admin",
        role: "admin",
      }),
    });

    expect(futureWindowRes.statusCode).toBe(200);
    expect(futureWindowRes.json()).toEqual([]);

    const invalidActionRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/audit-logs?action=unknown.action`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-filter-admin",
        role: "admin",
      }),
    });

    expect(invalidActionRes.statusCode).toBe(400);
    expect(invalidActionRes.json().code).toBe("TENANT_INVALID_AUDIT_ACTION");

    const invalidUserIdRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/audit-logs?userId=%20`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-filter-admin",
        role: "admin",
      }),
    });

    expect(invalidUserIdRes.statusCode).toBe(400);
    expect(invalidUserIdRes.json().code).toBe("TENANT_INVALID_AUDIT_USER_ID");

    const invalidTimeRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/audit-logs?since=not-a-date`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-filter-admin",
        role: "admin",
      }),
    });

    expect(invalidTimeRes.statusCode).toBe(400);
    expect(invalidTimeRes.json().code).toBe("TENANT_INVALID_AUDIT_TIME");

    const invalidRangeRes = await app.inject({
      method: "GET",
      url:
        `/api/v1/organizations/${orgId}/audit-logs` +
        "?since=2026-03-02T00:00:00.000Z" +
        "&until=2026-03-01T00:00:00.000Z",
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "audit-filter-admin",
        role: "admin",
      }),
    });

    expect(invalidRangeRes.statusCode).toBe(400);
    expect(invalidRangeRes.json().code).toBe("TENANT_INVALID_AUDIT_TIME_RANGE");
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


  it("조직 목록은 pagination/search 쿼리를 지원해야 한다", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      payload: { name: "Team Alpha", slug: "team-alpha" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      payload: { name: "Team Beta", slug: "team-beta" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      payload: { name: "Team Gamma", slug: "team-gamma" },
    });

    const page1 = await app.inject({
      method: "GET",
      url: "/api/v1/organizations?search=team&page=1&limit=2",
    });

    expect(page1.statusCode).toBe(200);
    expect(page1.json()).toHaveLength(2);

    const page2 = await app.inject({
      method: "GET",
      url: "/api/v1/organizations?search=team&page=2&limit=2",
    });

    expect(page2.statusCode).toBe(200);
    expect(page2.json()).toHaveLength(1);
    expect(page2.json()[0]?.slug).toBe("team-gamma");

    const invalidPagination = await app.inject({
      method: "GET",
      url: "/api/v1/organizations?page=0&limit=2",
    });

    expect(invalidPagination.statusCode).toBe(400);
    expect(invalidPagination.json().code).toBe("TENANT_INVALID_PAGINATION");
  });

  it("멤버십 목록은 pagination/search 쿼리를 지원해야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "pagination-admin",
        role: "admin",
      }),
      payload: {
        name: "Pagination Membership Org",
        slug: "pagination-membership-org",
      },
    });
    const orgId = createRes.json().organization.id as string;

    for (const userId of ["member-1", "member-2", "member-3"]) {
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgId}/memberships`,
        headers: buildTenantHeaders({
          tenantId: orgId,
          userId: "pagination-admin",
          role: "admin",
        }),
        payload: {
          userId,
          role: "member",
        },
      });
    }

    const pagedMembers = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/memberships?search=member-&page=2&limit=2`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "pagination-admin",
        role: "admin",
      }),
    });

    expect(pagedMembers.statusCode).toBe(200);
    expect(pagedMembers.json()).toHaveLength(1);
    expect(pagedMembers.json()[0]?.userId).toBe("member-3");

    const invalidPagination = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}/memberships?page=a&limit=2`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "pagination-admin",
        role: "admin",
      }),
    });

    expect(invalidPagination.statusCode).toBe(400);
    expect(invalidPagination.json().code).toBe("TENANT_INVALID_PAGINATION");
  });

  it("조직 비활성화 후에는 멤버십 쓰기 작업이 차단되어야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "disable-admin",
        role: "admin",
      }),
      payload: {
        name: "Disable Target Org",
        slug: "disable-target-org",
      },
    });
    const orgId = createRes.json().organization.id as string;

    const disableRes = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgId}/disable`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "disable-admin",
        role: "admin",
      }),
    });

    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json().organization.active).toBe(false);
    expect(disableRes.json().organization.disabledAt).toBeDefined();

    const detailRes = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgId}`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "disable-admin",
        role: "admin",
      }),
    });

    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().active).toBe(false);

    const addMemberRes = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgId}/memberships`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "disable-admin",
        role: "admin",
      }),
      payload: {
        userId: "disabled-org-member",
        role: "member",
      },
    });

    expect(addMemberRes.statusCode).toBe(409);
    expect(addMemberRes.json().code).toBe("TENANT_ORG_DISABLED");
  });

  it("초대 토큰 생성/수락은 성공/실패 계약을 만족해야 한다", async () => {
    process.env.TENANT_AUTH_MODE = "required";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "invite-admin",
        role: "admin",
      }),
      payload: {
        name: "Invite Route Org",
        slug: "invite-route-org",
      },
    });
    const orgId = createRes.json().organization.id as string;

    const memberCreateInviteRes = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgId}/invite-tokens`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "invite-member",
        role: "member",
      }),
      payload: {
        role: "member",
        expiresInMinutes: 30,
      },
    });

    expect(memberCreateInviteRes.statusCode).toBe(403);
    expect(memberCreateInviteRes.json().code).toBe("TENANT_FORBIDDEN");

    const createInviteRes = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgId}/invite-tokens`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "invite-admin",
        role: "admin",
      }),
      payload: {
        role: "member",
        email: "invitee@example.com",
        expiresInMinutes: 30,
      },
    });

    expect(createInviteRes.statusCode).toBe(201);
    const inviteToken = createInviteRes.json().inviteToken.token as string;
    expect(typeof inviteToken).toBe("string");

    const acceptRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations/invite-tokens/accept",
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "invited-user",
        role: "viewer",
      }),
      payload: {
        token: inviteToken,
        email: "invitee@example.com",
      },
    });

    expect(acceptRes.statusCode).toBe(201);
    expect(acceptRes.json().membership).toMatchObject({
      organizationId: orgId,
      userId: "invited-user",
      role: "member",
    });

    const replayRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations/invite-tokens/accept",
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "invited-user-2",
        role: "viewer",
      }),
      payload: {
        token: inviteToken,
        email: "invitee@example.com",
      },
    });

    expect(replayRes.statusCode).toBe(409);
    expect(replayRes.json().code).toBe("TENANT_INVITE_ALREADY_USED");

    const createSecondInviteRes = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgId}/invite-tokens`,
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "invite-admin",
        role: "admin",
      }),
      payload: {
        role: "viewer",
        email: "bound@example.com",
        expiresInMinutes: 30,
      },
    });

    const secondInviteToken = createSecondInviteRes.json().inviteToken.token as string;

    const mismatchEmailRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations/invite-tokens/accept",
      headers: buildTenantHeaders({
        tenantId: orgId,
        userId: "mismatch-user",
        role: "viewer",
      }),
      payload: {
        token: secondInviteToken,
        email: "wrong@example.com",
      },
    });

    expect(mismatchEmailRes.statusCode).toBe(403);
    expect(mismatchEmailRes.json().code).toBe("TENANT_INVITE_EMAIL_MISMATCH");

    const crossTenantCreateRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: buildTenantHeaders({
        tenantId: "default",
        userId: "other-admin",
        role: "admin",
      }),
      payload: {
        name: "Other Org",
        slug: "other-org-invite-scope",
      },
    });
    const otherOrgId = crossTenantCreateRes.json().organization.id as string;

    const crossTenantAcceptRes = await app.inject({
      method: "POST",
      url: "/api/v1/organizations/invite-tokens/accept",
      headers: buildTenantHeaders({
        tenantId: otherOrgId,
        userId: "cross-tenant-user",
        role: "viewer",
      }),
      payload: {
        token: secondInviteToken,
        email: "bound@example.com",
      },
    });

    expect(crossTenantAcceptRes.statusCode).toBe(404);
    expect(crossTenantAcceptRes.json().code).toBe("TENANT_INVITE_NOT_FOUND");
  });

});
