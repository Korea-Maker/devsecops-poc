import { randomUUID } from "crypto";
import {
  clearPersistedTenantAuditLogs,
  persistTenantAuditLog,
} from "../storage/backend.js";

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

function cloneTenantAuditLog(log: TenantAuditLog): TenantAuditLog {
  return {
    ...log,
    details: log.details ? { ...log.details } : undefined,
  };
}

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
  persistTenantAuditLog(log);
  return cloneTenantAuditLog(log);
}

export function listTenantAuditLogs(params: {
  organizationId: string;
  limit?: number;
}): TenantAuditLog[] {
  const limit = params.limit ?? 50;

  const filtered = tenantAuditLogs
    .filter((log) => log.organizationId === params.organizationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return filtered.slice(0, limit).map((log) => cloneTenantAuditLog(log));
}

/**
 * 앱 시작 시점에 외부 저장소에서 읽어온 감사로그로 인메모리 스토어를 채웁니다.
 */
export function hydrateTenantAuditLogs(logs: TenantAuditLog[]): void {
  tenantAuditLogs.length = 0;

  for (const log of logs) {
    tenantAuditLogs.push(cloneTenantAuditLog(log));
  }
}

export function clearTenantAuditLogs(): void {
  tenantAuditLogs.length = 0;
  clearPersistedTenantAuditLogs();
}
