import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTenantAuditLogs,
  createTenantAuditLog,
  hydrateTenantAuditLogs,
  listTenantAuditLogs,
  readTenantAuditLogRetentionDays,
  type TenantAuditLog,
} from "../src/tenants/audit-log.js";

const ORIGINAL_TENANT_AUDIT_LOG_RETENTION_DAYS =
  process.env.TENANT_AUDIT_LOG_RETENTION_DAYS;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

afterEach(() => {
  restoreEnv(
    "TENANT_AUDIT_LOG_RETENTION_DAYS",
    ORIGINAL_TENANT_AUDIT_LOG_RETENTION_DAYS
  );
  clearTenantAuditLogs();
  vi.useRealTimers();
});

describe("tenant audit log store", () => {
  it("listTenantAuditLogs는 action/userId/time window 필터를 지원해야 한다", () => {
    const fixtures: TenantAuditLog[] = [
      {
        id: "log-1",
        organizationId: "org-a",
        actorUserId: "admin-a",
        action: "membership.created",
        targetUserId: "member-a",
        createdAt: "2026-03-01T00:00:00.000Z",
      },
      {
        id: "log-2",
        organizationId: "org-a",
        actorUserId: "admin-a",
        action: "membership.created",
        targetUserId: "member-b",
        createdAt: "2026-03-01T00:02:00.000Z",
      },
      {
        id: "log-3",
        organizationId: "org-a",
        actorUserId: "admin-a",
        action: "membership.role_updated",
        targetUserId: "member-b",
        createdAt: "2026-03-01T00:03:00.000Z",
      },
      {
        id: "log-4",
        organizationId: "org-b",
        actorUserId: "admin-b",
        action: "membership.created",
        targetUserId: "member-z",
        createdAt: "2026-03-01T00:04:00.000Z",
      },
    ];

    hydrateTenantAuditLogs(fixtures);

    const filtered = listTenantAuditLogs({
      organizationId: "org-a",
      action: "membership.created",
      userId: "member-b",
      since: "2026-03-01T00:01:00.000Z",
      until: "2026-03-01T00:03:00.000Z",
      limit: 10,
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("log-2");
  });

  it("retention 환경변수가 설정되면 hydrate/create 시 오래된 로그를 prune 해야 한다", () => {
    process.env.TENANT_AUDIT_LOG_RETENTION_DAYS = "1";

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

    expect(readTenantAuditLogRetentionDays()).toBe(1);

    hydrateTenantAuditLogs([
      {
        id: "old-log",
        organizationId: "org-a",
        actorUserId: "admin-a",
        action: "membership.created",
        targetUserId: "member-a",
        createdAt: "2026-03-07T00:00:00.000Z",
      },
      {
        id: "fresh-log",
        organizationId: "org-a",
        actorUserId: "admin-a",
        action: "membership.created",
        targetUserId: "member-b",
        createdAt: "2026-03-09T18:00:00.000Z",
      },
    ]);

    const afterHydrate = listTenantAuditLogs({ organizationId: "org-a", limit: 10 });
    expect(afterHydrate.map((log) => log.id)).toEqual(["fresh-log"]);

    vi.setSystemTime(new Date("2026-03-11T12:00:00.000Z"));

    createTenantAuditLog({
      organizationId: "org-a",
      actorUserId: "admin-a",
      action: "membership.role_updated",
      targetUserId: "member-b",
    });

    const afterCreate = listTenantAuditLogs({ organizationId: "org-a", limit: 10 });
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0]?.action).toBe("membership.role_updated");
  });
});
