/** 지원하는 스캔 엔진 타입 */
export type ScanEngineType = 'semgrep' | 'trivy' | 'gitleaks';

/** 스캔 상태 */
export type ScanStatus = 'queued' | 'running' | 'completed' | 'failed';

/** 스캔 오류 코드 */
export type ScanErrorCode =
  | 'SOURCE_PREP_CLONE_FAILED'
  | 'SOURCE_PREP_UNSUPPORTED_REPO_URL'
  | 'SCAN_EXECUTION_FAILED'
  | 'SCAN_UNKNOWN_ERROR';

/** findings 요약 */
export interface ScanFindingsSummary {
  totalFindings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** 스캔 레코드 */
export interface ScanRecord {
  id: string;
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

/** 큐 상태 */
export interface QueueStatus {
  queuedJobs: number;
  deadLetters: number;
  pendingRetryTimers: number;
  workerRunning: boolean;
  processing: boolean;
}

/** dead-letter 항목 */
export interface DeadLetterItem {
  scanId: string;
  retryCount: number;
  error: string;
  errorCode?: string;
  failedAt: string;
}
