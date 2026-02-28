/** GitHub App 클라이언트 설정 */
export interface GitHubClientConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  installationId: string;
}

/** GitHub webhook push 이벤트 페이로드 */
export interface GitHubPushEvent {
  ref: string; // 예: "refs/heads/main"
  repository: {
    clone_url: string;
    full_name: string;
  };
  pusher: {
    name: string;
  };
}

/** GitHub Pull Request 정보 */
export interface GitHubPullRequest {
  number: number;
  head: {
    ref: string; // 브랜치명
    sha: string;
  };
  base: {
    ref: string;
  };
  html_url: string;
}

/** GitHub webhook pull_request 이벤트 페이로드 */
export interface GitHubPullRequestEvent {
  action: string; // "opened" | "synchronize" | "closed" 등
  pull_request: GitHubPullRequest;
  repository: {
    clone_url: string;
    full_name: string;
  };
}

/** GitHub webhook 이벤트 (push 또는 pull_request) */
export type GitHubWebhookEvent =
  | { type: 'push'; payload: GitHubPushEvent }
  | { type: 'pull_request'; payload: GitHubPullRequestEvent }
  | { type: 'unsupported'; eventName: string };

/** GitHub Check Run 상태 */
export type GitHubCheckRunStatus = 'queued' | 'in_progress' | 'completed';

/** GitHub Check Run 결론 */
export type GitHubCheckRunConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'action_required';

/** Check Run 생성 파라미터 */
export interface CreateCheckRunParams {
  name: string;
  headSha: string;
  status: GitHubCheckRunStatus;
  conclusion?: GitHubCheckRunConclusion;
  output?: {
    title: string;
    summary: string;
  };
}

/** Check Run 업데이트 파라미터 */
export interface UpdateCheckRunParams {
  status: GitHubCheckRunStatus;
  conclusion?: GitHubCheckRunConclusion;
  output?: {
    title: string;
    summary: string;
  };
}

/** Check Run 생성 결과 */
export interface CheckRunResult {
  id: number;
  url: string;
}

/** PR 댓글 페이로드 */
export interface GitHubCommentPayload {
  body: string;
  pr_number: number;
}
