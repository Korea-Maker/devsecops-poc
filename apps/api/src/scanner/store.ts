import { randomUUID } from "crypto";
import type {
  ScanEngineType,
  ScanErrorCode,
  ScanResultSummary,
  ScanStatus,
} from "./types.js";
import { DEFAULT_TENANT_ID, type UserRole } from "../tenants/types.js";
import {
  clearPersistedScans,
  getActiveDataBackend,
  getPersistedScanForTenant,
  listPersistedScansForTenant,
  persistScanRecord,
} from "../storage/backend.js";

export type ScanFindingsSummary = Pick<
  ScanResultSummary,
  "totalFindings" | "critical" | "high" | "medium" | "low"
>;

/** 스캔 레코드 인터페이스 */
export interface ScanRecord {
  id: string;
  /** 소속 테넌트(조직) ID */
  tenantId: string;
  engine: ScanEngineType;
  repoUrl: string;
  branch: string;
  status: ScanStatus;
  createdAt: string;
  completedAt?: string;
  retryCount: number;
  lastError?: string;
  lastErrorCode?: ScanErrorCode;
  findings?: ScanFindingsSummary;
}

/** 인메모리 스캔 저장소 */
const scanStore = new Map<string, ScanRecord>();

/** 스캔 생성 파라미터 */
interface CreateScanParams {
  engine: ScanEngineType;
  repoUrl: string;
  branch: string;
  /** 소속 테넌트 ID (미전달 시 DEFAULT_TENANT_ID 적용) */
  tenantId?: string;
}

function cloneScanRecord(record: ScanRecord): ScanRecord {
  return {
    ...record,
    findings: record.findings ? { ...record.findings } : undefined,
  };
}

/**
 * 새로운 스캔 레코드를 생성하고 저장소에 저장합니다.
 */
export function createScan(params: CreateScanParams): ScanRecord {
  const id = randomUUID();
  const normalizedTenantId = params.tenantId?.trim();

  const record: ScanRecord = {
    id,
    tenantId:
      normalizedTenantId && normalizedTenantId.length > 0
        ? normalizedTenantId
        : DEFAULT_TENANT_ID,
    engine: params.engine,
    repoUrl: params.repoUrl,
    branch: params.branch,
    status: "queued",
    createdAt: new Date().toISOString(),
    retryCount: 0,
  };
  scanStore.set(id, record);
  persistScanRecord(record);
  return record;
}

/**
 * ID로 단일 스캔 레코드를 조회합니다. 없으면 undefined를 반환합니다.
 */
export function getScan(id: string): ScanRecord | undefined {
  return scanStore.get(id);
}

/** listScans 필터 옵션 */
interface ListScansFilter {
  status?: ScanStatus;
  /** 테넌트 ID 필터 (미전달 시 전체 반환) */
  tenantId?: string;
}

/**
 * 전체 스캔 목록을 반환합니다. 필터가 주어지면 해당 조건만 반환합니다.
 */
export function listScans(filter?: ListScansFilter): ScanRecord[] {
  let all = Array.from(scanStore.values());
  if (filter?.tenantId) {
    all = all.filter((r) => r.tenantId === filter.tenantId);
  }
  if (filter?.status) {
    all = all.filter((r) => r.status === filter.status);
  }
  return all;
}

interface TenantScopedScanReadOptions {
  tenantId: string;
  userId?: string;
  userRole?: UserRole;
}

/**
 * 요청 경로 read 최적화:
 * - DATA_BACKEND=postgres일 때 tenant-scoped direct query를 우선 사용
 * - 그 외(memory 포함)는 기존 인메모리 스토어를 사용
 */
export async function listScansForTenantReadPath(
  filter: TenantScopedScanReadOptions & { status?: ScanStatus }
): Promise<ScanRecord[]> {
  if (getActiveDataBackend() === "postgres") {
    const persistedScans = await listPersistedScansForTenant({
      tenantId: filter.tenantId,
      status: filter.status,
      userId: filter.userId,
      userRole: filter.userRole,
    });

    if (persistedScans) {
      return persistedScans;
    }
  }

  return listScans({
    tenantId: filter.tenantId,
    status: filter.status,
  });
}

/**
 * 요청 경로 read 최적화:
 * - DATA_BACKEND=postgres일 때 tenant-scoped direct query를 우선 사용
 * - 그 외(memory 포함)는 기존 인메모리 스토어를 사용
 */
export async function getScanForTenantReadPath(
  params: TenantScopedScanReadOptions & { id: string }
): Promise<ScanRecord | undefined> {
  if (getActiveDataBackend() === "postgres") {
    const persistedScan = await getPersistedScanForTenant({
      scanId: params.id,
      tenantId: params.tenantId,
      userId: params.userId,
      userRole: params.userRole,
    });

    if (persistedScan !== null) {
      return persistedScan;
    }
  }

  const scan = getScan(params.id);
  if (!scan || scan.tenantId !== params.tenantId) {
    return undefined;
  }

  return scan;
}

/**
 * 스캔 상태를 업데이트합니다.
 * - completed/failed 상태로 전이되면 completedAt을 현재 시각으로 기록합니다.
 */
export function updateScanStatus(id: string, status: ScanStatus): ScanRecord | undefined {
  const current = scanStore.get(id);
  if (!current) {
    return undefined;
  }

  const next: ScanRecord = {
    ...current,
    status,
  };

  if (status === "completed" || status === "failed") {
    next.completedAt = new Date().toISOString();
  } else {
    delete next.completedAt;
  }

  scanStore.set(id, next);
  persistScanRecord(next);
  return next;
}

/** 스캔 실행 메타데이터(재시도/오류/findings)를 업데이트합니다. */
export function updateScanMeta(
  id: string,
  patch: {
    retryCount?: number;
    lastError?: string | null;
    lastErrorCode?: ScanErrorCode | null;
    findings?: ScanFindingsSummary | null;
  }
): ScanRecord | undefined {
  const current = scanStore.get(id);
  if (!current) {
    return undefined;
  }

  const next: ScanRecord = {
    ...current,
  };

  if (patch.retryCount !== undefined) {
    next.retryCount = patch.retryCount;
  }

  if (patch.lastError === null) {
    delete next.lastError;
  } else if (patch.lastError !== undefined) {
    next.lastError = patch.lastError;
  }

  if (patch.lastErrorCode === null) {
    delete next.lastErrorCode;
  } else if (patch.lastErrorCode !== undefined) {
    next.lastErrorCode = patch.lastErrorCode;
  }

  if (patch.findings === null) {
    delete next.findings;
  } else if (patch.findings !== undefined) {
    next.findings = patch.findings;
  }

  scanStore.set(id, next);
  persistScanRecord(next);
  return next;
}

/**
 * 앱 시작 시점에 외부 저장소에서 읽어온 스캔 레코드로 인메모리 스토어를 채웁니다.
 */
export function hydrateScanStore(records: ScanRecord[]): void {
  scanStore.clear();

  for (const record of records) {
    scanStore.set(record.id, cloneScanRecord(record));
  }
}

/**
 * 저장소를 초기화합니다. 테스트 전 상태 리셋 용도로만 사용합니다.
 */
export function clearStore(): void {
  scanStore.clear();
  clearPersistedScans();
}
