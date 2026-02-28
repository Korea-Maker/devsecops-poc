import { randomUUID } from "crypto";
import {
  clearPersistedTenantAuditLogs,
  persistTenantAuditLog,
  prunePersistedTenantAuditLogs,
} from "../storage/backend.js";

const DEFAULT_AUDIT_LOG_LIMIT = 50;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const TENANT_AUDIT_ACTIONS = [
  "organization.created",
  "membership.created",
  "membership.role_updated",
  "membership.deleted",
] as const;

const TENANT_AUDIT_ACTION_SET: ReadonlySet<string> = new Set(TENANT_AUDIT_ACTIONS);

export type TenantAuditAction = (typeof TENANT_AUDIT_ACTIONS)[number];

export interface TenantAuditLog {
  id: string;
  organizationId: string;
  actorUserId?: string;
  action: TenantAuditAction;
  targetUserId?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

interface ListTenantAuditLogsParams {
  organizationId: string;
  limit?: number;
  action?: TenantAuditAction;
  userId?: string;
  since?: string;
  until?: string;
}

interface RetentionCutoff {
  cutoffIso: string;
  cutoffMs: number;
}

const tenantAuditLogs: TenantAuditLog[] = [];

function readTrimmedEnv(name: string): string | undefined {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string") {
    return undefined;
  }

  const normalized = rawValue.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function isTenantAuditAction(value: unknown): value is TenantAuditAction {
  return typeof value === "string" && TENANT_AUDIT_ACTION_SET.has(value);
}

export function readTenantAuditLogRetentionDays(): number | undefined {
  const rawValue = readTrimmedEnv("TENANT_AUDIT_LOG_RETENTION_DAYS");
  if (!rawValue) {
    return undefined;
  }

  if (!/^\d+$/.test(rawValue)) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }

  return parsed;
}

function getRetentionCutoff(nowMs: number): RetentionCutoff | undefined {
  const retentionDays = readTenantAuditLogRetentionDays();
  if (!retentionDays) {
    return undefined;
  }

  const cutoffMs = nowMs - retentionDays * MILLISECONDS_PER_DAY;
  return {
    cutoffMs,
    cutoffIso: new Date(cutoffMs).toISOString(),
  };
}

function cloneTenantAuditLog(log: TenantAuditLog): TenantAuditLog {
  return {
    ...log,
    details: log.details ? { ...log.details } : undefined,
  };
}

function toTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return timestamp;
}

export function pruneTenantAuditLogs(options: { nowMs?: number } = {}): number {
  const cutoff = getRetentionCutoff(options.nowMs ?? Date.now());
  if (!cutoff) {
    return 0;
  }

  let writeIndex = 0;

  for (const log of tenantAuditLogs) {
    const createdAtMs = toTimestamp(log.createdAt);
    const shouldKeep = createdAtMs === null || createdAtMs >= cutoff.cutoffMs;

    if (shouldKeep) {
      tenantAuditLogs[writeIndex] = log;
      writeIndex += 1;
    }
  }

  const removed = tenantAuditLogs.length - writeIndex;
  tenantAuditLogs.length = writeIndex;

  if (removed > 0) {
    prunePersistedTenantAuditLogs(cutoff.cutoffIso);
  }

  return removed;
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
  pruneTenantAuditLogs();
  return cloneTenantAuditLog(log);
}

export function listTenantAuditLogs(params: ListTenantAuditLogsParams): TenantAuditLog[] {
  const limit = params.limit ?? DEFAULT_AUDIT_LOG_LIMIT;
  const sinceMs = params.since ? toTimestamp(params.since) : null;
  const untilMs = params.until ? toTimestamp(params.until) : null;

  const filtered = tenantAuditLogs
    .filter((log) => {
      if (log.organizationId !== params.organizationId) {
        return false;
      }

      if (params.action && log.action !== params.action) {
        return false;
      }

      if (
        params.userId &&
        log.actorUserId !== params.userId &&
        log.targetUserId !== params.userId
      ) {
        return false;
      }

      if (sinceMs !== null || untilMs !== null) {
        const createdAtMs = toTimestamp(log.createdAt);
        if (createdAtMs === null) {
          return false;
        }

        if (sinceMs !== null && createdAtMs < sinceMs) {
          return false;
        }

        if (untilMs !== null && createdAtMs > untilMs) {
          return false;
        }
      }

      return true;
    })
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

  pruneTenantAuditLogs();
}

export function clearTenantAuditLogs(): void {
  tenantAuditLogs.length = 0;
  clearPersistedTenantAuditLogs();
}
