import { randomUUID } from "crypto";
import type { ScanEngineType, ScanStatus } from "./types.js";

/** 스캔 레코드 인터페이스 */
export interface ScanRecord {
  id: string;
  engine: ScanEngineType;
  repoUrl: string;
  branch: string;
  status: ScanStatus;
  createdAt: string;
  completedAt?: string;
}

/** 인메모리 스캔 저장소 */
const scanStore = new Map<string, ScanRecord>();

/** 스캔 생성 파라미터 */
interface CreateScanParams {
  engine: ScanEngineType;
  repoUrl: string;
  branch: string;
}

/**
 * 새로운 스캔 레코드를 생성하고 저장소에 저장합니다.
 */
export function createScan(params: CreateScanParams): ScanRecord {
  const id = randomUUID();
  const record: ScanRecord = {
    id,
    engine: params.engine,
    repoUrl: params.repoUrl,
    branch: params.branch,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  scanStore.set(id, record);
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
}

/**
 * 전체 스캔 목록을 반환합니다. status 필터가 주어지면 해당 상태만 반환합니다.
 */
export function listScans(filter?: ListScansFilter): ScanRecord[] {
  const all = Array.from(scanStore.values());
  if (filter?.status) {
    return all.filter((r) => r.status === filter.status);
  }
  return all;
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
  return next;
}

/**
 * 저장소를 초기화합니다. 테스트 전 상태 리셋 용도로만 사용합니다.
 */
export function clearStore(): void {
  scanStore.clear();
}
