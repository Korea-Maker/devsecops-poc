import { randomUUID } from "crypto";

export type TenantAuditAction =
  | "organization.created"
  | "membership.created"
  | "membership.role_updated"
  | "membership.deleted";

export interface TenantAuditLog {
  id: string;
  organizationId: string;
  actorUserId?: string;
  action: TenantAuditAction;
  targetUserId?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

const tenantAuditLogs: TenantAuditLog[] = [];

export function createTenantAuditLog(params: {
  organizationId: string;
  actorUserId?: string;
  action: TenantAuditAction;
  targetUserId?: string;
  details?: Record<string, unknown>;
}): TenantAuditLog {
  const log: TenantAuditLog = {
    id: randomUUID(),
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: params.action,
    targetUserId: params.targetUserId,
    details: params.details,
    createdAt: new Date().toISOString(),
  };

  tenantAuditLogs.push(log);
  return { ...log };
}

export function listTenantAuditLogs(params: {
  organizationId: string;
  limit?: number;
}): TenantAuditLog[] {
  const limit = params.limit ?? 50;

  const filtered = tenantAuditLogs
    .filter((log) => log.organizationId === params.organizationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return filtered.slice(0, limit).map((log) => ({ ...log }));
}

export function clearTenantAuditLogs(): void {
  tenantAuditLogs.length = 0;
}
