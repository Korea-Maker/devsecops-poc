import type { ScanRecord, QueueStatus, DeadLetterItem } from './types';

const API_BASE = '/api/v1';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** 스캔 목록 조회 */
export async function fetchScans(params?: { status?: string }): Promise<ScanRecord[]> {
  const url = new URL(`${API_BASE}/scans`, window.location.origin);
  if (params?.status) {
    url.searchParams.set('status', params.status);
  }
  return fetchJson<ScanRecord[]>(url.toString());
}

/** 단일 스캔 조회 */
export async function fetchScan(id: string): Promise<ScanRecord> {
  return fetchJson<ScanRecord>(`${API_BASE}/scans/${encodeURIComponent(id)}`);
}

/** 큐 상태 조회 */
export async function fetchQueueStatus(): Promise<QueueStatus> {
  return fetchJson<QueueStatus>(`${API_BASE}/scans/queue/status`);
}

/** dead-letter 목록 조회 */
export async function fetchDeadLetters(): Promise<DeadLetterItem[]> {
  return fetchJson<DeadLetterItem[]>(`${API_BASE}/scans/dead-letters`);
}
