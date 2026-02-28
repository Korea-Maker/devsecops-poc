import type {
  CheckRunResult,
  CreateCheckRunParams,
  UpdateCheckRunParams,
} from './types.js';

/**
 * GitHub API 클라이언트 인터페이스.
 * 실제 GitHub App 인증 클라이언트와 Mock 구현 모두 이 계약을 따른다.
 */
export interface GitHubClient {
  /**
   * Check Run을 생성합니다.
   * @param owner - 저장소 소유자 (org 또는 유저명)
   * @param repo - 저장소명
   * @param params - Check Run 생성 파라미터
   */
  createCheckRun(
    owner: string,
    repo: string,
    params: CreateCheckRunParams
  ): Promise<CheckRunResult>;

  /**
   * 기존 Check Run을 업데이트합니다.
   * @param owner - 저장소 소유자
   * @param repo - 저장소명
   * @param checkRunId - 업데이트할 Check Run ID
   * @param params - 업데이트 파라미터
   */
  updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    params: UpdateCheckRunParams
  ): Promise<void>;

  /**
   * Pull Request에 댓글을 작성합니다.
   * @param owner - 저장소 소유자
   * @param repo - 저장소명
   * @param prNumber - PR 번호
   * @param body - 댓글 본문
   */
  createPRComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<void>;

  /**
   * Webhook 시그니처를 검증합니다.
   * @param payload - 원본 요청 바디 (raw bytes or string)
   * @param signature - x-hub-signature-256 헤더 값
   */
  verifyWebhookSignature(payload: string | Buffer, signature: string): boolean;
}
