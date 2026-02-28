import type { GitHubClient } from './client.js';
import type {
  CheckRunResult,
  CreateCheckRunParams,
  UpdateCheckRunParams,
} from './types.js';

/** Mock 클라이언트 호출 기록 항목 */
export interface MockCallRecord {
  method: string;
  args: unknown[];
  calledAt: string;
}

/**
 * 테스트 및 개발 환경용 MockGitHubClient.
 * 모든 메서드는 deterministic 결과를 반환하고 호출 기록을 저장한다.
 */
export class MockGitHubClient implements GitHubClient {
  /** 호출 기록 (테스트 검증용) */
  readonly calls: MockCallRecord[] = [];

  /** Check Run ID 카운터 (1부터 증가) */
  private nextCheckRunId = 1;

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args, calledAt: new Date().toISOString() });
  }

  async createCheckRun(
    owner: string,
    repo: string,
    params: CreateCheckRunParams
  ): Promise<CheckRunResult> {
    this.record('createCheckRun', [owner, repo, params]);
    const id = this.nextCheckRunId++;
    return {
      id,
      url: `https://api.github.com/repos/${owner}/${repo}/check-runs/${id}`,
    };
  }

  async updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    params: UpdateCheckRunParams
  ): Promise<void> {
    this.record('updateCheckRun', [owner, repo, checkRunId, params]);
  }

  async createPRComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<void> {
    this.record('createPRComment', [owner, repo, prNumber, body]);
  }

  /**
   * Mock 구현: 항상 true를 반환합니다.
   * 실제 시그니처 검증은 webhook.ts의 verifySignature에서 처리합니다.
   */
  verifyWebhookSignature(_payload: string | Buffer, _signature: string): boolean {
    this.record('verifyWebhookSignature', [_signature]);
    return true;
  }

  /** 테스트 격리용: 호출 기록과 카운터를 초기화합니다. */
  reset(): void {
    this.calls.length = 0;
    this.nextCheckRunId = 1;
  }
}
