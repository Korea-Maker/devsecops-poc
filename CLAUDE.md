# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

스타트업 개발팀(1~5명)을 위한 DevSecOps PoC. SAST(Semgrep) + SCA(Trivy) + Secret(Gitleaks) 스캔을 통합하고, 대시보드와 GitHub CI/CD 연동을 제공한다.

- 아키텍처: **Fastify 5 API + Next.js 15 Web** (pnpm workspace 모노레포)
- 데이터: 인메모리 Map 스토어 + PostgreSQL 영속화 (`DATA_BACKEND` 환경변수로 선택)
- 인증: Google OIDC → 플랫폼 JWT 발급 구현 완료. 웹 로그인 UX/세션 처리는 미구현

## 명령어

```bash
# 설치
pnpm install

# 개발 서버
pnpm --filter @devsecops/api dev    # API: localhost:3001
pnpm --filter @devsecops/web dev    # Web: localhost:3000

# 빠른 최소 검증 (변경 후 반드시 실행)
pnpm --filter @devsecops/api test
pnpm --filter @devsecops/api typecheck

# 전체 검증
pnpm --filter @devsecops/api test
pnpm --filter @devsecops/api typecheck
pnpm --filter @devsecops/web typecheck
pnpm --filter @devsecops/api build
pnpm --filter @devsecops/web build

# 단일 테스트 파일 실행
pnpm --filter @devsecops/api exec vitest run tests/scans.test.ts

# 테스트 워치 모드
pnpm --filter @devsecops/api test:watch

# PostgreSQL (로컬 개발용)
docker compose up -d
```

## 아키텍처

### API (`apps/api`) — `@devsecops/api`

ESM(`"type": "module"`) 기반 Fastify 5 서버. `buildApp()` (`src/app.ts`)에서 플러그인 등록.

**서버 기동 순서 (`onReady` hook):**
1. `validateTenantAuthConfiguration()` — 인증 환경변수 조합 검증 (잘못되면 기동 실패)
2. `initializeDataBackend()` — `DATA_BACKEND`에 따라 PostgreSQL 연결 + 마이그레이션 또는 빈 메모리 초기화
3. hydrate — DB에서 읽은 데이터로 인메모리 스토어 복원 (scans, queue, organizations, memberships, inviteTokens, auditLogs)

**라우트 구조:**
- `src/routes/health.ts` — `GET /health`
- `src/routes/scans.ts` — 스캔 CRUD + 큐 관리 (`/api/v1/scans/*`)
- `src/routes/github.ts` — GitHub webhook 수신 (`/api/v1/github/*`)
- `src/routes/auth.ts` — OIDC 로그인 + JWKS (`/api/v1/auth/*`)
- `src/routes/tenants.ts` — 조직/멤버십/초대/감사로그 (`/api/v1/organizations/*`)

**스캐너 핵심 흐름:** `POST /api/v1/scans` → `store.createScan()` → `queue.enqueueScan()` → 워커가 `processNextScanJob()` 호출 → `source-prep.prepareScanSource()` → `registry.getAdapter(engine).scan()` → 결과를 `store.updateScanMeta()`에 저장

**스캐너 모듈 (`src/scanner/`):**
- `types.ts` — `ScanAdapter` 인터페이스, `ScanEngineType`, `ScanStatus` 등 핵심 타입
- `store.ts` — 인메모리 Map 기반 스캔 레코드 CRUD (`createScan`, `getScan`, `listScans`, `updateScanStatus`, `updateScanMeta`)
- `queue.ts` — 인메모리 FIFO 큐 + 워커 + retry(exponential backoff) + dead-letter. `processNextScanJob()`이 핵심 처리 루프
- `registry.ts` — 엔진 어댑터 레지스트리 (semgrep/trivy/gitleaks)
- `source-prep.ts` — repoUrl 분류(`classifyRepoUrlInput`) + native 모드 시 git clone 관리
- `adapters/common.ts` — mock/native 모드 분기, CLI 실행 헬퍼, severity 정규화, deterministic mock 생성
- `adapters/{semgrep,trivy,gitleaks}.ts` — 각 엔진별 `ScanAdapter` 구현 (mock + native 모드)

**저장소 백엔드 (`src/storage/backend.ts`):**
- `DATA_BACKEND=memory` (기본): 순수 인메모리, 재시작 시 소실
- `DATA_BACKEND=postgres` + `DATABASE_URL`: PostgreSQL에 영속화. `schema_migrations` 테이블로 경량 마이그레이션 버저닝. 서버 시작 시 DB → 인메모리 hydrate
- read path: `DATA_BACKEND=postgres`일 때 tenant-scoped GET 요청은 DB direct query 우선 사용
- write path: queue/dead-letter/retry는 인메모리 워커 semantics 유지 (DB 기반 worker lease 미도입)
- `TENANT_RLS_MODE` (`off|shadow|enforce`): PostgreSQL Row-Level Security 단계적 적용
- `TENANT_RLS_RUNTIME_GUARD_MODE` (`off|warn|enforce`): service/tenant 컨텍스트 분리 강제

**테넌트/인증 모듈:**
- `src/tenants/types.ts` — `Organization`, `OrganizationMembership`, `TenantContext`, `UserRole` 등 도메인 타입
- `src/tenants/store.ts` — 조직/멤버십/초대토큰 인메모리 CRUD + PostgreSQL direct read
- `src/tenants/auth.ts` — `TENANT_AUTH_MODE`(`disabled|required`) + `AUTH_MODE`(`header|jwt`) 기반 인증 미들웨어. `tenantAuthOnRequest()`로 요청별 `TenantContext` 해석
- `src/tenants/audit-log.ts` — 테넌트 감사 로그 (멤버십 변경 등 기록)
- `src/auth/google-oidc.ts` — Google OIDC code 교환 + id_token 검증
- `src/auth/platform-jwt.ts` — 플랫폼 JWT(access token) 발급 + JWKS 노출
- `src/auth/oauth-state.ts` — OIDC state/nonce 관리

**GitHub 연동 (`src/integrations/github/`):** webhook 수신 → HMAC-SHA256 시그니처 검증 → push/PR 이벤트에서 스캔 트리거 추출 → 3개 엔진 스캔 자동 생성.

### Web (`apps/web`) — `@devsecops/web`

Next.js 15 App Router. `next.config.ts`에서 `/api/*` 요청을 `localhost:3001`로 프록시.

- `src/lib/api.ts` — API 호출 래퍼 (`fetchScans`, `fetchScan`, `fetchQueueStatus`, `fetchDeadLetters`)
- `src/lib/types.ts` — 프론트엔드 타입 정의
- `src/app/page.tsx` — 대시보드 (5초 자동 새로고침, 필터/정렬/검색)
- `src/app/scans/[id]/page.tsx` — 스캔 상세
- `src/app/reports/[id]/page.tsx` — 리포트 (HTML 다운로드)

### 인프라 (`infra/`)

- `infra/docker/` — Docker Compose 설정 (staging 등)
- `infra/terraform/` — AWS IaC (VPC, RDS, ECS, S3 모듈). 환경별 tfvars (`environments/{dev,staging,prod}.tfvars`)
- `infra/scripts/` — 운영 스크립트: `terraform-plan.sh`, `terraform-apply.sh`, `terraform-preflight-validate.sh`, `post-deploy-smoke-check.sh`, `verify-rls-canary.sh`

### GitHub Actions (`.github/workflows/` + `.github/actions/`)

- `ci.yml` — push/PR 시 typecheck/test/build
- `security-scan.yml` — PR 시 `.github/actions/security-scan/` Composite Action으로 3개 엔진 통합 스캔
- `deploy-staging.yml` — main push → staging 배포 (verify → preflight → deploy → smoke → optional RLS canary)
- `deploy-production.yml` — `v*` tag push 또는 수동 실행 → production 배포
- `terraform-pr-checks.yml` — `infra/terraform/**` 변경 시 fmt/validate/plan 검증
- `terraform-rehearsal-dry-run.yml` — Terraform dry-run 리허설 (수동)
- `terraform-manual-apply.yml` — Terraform apply (수동, guarded)
- `.github/actions/security-scan/` — 재사용 가능한 보안 스캔 Composite Action (semgrep+trivy+gitleaks, PR Comment upsert, 차단 기준 설정 가능)
- `.github/actions/devsecops-scan/` — [DEPRECATED] API 기반 스캔 action

### 스캔 실행 모드

`SCAN_EXECUTION_MODE` 환경변수로 제어:
- `mock` (기본): deterministic 더미 데이터 반환. 외부 도구 불필요
- `native`: 실제 CLI(semgrep/trivy/gitleaks) 실행. 원격 URL은 임시 디렉터리에 shallow clone 후 스캔

## 테스트 패턴

테스트 파일은 `apps/api/tests/` 디렉터리에 위치. Vitest + Supertest 사용.

- `buildApp()`으로 Fastify 인스턴스 생성 후 `app.inject()`로 HTTP 요청 테스트
- 각 테스트 전 `clearStore()` + `clearQueue()` + `stopScanWorker()`로 상태 격리
- 큐 테스트에서 `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`로 타이머 제어
- `setScanForcedFailuresForTest()` 등 테스트 전용 훅으로 실패 시나리오 검증
- DB 관련 테스트(`data-backend.test.ts`, `*-read-path.test.ts`)는 `DATA_BACKEND=memory`에서도 동작하도록 작성

## 코딩 규칙

- 언어: TypeScript (strict mode, ESM)
- 문서/주석/커뮤니케이션: 한국어 기본
- 환경변수/시크릿: `.env` 커밋 금지
- 오류 응답: `{ error: string, code?: string }` 형태 통일
- import 경로: `.js` 확장자 포함 (ESM 요구사항, 예: `from './store.js'`)
- 범위 밖 구현은 TODO로 명시

## 주요 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DATA_BACKEND` | `memory` | `memory` 또는 `postgres` |
| `DATABASE_URL` | — | PostgreSQL 연결 문자열 (`postgres` 백엔드 시 필수) |
| `SCAN_EXECUTION_MODE` | `mock` | `mock` 또는 `native` |
| `TENANT_AUTH_MODE` | `disabled` | `disabled` 또는 `required` |
| `AUTH_MODE` | `header` | `header` 또는 `jwt` (`TENANT_AUTH_MODE=required` 시 적용) |
| `TENANT_RLS_MODE` | `off` | `off`, `shadow`, `enforce` |

전체 환경변수 목록은 `README.md` 참조.

## 참고 문서

- `README.md` — 전체 구현 상태, API 계약, 환경변수 목록
- `docs/workflow/DECISIONS.md` — 확정 의사결정/리스크
- `docs/architecture/AUTH_TRANSITION.md` — Header → JWT/OAuth 전환 경계/신뢰모델
- `docs/architecture/TENANT_RLS_ROLLOUT.md` — PostgreSQL Tenant RLS 단계적 도입 설계
- `docs/workflow/DEPLOYMENT.md` — staging/production 배포 전략, 체크리스트
- `infra/terraform/OPERATOR_HANDOFF.md` — Terraform dry-run 리허설 운영자 핸드오프
