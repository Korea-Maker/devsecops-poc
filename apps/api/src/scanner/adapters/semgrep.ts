import type { ScanAdapter, ScanRequest, ScanResultSummary } from '../types.js';

/** Semgrep SAST 어댑터 (TODO: 실제 구현 예정) */
export class SemgrepAdapter implements ScanAdapter {
  readonly engine = 'semgrep' as const;

  async scan(_request: ScanRequest): Promise<ScanResultSummary> {
    // TODO: Semgrep CLI 연동 구현
    throw new Error('TODO: Semgrep 어댑터 미구현');
  }
}
