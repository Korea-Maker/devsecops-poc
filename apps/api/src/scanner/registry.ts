import type { ScanAdapter, ScanEngineType } from './types.js';
import { SemgrepAdapter } from './adapters/semgrep.js';
import { TrivyAdapter } from './adapters/trivy.js';
import { GitleaksAdapter } from './adapters/gitleaks.js';

/** 스캔 엔진 어댑터 레지스트리 */
const adapters = new Map<ScanEngineType, ScanAdapter>([
  ['semgrep', new SemgrepAdapter()],
  ['trivy', new TrivyAdapter()],
  ['gitleaks', new GitleaksAdapter()],
]);

/** 엔진 타입으로 어댑터를 조회한다 */
export function getAdapter(engine: ScanEngineType): ScanAdapter {
  const adapter = adapters.get(engine);
  if (!adapter) {
    throw new Error(`지원하지 않는 스캔 엔진: ${engine}`);
  }
  return adapter;
}

/** 등록된 모든 엔진 목록을 반환한다 */
export function listEngines(): ScanEngineType[] {
  return [...adapters.keys()];
}
