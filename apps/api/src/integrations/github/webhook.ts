import { createHmac, timingSafeEqual } from 'crypto';
import type { ScanEngineType } from '../../scanner/types.js';
import type {
  GitHubPullRequestEvent,
  GitHubPushEvent,
  GitHubWebhookEvent,
} from './types.js';

/** 지원하는 모든 스캔 엔진 목록 */
const ALL_ENGINES: ScanEngineType[] = ['semgrep', 'trivy', 'gitleaks'];

/**
 * x-hub-signature-256 헤더를 사용하여 HMAC-SHA256 webhook 시그니처를 검증합니다.
 * timingSafeEqual을 사용하여 타이밍 공격을 방지합니다.
 *
 * @param secret - GITHUB_WEBHOOK_SECRET 환경변수 값
 * @param rawBody - 수신한 원본 요청 바디 (Buffer)
 * @param signatureHeader - x-hub-signature-256 헤더 값 ("sha256=..." 형식)
 * @returns 시그니처 일치 여부
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string
): boolean {
  if (!signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const receivedHex = signatureHeader.slice('sha256='.length);
  const expectedHex = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    return timingSafeEqual(
      Buffer.from(receivedHex, 'hex'),
      Buffer.from(expectedHex, 'hex')
    );
  } catch {
    // 길이 불일치 등으로 timingSafeEqual이 throw하면 false 반환
    return false;
  }
}

/**
 * webhook 헤더와 바디를 파싱하여 이벤트 타입과 페이로드를 반환합니다.
 *
 * @param eventName - x-github-event 헤더 값
 * @param body - 파싱된 요청 바디 객체
 */
export function parseWebhookEvent(
  eventName: string,
  body: unknown
): GitHubWebhookEvent {
  if (eventName === 'push') {
    return { type: 'push', payload: body as GitHubPushEvent };
  }

  if (eventName === 'pull_request') {
    return { type: 'pull_request', payload: body as GitHubPullRequestEvent };
  }

  return { type: 'unsupported', eventName };
}

/** 스캔 트리거 정보 */
export interface ScanTrigger {
  repoUrl: string;
  branch: string;
  engines: ScanEngineType[];
}

/**
 * webhook 이벤트에서 스캔 트리거 정보를 추출합니다.
 * - push: repository.clone_url + ref에서 branch 추출
 * - pull_request (opened, synchronize): repository.clone_url + pull_request.head.ref
 * - 그 외: null 반환 (스캔 불필요)
 *
 * @param event - parseWebhookEvent의 반환값
 * @returns 스캔 트리거 정보 또는 null
 */
export function extractScanTrigger(event: GitHubWebhookEvent): ScanTrigger | null {
  if (event.type === 'push') {
    const { repository, ref } = event.payload;
    // "refs/heads/main" → "main"
    const branch = ref.startsWith('refs/heads/')
      ? ref.slice('refs/heads/'.length)
      : ref;

    return {
      repoUrl: repository.clone_url,
      branch,
      engines: ALL_ENGINES,
    };
  }

  if (event.type === 'pull_request') {
    const { action, pull_request, repository } = event.payload;
    // opened, synchronize 이벤트에서만 스캔 트리거
    if (action !== 'opened' && action !== 'synchronize') {
      return null;
    }

    return {
      repoUrl: repository.clone_url,
      branch: pull_request.head.ref,
      engines: ALL_ENGINES,
    };
  }

  return null;
}
