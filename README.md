# devsecops-poc

스타트업(초기 1~5명 팀)을 위한 **DevSecOps 플랫폼 PoC**.

## 프로젝트 요약

이 프로젝트는 보안 전담 인력이 없는 작은 개발팀이, 복잡한 설정 없이 보안 스캔을 CI 흐름에 붙일 수 있도록 만드는 PoC다.

- 핵심 가치: **가격(저비용) + 간편함(빠른 온보딩)**
- MVP 방향: **스캔 + 대시보드 + CI 연동**
- 초기 보안 범위: **SAST + SCA + Secret 탐지**

---

## Phase 1 고정 결정 (요약)

| 항목 | 결정 |
|---|---|
| 보안 범위 | SAST + SCA + Secret |
| 우선 가치 | 가격 + 간편함 |
| MVP 기능 | 스캔 + 대시보드 + CI 연동 |
| Backend | TypeScript + Fastify |
| Frontend | Next.js (App Router) |
| Database | PostgreSQL |
| CI 연동 | GitHub App |
| 초기 언어 지원 | JS/TS + Python |
| 타겟 팀 크기 | 1~5명 |
| 인증 | Google SSO |

상세 근거/리스크는 `docs/workflow/DECISIONS.md` 참고.

---

## 기술 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| Frontend | Next.js 15 + TypeScript | App Router 기반 |
| Backend | Fastify + TypeScript | PoC 속도/생산성 우선 |
| Database | PostgreSQL | docker-compose로 로컬 실행 |
| 패키지 매니저 | pnpm workspace | 모노레포 운영 |
| 테스트 | Vitest + Supertest | API 헬스체크 검증 |
| 인증(예정) | Google SSO | Phase 2+ 상세 구현 |
| CI 연동(예정) | GitHub App | GitHub 중심 팀 우선 |

> 성능 이슈가 발생하면 스캔 워커를 Go로 분리하는 옵션을 유지한다.

---

## 현재 구현 상태 (Phase 2-5 기준)

### API (`apps/api`)

- `GET /health` → `{ ok: true, service: "api" }`
- `GET /api/v1/auth/jwks` → 플랫폼 access token 검증용 공개 JWKS
- `GET /api/v1/auth/google/start` → OIDC state/nonce 생성 + Google authorize URL 반환
- `GET /api/v1/auth/google/callback` → state 검증 + code 교환 + Google id_token 검증 + membership 매핑 + 플랫폼 JWT 발급
- `POST /api/v1/scans` → 스캔 요청 생성 + 큐 적재 (`202 Accepted`)
  - `repoUrl` 입력 계약: 로컬 디렉터리 경로 또는 `http/https/ssh/file://`, `git@...` 형식 허용 (`ftp://` 등 미지원 스킴/빈 문자열은 거부)
  - 멀티테넌시 활성화 시 요청 tenant context(`x-tenant-id`)를 스캔 레코드에 저장
- `GET /api/v1/scans` → 스캔 목록 조회 (`status` 필터 지원)
  - 항상 요청 tenant 범위 내 스캔만 반환
- `GET /api/v1/scans/:id` → 단일 스캔 상태 조회 (완료 시 `findings` 요약 포함)
  - 다른 tenant 스캔이면 `404 SCAN_NOT_FOUND` 반환
  - 실패/재시도 상태에서는 `lastError`, `lastErrorCode` 확인 가능
- `GET /api/v1/scans/dead-letters` → dead-letter 목록 조회
  - `TENANT_AUTH_MODE=required`에서 `admin` 이상 권한 필요 + tenant 범위만 반환
- `POST /api/v1/scans/:id/redrive` → dead-letter 재처리 요청
  - `TENANT_AUTH_MODE=required`에서 `admin` 이상 권한 필요
- `GET /api/v1/scans/queue/status` → 큐 운영 상태 조회
  - 응답: `{ queuedJobs, deadLetters, pendingRetryTimers, workerRunning, processing }`
  - `TENANT_AUTH_MODE=required`에서 `admin` 이상 권한 필요 + tenant 필터 적용
- `POST /api/v1/scans/queue/process-next` → 워커와 별개로 즉시 다음 작업 1건 처리
  - `TENANT_AUTH_MODE=required`에서 `admin` 이상 권한 필요 + 요청 tenant 대기 작업만 처리
  - 응답: `{ processed: boolean, busy: boolean }`
    - `processed=false, busy=false`: 처리할 작업 없음(empty)
    - `processed=false, busy=true`: 같은 tenant 작업이 이미 처리 중(busy)

오류 응답 계약(scans 라우트):

- 공통 shape: `{ error: string, code?: string }`
- 예: `SCAN_INVALID_ENGINE`, `SCAN_INVALID_REPO_URL`, `SCAN_NOT_FOUND`, `DEAD_LETTER_NOT_FOUND`

멀티테넌시 인증/인가 계약 (`TENANT_AUTH_MODE` + `AUTH_MODE`):

- `TENANT_AUTH_MODE` 기본값: `disabled` (기존 동작 유지, 기본 tenant=`default`)
- `TENANT_AUTH_MODE=required`일 때 인증 소스는 `AUTH_MODE`로 선택
  - 기본값: `AUTH_MODE=header` (기존 헤더 계약과 완전 호환)
  - 선택값: `AUTH_MODE=jwt` (JWKS 서명 검증 구현)
- `AUTH_MODE=header` 계약:
  - `x-tenant-id` (선택, 미전달 시 `default` 사용)
  - `x-user-id` (필수)
  - `x-user-role` (필수, `owner | admin | member | viewer`)
  - 누락/형식 오류 시 4xx + `{ error, code }`
- `AUTH_MODE=jwt` 계약:
  - `Authorization: Bearer <token>` 필수
  - `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_JWKS_URL` 필수 (`JWT_JWKS_URL`은 http/https URL)
  - JOSE 기반 remote JWKS 검증 + `iss`/`aud` + 서명 알고리즘(`RS256 | ES256`) 검증
  - claim 매핑(모두 required):
    - tenantId: `tenant_id` (fallback: `tid`)
    - userId: `sub` (fallback: `user_id`)
    - role: `role` (fallback: `roles[0]`) — `owner | admin | member | viewer`
  - 검증/클레임 실패 시 401 + `{ error, code }`
- queue/dead-letter 수동 운영 API(`queue/status`, `queue/process-next`, `dead-letters`, `redrive`)는 `admin` 이상(role hierarchy: `owner > admin > member > viewer`)만 접근 가능

OIDC 로그인 + 플랫폼 토큰 발급 계약:

- `google/start` 응답(JSON)에서 `authorizationUrl`, `state`를 받고 사용자 브라우저를 Google 로그인으로 이동
- Google callback(`code`, `state`)을 API가 처리해 자체 플랫폼 JWT(access token) 반환
- membership 매핑 규칙:
  - 1차: Google `sub`로 membership 조회
  - fallback: `sub` 미매칭 + `email` 존재 시 `email`로 조회
  - 0개: `403 AUTH_MEMBERSHIP_NOT_FOUND`
  - 1개: 해당 tenant 사용
  - 2개 이상: `tenantId` query 필수 (`AUTH_TENANT_ID_REQUIRED`)
- 플랫폼 JWT 클레임:
  - `tenant_id`, `sub`(membership user id), `role`, `iss`, `aud`, `exp`
- 플랫폼 서명 키:
  - `PLATFORM_JWT_PRIVATE_KEY_PEM` + `PLATFORM_JWT_PUBLIC_KEY_PEM` 설정 시 해당 키 사용
  - 키가 없거나 불완전하면 부팅 시 임시 RS256 키 생성(경고 로그 출력, 재시작 시 기존 토큰 무효화)

스캔 워커 동작:

- 기본 실행 모드: `SCAN_EXECUTION_MODE=mock` (미설정/비정상 값 포함)
- `mock` 모드: 엔진별 deterministic 결과 반환
- `native` 모드 소스 준비 정책:
  - 로컬 경로(`repoUrl`이 실제 디렉터리)면 해당 경로를 그대로 스캔
  - 원격 저장소 URL(`http/https/ssh/git@/file://`)이면 스캔 전 임시 디렉터리에 `git clone --depth 1 --branch <branch>` 수행
  - 어댑터에는 clone된 로컬 경로를 전달해 CLI를 실행하고, 처리 성공/실패와 무관하게 임시 clone 정리(cleanup)
- 실패 처리: retry + exponential backoff + dead-letter 지원
- retry timer 운영:
  - retry 스케줄(`scanId`, `dueAt`)을 queue snapshot에 함께 저장
  - startup hydration 시 `dueAt <= now`는 즉시 queue 재적재, 미래 시점은 남은 delay로 타이머 재설정
  - 중복 스냅샷/중복 enqueue를 방지하도록 scanId 기준으로 멱등 복구
- 워커 종료 정책:
  - 일반 stop: `stopScanWorker()`는 pending retry timer를 취소해 stop 이후 예기치 않은 재enqueue를 방지
  - 프로세스 shutdown: `stopScanWorkerAndDrain()`는 pending retry를 queue로 materialize하고 in-flight 처리 종료까지 대기

데이터 저장 백엔드:

- `DATA_BACKEND`: `memory | postgres` (기본값 `memory`)
- `DATA_BACKEND=postgres` + `DATABASE_URL` 설정 시 다음 엔티티를 PostgreSQL에 영속화
  - scans (`retryCount`, `lastError`, `lastErrorCode`, `findings` 포함)
  - scan queue jobs (FIFO 순서 보존)
  - scan dead-letter items
  - scan retry schedules (`scanId`, `dueAt`)
  - organizations (`active`, `disabledAt` 포함)
  - memberships
  - organization invite tokens (`role`, `email`, `expiresAt`, `consumedAt` 포함)
  - tenant audit logs
- 서버 시작 시 경량 migration 버저닝(`schema_migrations`)을 기준으로 schema를 순차/멱등 적용
- 서버 시작 시 PostgreSQL 데이터로 인메모리 스토어(scans/queue/dead-letter/retry schedule/org/membership/invite token/audit log)를 hydrate
- queue/dead-letter/retry snapshot 저장은 단일 PostgreSQL transaction(`BEGIN/COMMIT`)으로 수행되어 교체 중간 상태 노출을 방지
- 비정상 종료로 `running`에 멈춘 스캔은 startup recovery에서 `queued`로 전환 + queue 재적재 후 자동 재개
- 비정상 종료 시 retry timer 대기 작업은 startup recovery에서 즉시 재적재 또는 남은 backoff로 재타이머링
- `TENANT_AUDIT_LOG_RETENTION_DAYS`가 설정되면 startup 시점에 오래된 tenant audit log를 선제 prune 후 hydrate
- `TENANT_RLS_MODE`: `off | shadow | enforce` (기본값 `off`)
  - `off`: 기존 동작 유지 (대상 테이블 RLS DISABLE)
  - `shadow`: tenant session context 주입만 수행하고 RLS 강제는 비활성
  - `enforce`: tenant 대상 테이블(`scans`, `organizations`, `organization_memberships`, `organization_invite_tokens`, `tenant_audit_logs`)에 RLS `ENABLE + FORCE` 적용
  - startup/hydration·retention prune 같은 시스템 경로는 `service` 컨텍스트(`app.tenant_id='*'`)로 안전하게 실행

주요 스캔/테넌트 환경변수:

- `DATA_BACKEND`: `memory | postgres` (기본값 `memory`)
- `DATABASE_URL`: PostgreSQL 연결 문자열 (`DATA_BACKEND=postgres`일 때 필수)
- `TENANT_RLS_MODE`: `off | shadow | enforce` (기본값 `off`)
- `SCAN_EXECUTION_MODE`: `mock | native` (기본값 `mock`)
- `SCAN_RETRY_BACKOFF_BASE_MS`: 재시도 백오프 기준값(ms, 기본값 `100`)
- `SCAN_MAX_RETRIES`: 최대 재시도 횟수(기본값 `2`)
- `TENANT_AUTH_MODE`: `disabled | required` (기본값 `disabled`)
- `AUTH_MODE`: `header | jwt` (기본값 `header`, `TENANT_AUTH_MODE=required`일 때 적용)
- `TENANT_AUDIT_LOG_RETENTION_DAYS`: tenant 감사 로그 보존 기간(일). 미설정/0/음수/비정수면 비활성화(하위호환)
- `JWT_ISSUER`: JWT issuer (`AUTH_MODE=jwt`에서 필수)
- `JWT_AUDIENCE`: JWT audience (`AUTH_MODE=jwt`에서 필수)
- `JWT_JWKS_URL`: JWT JWKS endpoint (`AUTH_MODE=jwt`에서 필수, http/https)
- `OIDC_GOOGLE_CLIENT_ID`: Google OAuth client id (`/api/v1/auth/google/*`에서 필수)
- `OIDC_GOOGLE_CLIENT_SECRET`: Google OAuth client secret (`/api/v1/auth/google/*`에서 필수)
- `OIDC_GOOGLE_REDIRECT_URI`: Google OAuth redirect URI (`/api/v1/auth/google/*`에서 필수)
- `PLATFORM_JWT_PRIVATE_KEY_PEM`: 플랫폼 access token 서명 개인키(PEM)
- `PLATFORM_JWT_PUBLIC_KEY_PEM`: 플랫폼 access token 공개키(PEM, JWKS 노출용)
- `PLATFORM_JWT_KID`: 플랫폼 JWKS key id
- `PLATFORM_JWT_ISSUER`: 플랫폼 access token issuer (기본값 `https://devsecops.local`)
- `PLATFORM_JWT_AUDIENCE`: 플랫폼 access token audience (기본값 `devsecops-api`)
- `PLATFORM_JWT_ACCESS_TTL_SEC`: 플랫폼 access token 만료(초, 기본값 `3600`)

### 운영/관리 API 사용 예시

```bash
# 큐 상태 조회
curl -s http://localhost:3001/api/v1/scans/queue/status

# 대기 중인 다음 작업 1건 즉시 처리
curl -s -X POST http://localhost:3001/api/v1/scans/queue/process-next
```

### Tenant 관리 API (Phase 5 초안)

- `GET /api/v1/organizations?search=<text>&page=<n>&limit=<n>` → 조직 목록 조회
  - `search`는 `name/slug` 부분일치(대소문자 무시)
  - `page/limit`은 선택값이며, 생략 시 기존처럼 전체 목록 반환(하위호환)
  - `TENANT_AUTH_MODE=required`에서는 요청 tenant 1개 범위 내에서만 검색/페이지네이션
- `POST /api/v1/organizations` → 조직 생성 (`admin` 이상)
  - `required` 모드에서 생성자 owner 멤버십 자동 생성
- `GET /api/v1/organizations/:id` → 단일 조직 조회 (tenant scope 강제)
  - 조직 상태 필드 포함: `active: boolean`, `disabledAt?: string`
- `POST /api/v1/organizations/:id/disable` → 조직 soft disable (`admin` 이상)
- `GET /api/v1/organizations/:id/memberships?search=<text>&page=<n>&limit=<n>` → 조직 멤버십 조회 (`admin` 이상)
  - `search`는 `userId/role` 부분일치
  - `page/limit` 생략 시 기존처럼 전체 목록 반환
- `POST /api/v1/organizations/:id/memberships` → 조직 멤버 추가 (`admin` 이상)
- `PATCH /api/v1/organizations/:id/memberships/:userId` → 멤버 역할 수정 (`admin` 이상)
- `DELETE /api/v1/organizations/:id/memberships/:userId` → 조직 멤버 제거 (`admin` 이상)
  - 마지막 owner 삭제는 `409 TENANT_OWNER_MIN_REQUIRED`
- `POST /api/v1/organizations/:id/invite-tokens` → 조직 멤버 초대 토큰 생성 (`admin` 이상)
  - body: `{ role, email?, expiresInMinutes? }`
  - `expiresInMinutes` 기본값 60분, 허용 범위 5~10080분(7일)
- `POST /api/v1/organizations/invite-tokens/accept` → 초대 토큰 수락 후 멤버십 생성
  - body: `{ token, email?, userId? }`
  - `TENANT_AUTH_MODE=required`에서는 `x-tenant-id` scope와 토큰 organization이 일치해야 하며, userId는 인증 컨텍스트를 우선 사용
  - 토큰은 1회용(replay 방지), 만료 토큰은 `410 TENANT_INVITE_EXPIRED`
- `GET /api/v1/organizations/:id/audit-logs?limit=50&action=<...>&userId=<...>&since=<iso>&until=<iso>` → 조직 감사 로그 조회 (`admin` 이상)
  - `limit`: 1~100 정수(기본 50)
  - `action`: `organization.created | membership.created | membership.role_updated | membership.deleted`
  - `userId`: `actorUserId` 또는 `targetUserId`가 일치하는 로그만 반환
  - `since` / `until`: ISO8601 시간창 필터(`since <= until`)

비활성화된 조직에서는 멤버십 변경/초대 토큰 생성/수락 같은 쓰기 작업이 `409 TENANT_ORG_DISABLED`로 차단된다.
오류 응답 shape는 scans API와 동일하게 `{ error, code? }`를 사용한다.

### GitHub CI/CD 연동 (`apps/api` + GitHub Actions)

- `POST /api/v1/github/webhook` → GitHub webhook 수신 + 스캔 트리거 (`202 Accepted`)
  - 지원 이벤트: `push`, `pull_request (opened | synchronize)`
  - HMAC-SHA256 시그니처 검증 (timingSafeEqual 사용)
  - 각 이벤트마다 semgrep/trivy/gitleaks 3개 엔진 스캔 자동 생성
- `GET /api/v1/github/status` → GitHub 연동 상태 조회
  - 응답: `{ webhookConfigured, appIdConfigured, mockMode }`

**GitHub Actions 워크플로우:**
- `.github/workflows/ci.yml`: 모든 push/PR 시 린트/타입체크/테스트/빌드 실행
- `.github/workflows/security-scan.yml`: PR 시 semgrep/trivy/gitleaks 병렬 스캔
- `.github/workflows/deploy-staging.yml`: main push(및 수동 실행) 기준 staging 배포
  - verify 단계에서 API test/typecheck/build + Web typecheck/build 선검증
  - preflight에서 필수 secret/variable 누락 시 **실패 대신 skip** + Step Summary 안내
  - deploy webhook 호출 후 `infra/scripts/post-deploy-smoke-check.sh` 실행
  - smoke 통과 후 optional RLS canary(`infra/scripts/verify-rls-canary.sh`) 실행
    - `STAGING_RLS_CANARY_ENABLED=true` + 필수 env/secrets 완비 시 tenant 격리 검증 실패를 배포 실패로 처리
    - 미활성화/구성 누락 시 Step Summary에 사유를 남기고 **skip(exit 0)**
- `.github/workflows/deploy-production.yml`: `v*` tag push 또는 수동 실행(`confirm=DEPLOY_PROD`) 기준 production 배포
  - staging과 동일한 verify/preflight 계약 + 수동 실행 안전장치(confirm input)
  - 필수 구성 누락 시 **실패 대신 skip** + 명확한 사유 기록
- `.github/actions/devsecops-scan/action.yml`: Composite Action
  - 스캔 생성 (POST /api/v1/scans)
  - 폴링으로 완료 대기 (최대 5분, 10초 간격)
  - 결과를 GitHub Step Summary에 출력

**배포 워크플로우 시크릿/변수 계약:**
- Staging
  - required secrets: `STAGING_DEPLOY_WEBHOOK_URL`, `STAGING_DEPLOY_WEBHOOK_TOKEN`
  - required variables: `STAGING_SMOKE_API_HEALTH_URL`, `STAGING_SMOKE_WEB_HEALTH_URL`
  - optional canary secrets: `STAGING_RLS_CANARY_ALLOWED_HEADERS`, `STAGING_RLS_CANARY_DENIED_HEADERS`
  - optional canary variables: `STAGING_RLS_CANARY_ENABLED`, `STAGING_RLS_CANARY_API_BASE_URL`, `STAGING_RLS_CANARY_PROBE_PATH`, `STAGING_RLS_CANARY_EXPECT_ALLOWED_STATUS`, `STAGING_RLS_CANARY_EXPECT_DENIED_STATUSES`
- Production
  - secrets: `PRODUCTION_DEPLOY_WEBHOOK_URL`, `PRODUCTION_DEPLOY_WEBHOOK_TOKEN`
  - variables: `PRODUCTION_SMOKE_API_HEALTH_URL`, `PRODUCTION_SMOKE_WEB_HEALTH_URL`
- Smoke check 스크립트 계약(`infra/scripts/post-deploy-smoke-check.sh`)
  - required: `SMOKE_API_HEALTH_URL`, `SMOKE_WEB_HEALTH_URL`
  - optional: `SMOKE_TIMEOUT_SECONDS`, `SMOKE_RETRY_COUNT`, `SMOKE_RETRY_DELAY_SECONDS`
- RLS canary 스크립트 계약(`infra/scripts/verify-rls-canary.sh`, read-only GET probe)
  - enable gate: `RLS_CANARY_ENABLED=true`
  - required (enabled일 때): `RLS_CANARY_API_BASE_URL`, `RLS_CANARY_PROBE_PATH`, `RLS_CANARY_ALLOWED_HEADERS`, `RLS_CANARY_DENIED_HEADERS`
  - probe 권장값: tenant A 전용 read-only GET 경로 (예: `/api/v1/scans/<tenant-a-scan-id>`)
  - header 포맷: `Header: value|Header-2: value` (`Authorization: Bearer ...` 포함 가능)
  - optional: `RLS_CANARY_EXPECT_ALLOWED_STATUS`(기본 `200`), `RLS_CANARY_EXPECT_DENIED_STATUSES`(기본 `401,403,404`), `RLS_CANARY_TIMEOUT_SECONDS`

### PostgreSQL Tenant RLS enablement / rollback runbook (Ops MVP Phase K)

1. **기본 배포(안전값)**
   - `DATA_BACKEND=postgres`
   - `TENANT_RLS_MODE=off` (default)
2. **Shadow 프리뷰**
   - `TENANT_RLS_MODE=shadow`로 배포
   - 앱은 tenant DB session context(`app.tenant_id`, `app.user_id`, `app.user_role`)를 주입하지만, RLS 강제는 하지 않음
   - staging에서 `infra/scripts/verify-rls-canary.sh` 결과를 확인
3. **Enforce 전환**
   - `TENANT_RLS_MODE=enforce`로 배포
   - 앱 startup 시 대상 tenant 테이블에 `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` 적용
4. **즉시 롤백**
   - `TENANT_RLS_MODE=off`로 되돌린 뒤 재배포/재시작
   - 앱 startup 시 대상 테이블에 `NO FORCE + DISABLE ROW LEVEL SECURITY` 적용

권장 점검 SQL:

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname IN (
  'scans',
  'organizations',
  'organization_memberships',
  'organization_invite_tokens',
  'tenant_audit_logs'
)
ORDER BY relname;
```

**운영/실서비스 MVP complete 판정 조건(현재):**
- staging/prod 배포 워크플로우가 verify → preflight(skip-safe) → deploy → smoke 계약으로 동작
- staging 배포는 smoke 이후 optional RLS canary를 실행하고, 활성화+구성 완비 시 tenant 격리 mismatch를 실패로 처리
- canary 비활성화/구성 누락 시 CI를 깨지 않고 skip 사유를 Step Summary에 명시

**Webhook 환경변수:**
- `GITHUB_WEBHOOK_SECRET`: webhook 시그니처 검증 시크릿 (선택)
- `GITHUB_APP_ID`: GitHub App ID (미구현, 향후 예정)
- `DEVSECOPS_API_URL`: GitHub Actions에서 사용할 API 베이스 URL (예: `https://api.example.com`)

### Web (`apps/web`)

- **대시보드** (`/`) — 스캔 현황 요약, findings 통계, 큐 상태, 스캔 목록 (필터/정렬/검색)
- **스캔 상세** (`/scans/[id]`) — 메타 정보, 상태별 해결 가이드, findings severity, 오류 정보
- **리포트** (`/reports/[id]`) — 스캔 리포트 조회, HTML 다운로드, PDF 인쇄 안내

대시보드 기능:
- 5초 자동 새로고침
- 상태/엔진 필터, scanId/repoUrl 검색, createdAt 정렬
- URL querystring 유지 (`?filter=failed&engine=semgrep&sort=asc`)
- 반응형 디자인 (데스크톱 테이블 / 모바일 카드)

---

## 프로젝트 구조

```bash
devsecops-poc/
├── apps/
│   ├── api/                  # Fastify API (@devsecops/api)
│   └── web/                  # Next.js Web (@devsecops/web)
├── docs/workflow/
│   └── DECISIONS.md          # 고정 의사결정 + 리스크
├── docker-compose.yml        # local PostgreSQL
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .env.example
```

---

## 시작하기

```bash
pnpm install
cp .env.example .env
docker compose up -d

# API
pnpm --filter @devsecops/api dev

# Web
pnpm --filter @devsecops/web dev
```

기본 포트:
- Web: `http://localhost:3000`
- API: `http://localhost:3001`

---

## 검증 명령

```bash
pnpm --filter @devsecops/api test
pnpm --filter @devsecops/api typecheck
pnpm --filter @devsecops/web typecheck
pnpm --filter @devsecops/api build
pnpm --filter @devsecops/web build
```

---

## 현재 제약 사항

- **감사 로그 보존정책 기본값 비활성화**: 하위호환을 위해 `TENANT_AUDIT_LOG_RETENTION_DAYS`를 설정하지 않으면 감사 로그는 자동 삭제되지 않음
- **Mock 모드 기본**: `SCAN_EXECUTION_MODE=mock`이 기본값 — 실제 스캐너가 아닌 deterministic 더미 데이터 반환
- **인증 제한**: API OIDC callback + 플랫폼 JWT 발급은 구현되었지만, 웹 로그인 UX/세션 처리, 키 로테이션 자동화, IdP 운영 runbook은 후속 구현 필요
- **Tenant RLS는 opt-in preview 단계**: 기본값은 `TENANT_RLS_MODE=off`이며, `enforce`는 tenant 대상 영속화 테이블에 적용된다. queue/dead-letter/retry 운영 테이블은 서비스 전용 범위로 유지되고, startup/hydration·retention prune 경로는 `service` 컨텍스트로 동작한다.
- **GitHub App 미연동**: Check Run 생성, PR 댓글 등 GitHub API 기능 미구현 (Mock 모드, 향후 예정)
- **클라이언트 필터링**: 엔진 필터와 검색은 클라이언트사이드 처리 — 대량 데이터 시 성능 저하 가능
- **PDF 미지원**: 직접 PDF 생성 불가 — 브라우저 `Ctrl+P` 인쇄 기능으로 대체

---

## 문서

- `docs/workflow/DECISIONS.md`: 확정 의사결정 / 미결정 / 리스크
- `docs/architecture/AUTH_TRANSITION.md`: Header → JWT/OAuth 전환 경계/신뢰모델/롤아웃 계획
- `docs/architecture/TENANT_RLS_ROLLOUT.md`: PostgreSQL Tenant RLS 단계적 도입 설계(세션 변수/정책/롤백 포함)
- `docs/workflow/DEPLOYMENT.md`: staging/production 배포 전략, 체크리스트, 운영 가이드
- `docs/workflow/PHASE3_BACKLOG.md`: Phase 3 대시보드/리포팅 구현 기록
- `docs/workflow/PHASE4_BACKLOG.md`: Phase 4 GitHub CI/CD 연동 구현 기록
- `docs/workflow/PHASE5_BACKLOG.md`: Phase 5 멀티테넌시/인증 기반 구현 기록
- `CLAUDE.md`: 프로젝트 작업 규칙 및 검증 루틴
