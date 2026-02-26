import type { ScanAdapter, ScanRequest, ScanResultSummary } from '../types.js';

/** Trivy SCA 어댑터 (TODO: 실제 구현 예정) */
export class TrivyAdapter implements ScanAdapter {
  readonly engine = 'trivy' as const;

  async scan(_request: ScanRequest): Promise<ScanResultSummary> {
    // TODO: Trivy CLI 연동 구현
    throw new Error('TODO: Trivy 어댑터 미구현');
  }
}
