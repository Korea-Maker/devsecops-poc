import type { ScanAdapter, ScanRequest, ScanResultSummary } from '../types.js';

/** Gitleaks Secret 탐지 어댑터 (TODO: 실제 구현 예정) */
export class GitleaksAdapter implements ScanAdapter {
  readonly engine = 'gitleaks' as const;

  async scan(_request: ScanRequest): Promise<ScanResultSummary> {
    // TODO: Gitleaks CLI 연동 구현
    throw new Error('TODO: Gitleaks 어댑터 미구현');
  }
}
