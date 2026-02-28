# Phase 4: GitHub CI/CD 연동

## 목표

GitHub 워크플로우에서 DevSecOps 스캔을 자동으로 트리거하고, webhook을 통해 push/PR 이벤트에 반응하여 보안 스캔을 실행하는 CI 파이프라인을 구현한다.

---

## 체크리스트

- [x] GitHub webhook 타입 정의 (push, pull_request 이벤트)
- [x] GitHub 클라이언트 인터페이스 및 Mock 구현
- [x] Webhook 엔드포인트 (`POST /api/v1/github/webhook`)
- [x] HMAC-SHA256 시그니처 검증 (timingSafeEqual 사용)
- [x] webhook 이벤트 파싱 (push, pull_request)
- [x] 스캔 트리거 로직 (push → main branch, PR → head branch)
- [x] GitHub 연동 상태 조회 (`GET /api/v1/github/status`)
- [x] GitHub Actions CI 워크플로우 (lint/typecheck/test/build)
- [x] GitHub Actions 보안 스캔 워크플로우 (매트릭스 병렬 실행)
- [x] DevSecOps Composite Action (스캔 생성 + 폴링 + 결과 출력)
- [x] 통합 테스트 (webhook 시그니처, push/PR 이벤트, 상태 엔드포인트)

---

## 변경 파일 목록

### 신규 생성

| 파일 | 설명 |
|------|------|
| `apps/api/src/integrations/github/types.ts` | GitHub webhook 타입 (GitHubWebhookEvent, CheckRunParams 등) |
| `apps/api/src/integrations/github/client.ts` | GitHubClient 인터페이스 (createCheckRun, updateCheckRun, createPRComment) |
| `apps/api/src/integrations/github/mock-client.ts` | Mock 클라이언트 구현 (테스트용) |
| `apps/api/src/integrations/github/webhook.ts` | webhook 파싱/검증 (verifySignature, parseWebhookEvent, extractScanTrigger) |
| `apps/api/src/integrations/github/index.ts` | 모듈 export (타입 및 클래스) |
| `apps/api/src/routes/github.ts` | GitHub 라우트 플러그인 (POST webhook, GET status) |
| `.github/workflows/ci.yml` | CI 파이프라인 (lint/typecheck, test, build) |
| `.github/workflows/security-scan.yml` | 보안 스캔 워크플로우 (PR 시 semgrep/trivy/gitleaks 병렬 실행) |
| `.github/actions/devsecops-scan/action.yml` | Composite Action (스캔 생성, 폴링, 결과 출력) |
| `apps/api/tests/github-webhook.test.ts` | webhook 통합 테스트 (시그니처, push/PR 이벤트, 상태 엔드포인트) |
| `docs/workflow/PHASE4_BACKLOG.md` | 이 문서 |

### 수정

| 파일 | 변경 내용 |
|------|-----------|
| `apps/api/src/app.ts` | GitHub 라우트 플러그인 등록 (`app.register(githubRoutes)`) |
| `README.md` | Phase 4 GitHub CI/CD 섹션 추가, 환경변수 갱신 |

---

## 사용법

### Webhook 설정

#### 1. DevSecOps API 서버 실행

```bash
pnpm --filter @devsecops/api dev
```

기본 포트: `http://localhost:3001`

#### 2. Webhook 시크릿 설정 (선택)

환경변수로 `GITHUB_WEBHOOK_SECRET`을 설정하면 webhook 시그니처를 검증합니다.

```bash
export GITHUB_WEBHOOK_SECRET="your-secret"
```

미설정 시 시그니처 검증을 건너뜁니다 (로그 경고 기록).

#### 3. GitHub 저장소에서 webhook 설정

- Settings > Webhooks > Add webhook
- Payload URL: `https://your-api.example.com/api/v1/github/webhook`
- Content type: `application/json`
- Events: `push`, `pull_request`
- Secret: `GITHUB_WEBHOOK_SECRET` 값 (선택)

#### 4. 로컬 테스트 (curl 사용)

Push 이벤트 시뮬레이션:

```bash
BODY='{"ref":"refs/heads/main","repository":{"clone_url":"https://github.com/test/repo.git","full_name":"test/repo"},"pusher":{"name":"testuser"}}'
SECRET="your-secret"
SIGNATURE="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)"

curl -X POST http://localhost:3001/api/v1/github/webhook \
  -H "Content-Type: application/json" \
  -H "x-github-event: push" \
  -H "x-hub-signature-256: $SIGNATURE" \
  -d "$BODY"
```

응답 (202 Accepted):

```json
{
  "received": true,
  "scansTriggered": 3
}
```

Pull Request opened 이벤트 시뮬레이션:

```bash
BODY='{"action":"opened","pull_request":{"number":1,"head":{"ref":"feature/test","sha":"abc123"},"base":{"ref":"main"},"html_url":"https://github.com/test/repo/pull/1"},"repository":{"clone_url":"https://github.com/test/repo.git","full_name":"test/repo"}}'
SECRET="your-secret"
SIGNATURE="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)"

curl -X POST http://localhost:3001/api/v1/github/webhook \
  -H "Content-Type: application/json" \
  -H "x-github-event: pull_request" \
  -H "x-hub-signature-256: $SIGNATURE" \
  -d "$BODY"
```

### GitHub Actions 사용

#### 1. 저장소 시크릿 설정

GitHub Settings > Secrets and variables > Actions > New repository secret

- `DEVSECOPS_API_URL`: DevSecOps API 베이스 URL (예: `https://api.example.com`)
- `GITHUB_WEBHOOK_SECRET`: webhook 시크릿 (선택)
- `GITHUB_APP_ID`: GitHub App ID (선택, 향후 구현용)

#### 2. CI 워크플로우

`.github/workflows/ci.yml`은 모든 push/PR 시에 자동 실행됩니다.

- **Lint & Typecheck**: API + Web 타입 체크
- **Test**: API 단위 테스트 (Vitest)
- **Build**: 의존성 설치 후 API/Web 빌드

#### 3. 보안 스캔 워크플로우

`.github/workflows/security-scan.yml`은 PR 시에 자동 실행됩니다.

```yaml
jobs:
  security-scan:
    strategy:
      matrix:
        engine:
          - semgrep
          - trivy
          - gitleaks
    steps:
      - uses: ./.github/actions/devsecops-scan
        with:
          api-url: ${{ secrets.DEVSECOPS_API_URL }}
          engine: ${{ matrix.engine }}
```

각 엔진이 병렬로 실행되고, 한 엔진 실패해도 나머지는 계속 실행됩니다 (`fail-fast: false`).

#### 4. Composite Action 사용 예시

자체 워크플로우에서 DevSecOps Composite Action을 사용할 수 있습니다:

```yaml
- name: DevSecOps 보안 스캔
  uses: ./.github/actions/devsecops-scan
  with:
    api-url: https://api.example.com
    engine: semgrep
    repo-url: ${{ github.event.repository.clone_url }}
    branch: ${{ github.head_ref || github.ref_name }}
```

출력:

- `scan-id`: 생성된 스캔 ID
- `status`: 최종 상태 (`completed`, `failed`, `timeout`)

### 상태 확인 엔드포인트

```bash
curl http://localhost:3001/api/v1/github/status
```

응답:

```json
{
  "webhookConfigured": true,
  "appIdConfigured": false,
  "mockMode": true
}
```

| 필드 | 의미 |
|------|------|
| `webhookConfigured` | GITHUB_WEBHOOK_SECRET 설정 여부 |
| `appIdConfigured` | GITHUB_APP_ID 설정 여부 |
| `mockMode` | GITHUB_APP_ID 미설정 시 true (실제 GitHub API 미사용) |

---

## 환경변수

### 필수

| 변수 | 설명 | 예시 |
|------|------|------|
| `GITHUB_WEBHOOK_SECRET` | webhook 시그니처 검증 시크릿 (선택) | `sk-github-webhook-abc123` |
| `GITHUB_APP_ID` | GitHub App ID (미구현, 향후 예정) | `123456` |
| `DEVSECOPS_API_URL` | DevSecOps API 베이스 URL (GitHub Actions) | `https://api.example.com` |

---

## 리스크 및 제약

| 항목 | 설명 |
|------|------|
| GitHub App 미구현 | Check Run 생성, PR 댓글 등은 아직 미구현. Mock 모드 기본값 |
| Webhook 폴링 | Action에서 10초 간격, 최대 5분 대기. 초장시간 스캔은 타임아웃 가능 |
| 환경변수 의존 | 로컬 테스트 시 GITHUB_WEBHOOK_SECRET 설정 필요 (선택) |
| PR 댓글 미지원 | 향후 GitHub App 구현 후 findings 결과를 PR 댓글로 전달 예정 |
| 스캔 결과 저장소 미연동 | 현재 인메모리 스토어 — 서버 재시작 시 스캔 결과 소실 |
| Mock 모드 기본값 | 실제 GitHub API 호출 없음. GITHUB_APP_ID 설정 후 `native` 모드로 전환 |

---

## 검증 명령

```bash
# 통합 테스트 실행
pnpm --filter @devsecops/api test

# 타입 체크
pnpm --filter @devsecops/api typecheck

# 빌드 검증
pnpm --filter @devsecops/api build
```

---

## 알려진 한계

- **GitHub App 인증**: 실제 Check Run 생성/업데이트, PR 댓글 기능은 아직 미구현
- **실시간 알림**: webhook 수신 후 스캔 완료까지의 대기 시간이 길 수 있음
- **Multi-repo 지원**: 현재 하나의 API 서버로 다중 저장소 webhook을 처리하지만, 복잡한 조직 구조에서는 제약이 있을 수 있음
