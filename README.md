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

스캔 워커 동작:

- 기본 실행 모드: `SCAN_EXECUTION_MODE=mock` (미설정/비정상 값 포함)
- `mock` 모드: 엔진별 deterministic 결과 반환
- `native` 모드 소스 준비 정책:
  - 로컬 경로(`repoUrl`이 실제 디렉터리)면 해당 경로를 그대로 스캔
  - 원격 저장소 URL(`http/https/ssh/git@/file://`)이면 스캔 전 임시 디렉터리에 `git clone --depth 1 --branch <branch>` 수행
  - 어댑터에는 clone된 로컬 경로를 전달해 CLI를 실행하고, 처리 성공/실패와 무관하게 임시 clone 정리(cleanup)
- 실패 처리: retry + exponential backoff + dead-letter 지원
- 워커 종료 정책:
  - 일반 stop: `stopScanWorker()`는 pending retry timer를 취소해 stop 이후 예기치 않은 재enqueue를 방지
  - 프로세스 shutdown: `stopScanWorkerAndDrain()`는 pending retry를 queue로 materialize하고 in-flight 처리 종료까지 대기

데이터 저장 백엔드:

- `DATA_BACKEND`: `memory | postgres` (기본값 `memory`)
- `DATA_BACKEND=postgres` + `DATABASE_URL` 설정 시 다음 엔티티를 PostgreSQL에 영속화
  - scans (`retryCount`, `lastError`, `lastErrorCode`, `findings` 포함)
  - scan queue jobs (FIFO 순서 보존)
  - scan dead-letter items
  - organizations
  - memberships
  - tenant audit logs
- 서버 시작 시 PostgreSQL 데이터로 인메모리 스토어(scans/queue/dead-letter/org/membership/audit log)를 hydrate
- 테이블이 없어도 자동 bootstrap SQL(`CREATE TABLE IF NOT EXISTS`)을 실행해 안전하게 기동

주요 스캔/테넌트 환경변수:

- `DATA_BACKEND`: `memory | postgres` (기본값 `memory`)
- `DATABASE_URL`: PostgreSQL 연결 문자열 (`DATA_BACKEND=postgres`일 때 필수)
- `SCAN_EXECUTION_MODE`: `mock | native` (기본값 `mock`)
- `SCAN_RETRY_BACKOFF_BASE_MS`: 재시도 백오프 기준값(ms, 기본값 `100`)
- `SCAN_MAX_RETRIES`: 최대 재시도 횟수(기본값 `2`)
- `TENANT_AUTH_MODE`: `disabled | required` (기본값 `disabled`)
- `AUTH_MODE`: `header | jwt` (기본값 `header`, `TENANT_AUTH_MODE=required`일 때 적용)
- `JWT_ISSUER`: JWT issuer (`AUTH_MODE=jwt`에서 필수)
- `JWT_AUDIENCE`: JWT audience (`AUTH_MODE=jwt`에서 필수)
- `JWT_JWKS_URL`: JWT JWKS endpoint (`AUTH_MODE=jwt`에서 필수, http/https)

### 운영/관리 API 사용 예시

```bash
# 큐 상태 조회
curl -s http://localhost:3001/api/v1/scans/queue/status

# 대기 중인 다음 작업 1건 즉시 처리
curl -s -X POST http://localhost:3001/api/v1/scans/queue/process-next
```

### Tenant 관리 API (Phase 5 초안)

- `GET /api/v1/organizations` → 조직 목록 조회
  - `TENANT_AUTH_MODE=required`에서는 요청 tenant 1개만 반환
- `POST /api/v1/organizations` → 조직 생성 (`admin` 이상)
  - `required` 모드에서 생성자 owner 멤버십 자동 생성
- `GET /api/v1/organizations/:id` → 단일 조직 조회 (tenant scope 강제)
- `GET /api/v1/organizations/:id/memberships` → 조직 멤버십 조회 (`admin` 이상)
- `POST /api/v1/organizations/:id/memberships` → 조직 멤버 추가 (`admin` 이상)
- `PATCH /api/v1/organizations/:id/memberships/:userId` → 멤버 역할 수정 (`admin` 이상)
- `DELETE /api/v1/organizations/:id/memberships/:userId` → 조직 멤버 제거 (`admin` 이상)
  - 마지막 owner 삭제는 `409 TENANT_OWNER_MIN_REQUIRED`
- `GET /api/v1/organizations/:id/audit-logs?limit=50` → 조직 감사 로그 조회 (`admin` 이상)
  - `limit`은 1~100 정수

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
- `.github/actions/devsecops-scan/action.yml`: Composite Action
  - 스캔 생성 (POST /api/v1/scans)
  - 폴링으로 완료 대기 (최대 5분, 10초 간격)
  - 결과를 GitHub Step Summary에 출력

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

- **재기동 엣지케이스**: 비정상 크래시(프로세스 강제 종료) 시 in-flight 작업의 즉시 복구는 보장하지 않음 — 재시도/재처리 정책은 후속 고도화 필요
- **Mock 모드 기본**: `SCAN_EXECUTION_MODE=mock`이 기본값 — 실제 스캐너가 아닌 deterministic 더미 데이터 반환
- **인증 제한**: JWT 검증은 구현되었지만 Google SSO/OAuth 로그인(웹 세션 발급), 토큰 회전 자동화, IdP 운영 가이드는 후속 구현 필요
- **GitHub App 미연동**: Check Run 생성, PR 댓글 등 GitHub API 기능 미구현 (Mock 모드, 향후 예정)
- **클라이언트 필터링**: 엔진 필터와 검색은 클라이언트사이드 처리 — 대량 데이터 시 성능 저하 가능
- **PDF 미지원**: 직접 PDF 생성 불가 — 브라우저 `Ctrl+P` 인쇄 기능으로 대체

---

## 문서

- `docs/workflow/DECISIONS.md`: 확정 의사결정 / 미결정 / 리스크
- `docs/architecture/AUTH_TRANSITION.md`: Header → JWT/OAuth 전환 경계/신뢰모델/롤아웃 계획
- `docs/workflow/PHASE3_BACKLOG.md`: Phase 3 대시보드/리포팅 구현 기록
- `docs/workflow/PHASE4_BACKLOG.md`: Phase 4 GitHub CI/CD 연동 구현 기록
- `docs/workflow/PHASE5_BACKLOG.md`: Phase 5 멀티테넌시/인증 기반 구현 기록
- `CLAUDE.md`: 프로젝트 작업 규칙 및 검증 루틴
