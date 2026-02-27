/** 지원하는 스캔 엔진 타입 */
export type ScanEngineType = 'semgrep' | 'trivy' | 'gitleaks';

/** 스캔 상태 */
export type ScanStatus = 'queued' | 'running' | 'completed' | 'failed';

/** 스캔 실행/소스 준비 과정에서 노출되는 오류 코드 */
export type ScanErrorCode =
  | 'SOURCE_PREP_CLONE_FAILED'
  | 'SOURCE_PREP_UNSUPPORTED_REPO_URL'
  | 'SCAN_EXECUTION_FAILED'
  | 'SCAN_UNKNOWN_ERROR';

/** 스캔 요청 */
export interface ScanRequest {
  id: string;
  engine: ScanEngineType;
  repoUrl: string;
  branch: string;
  status: ScanStatus;
  createdAt: Date;
}

/** 스캔 결과 요약 */
export interface ScanResultSummary {
  scanId: string;
  engine: ScanEngineType;
  totalFindings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  completedAt: Date;
}

/** 스캔 어댑터 인터페이스 - 각 엔진이 구현해야 하는 공통 계약 */
export interface ScanAdapter {
  readonly engine: ScanEngineType;
  scan(request: ScanRequest): Promise<ScanResultSummary>;
}
