# Phase 5: 멀티 테넌시 + 인증/인가 백로그

## 목표

스캔 API에 최소한의 멀티 테넌트 격리와 인증/인가를 도입해,
조직(tenant) 간 데이터 노출을 차단하고 JWT/OAuth 전환 기반을 마련한다.

---

## 이번 반영 범위 (완료)

- [x] Fastify 요청 단위 tenant/auth 컨텍스트 미들웨어 추가
  - 파일: `apps/api/src/tenants/auth.ts`
  - 환경변수: `TENANT_AUTH_MODE=disabled|required` (기본 `disabled`)
  - `required` + `AUTH_MODE=header` 헤더 계약:
    - `x-tenant-id` (선택, 미전달 시 `default`)
    - `x-user-id` (필수)
    - `x-user-role` (필수: `owner|admin|member|viewer`)
  - 역할 비교 헬퍼(`hasRoleAtLeast`) + 최소 권한 체크(`requireMinimumRole`) 제공

- [x] 인증 모드 추상화 + JWT 실검증 구현
  - 신규 환경변수: `AUTH_MODE=header|jwt` (기본 `header`)
  - `TENANT_AUTH_MODE` 기존 계약과 완전 호환(미설정/기존 설정 동작 유지)
  - `AUTH_MODE=jwt`에서 `Authorization: Bearer <token>` 필수화
  - JWT env: `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_JWKS_URL`
  - JOSE 기반 remote JWKS 서명 검증 + `iss`/`aud`/role claim 검증

- [x] Scans API tenant 격리 적용
  - `POST /api/v1/scans`: tenant context의 `tenantId`를 scan 레코드에 저장
  - `GET /api/v1/scans`: 요청 tenant 스캔만 반환 (`status` 필터 유지)
  - `GET /api/v1/scans/:id`: 타 tenant 스캔 접근 시 `404`

- [x] Queue/Dead-letter 수동 운영 API tenant 누수 방지(실용적 필터)
  - `GET /api/v1/scans/queue/status`: tenant 필터 기반 집계 지원
  - `POST /api/v1/scans/queue/process-next`: 요청 tenant 대기 작업만 1건 처리
    - 다른 tenant 작업이 처리 중일 때는 `busy=false`로 마스킹
  - `GET /api/v1/scans/dead-letters`: tenant 범위만 반환
  - `POST /api/v1/scans/:id/redrive`: 타 tenant 항목은 `not_found` 처리
  - `TENANT_AUTH_MODE=required`일 때 위 4개 endpoint는 `admin` 이상 권한 필요
  - `TENANT_AUTH_MODE=disabled`에서는 기존 동작 유지

- [x] Organization/Membership CRUD 초안 구현 (인메모리)
  - `GET/POST /api/v1/organizations`
  - `GET /api/v1/organizations/:id`
  - `GET/POST /api/v1/organizations/:id/memberships`
  - `PATCH/DELETE /api/v1/organizations/:id/memberships/:userId`
  - 마지막 owner 보호 정책(`TENANT_OWNER_MIN_REQUIRED`) 적용
  - `required` 모드에서 tenant scope + admin 권한 가드 적용

- [x] Organization/Membership API 하드닝 (Ops MVP Phase G)
  - 조직 상태 필드 추가: `active`, `disabledAt` (soft disable)
  - 신규 endpoint: `POST /api/v1/organizations/:id/disable`
  - 목록 조회 고도화:
    - `GET /api/v1/organizations` → `search/page/limit`
    - `GET /api/v1/organizations/:id/memberships` → `search/page/limit`
    - page/limit 생략 시 기존 응답 계약(배열 전체 반환) 유지
  - 초대 토큰 플로우 추가:
    - `POST /api/v1/organizations/:id/invite-tokens`
    - `POST /api/v1/organizations/invite-tokens/accept`
    - 1회용(replay 방지), 만료 검증, optional email 바인딩, tenant scope 검증
  - disabled 조직 쓰기 차단: `409 TENANT_ORG_DISABLED`
  - PostgreSQL 영속화 확장:
    - `organizations.active/disabled_at` 컬럼
    - `organization_invite_tokens` 테이블
    - migration `005_tenant_org_hardening`

- [x] Tenant 감사 로그 조회 API 초안 구현
  - `GET /api/v1/organizations/:id/audit-logs?limit=50`
  - 조직 생성/멤버 생성/권한변경/멤버삭제 이벤트 적재

- [x] Ops MVP Phase H 운영 신뢰성 보강
  - queue/dead-letter/retry snapshot 저장을 PostgreSQL 단일 transaction(`BEGIN/COMMIT`)으로 고도화
  - 감사 로그 조회 필터 확장(`action`, `userId`, `since`, `until`) + 기존 `limit` 계약 하위호환 유지
  - `TENANT_AUDIT_LOG_RETENTION_DAYS` 보존 정책 추가 + startup/write 시점 lightweight prune
  - 관련 테스트 보강(data backend transaction 시퀀스, audit log route/store 필터/retention)

- [x] 데이터 저장 백엔드 추상화 + PostgreSQL 영속화 (Ops MVP)
  - 신규 환경변수: `DATA_BACKEND=memory|postgres` (기본 `memory`)
  - `DATA_BACKEND=postgres`에서 `DATABASE_URL` 기반 연결/초기화
  - 부팅 시 `schema_migrations` 기반 versioned migration 순차/멱등 적용
  - 부팅 hydration으로 scans/queue/dead-letter/retry schedule/organizations/memberships/tenant audit logs를 인메모리 스토어로 복원
  - startup recovery:
    - 이전 비정상 종료로 `running`에 남은 scan을 `queued`로 전환하고 queue에 재적재
    - retry schedule(`scanId`,`dueAt`)은 `dueAt<=now` 즉시 enqueue, 미래 시점은 남은 delay로 재타이머링
  - 쓰기 경로 upsert/delete + queue snapshot 저장으로 위 엔티티 영속화(기존 API 계약/응답 shape 유지)
  - postgres 초기화 실패 시 자동 memory fallback(서비스 기동 우선)

- [x] 스캔 워커 lifecycle 신뢰성 보강
  - 워커 시작 전 hydration 완료 순서 보장(`app.ready()` 이후 worker start)
  - shutdown 시 `stopScanWorkerAndDrain()`으로 pending retry materialize + in-flight 처리 종료 대기
  - onClose에서 backend persistence queue flush 후 연결 종료

- [x] Tenant 도메인/스토어 보강
  - 파일: `apps/api/src/tenants/store.ts`
  - 기본 tenant bootstrap 유지 (`default`)
  - 입력 검증(name/slug 비어있음 방지)
  - slug 중복 생성 방지 (`TENANT_DUPLICATE_SLUG`)
  - `clearOrganizationStore()` 이후에도 기본 tenant 재부팅

- [x] 테스트/문서 갱신
  - API 테스트 추가:
    - `AUTH_MODE` fallback + JWT 모드 필수 구성 검증
    - JWT 모드 invalid token/header/JWKS 케이스(401/503 계약)
    - tenant 격리(list/get), queue/dead-letter admin 권한 검사
    - startup running-scan recovery + schema migration idempotent/apply-order 검증
  - 문서 갱신:
    - `README.md` 인증 모드/환경변수/제약 업데이트
    - `docs/architecture/AUTH_TRANSITION.md` 신규 추가(경계, trust model, rollout)

- [x] Ops MVP Phase I 배포 파이프라인 구체화
  - 신규 워크플로우: `.github/workflows/deploy-staging.yml`, `.github/workflows/deploy-production.yml`
  - staging/prod 공통 verify 게이트(API test/typecheck/build + Web typecheck/build)
  - 필수 secret/variable 누락 시 실패 대신 skip + Step Summary 사유 출력(기존 CI 비차단)
  - 공통 post-deploy smoke check 계약 스크립트 추가: `infra/scripts/post-deploy-smoke-check.sh`

- [x] Ops MVP Phase J 운영/실서비스 최종화 (staging RLS canary wiring)
  - 신규 read-only canary 스크립트: `infra/scripts/verify-rls-canary.sh`
  - 검증 계약: tenant A 허용 요청은 성공(기본 200), tenant B 교차 접근은 거부(기본 401/403/404)
  - `deploy-staging.yml` smoke 이후 optional canary step 추가
    - enabled + 구성 완비 시 mismatch를 배포 실패로 처리
    - 비활성화/구성 누락 시 Step Summary에 사유를 남기고 skip(exit 0)
  - README/DEPLOYMENT 문서에 canary env 계약 + MVP complete 조건 명시

- [x] Tenant PostgreSQL RLS 롤아웃 설계 문서화
  - 신규 문서: `docs/architecture/TENANT_RLS_ROLLOUT.md`
  - 포함 내용: 단계별 migration 계획, 정책 SQL 예시, 앱 세션 변수(`set_config`) 전략, 롤백 runbook

- [x] Ops MVP Phase K Tenant RLS opt-in preview 적용
  - 신규 환경변수: `TENANT_RLS_MODE=off|shadow|enforce` (기본 `off`)
  - migration `006_tenant_rls_preview` 추가
    - `app` schema helper 함수 + tenant 대상 테이블 policy 생성
    - role/policy 생성 시 `pg_roles`/`pg_policies` 기반 idempotency hook 적용
  - startup 시 모드별 RLS 토글 적용
    - `enforce`: `ENABLE + FORCE ROW LEVEL SECURITY`
    - `off|shadow`: `NO FORCE + DISABLE ROW LEVEL SECURITY`
  - tenant 대상 persistence 작업 전 transaction-local `set_config` 주입(`app.tenant_id`, `app.user_id`, `app.user_role`)
  - startup/hydration/retention prune는 `service` 컨텍스트로 실행(운영 안전 경로)
  - README/TENANT_RLS_ROLLOUT/PHASE5_BACKLOG 문서 및 테스트 갱신

- [x] Ops MVP Phase M production hardening 1차 적용
  - request-path DB direct read pilot
    - `GET /api/v1/scans`, `GET /api/v1/scans/:id`가 `DATA_BACKEND=postgres`에서 tenant-scoped direct query 우선 사용
    - memory backend 계약/응답 shape 유지
  - runtime role separation guardrails
    - service-context vs tenant-context 스코프 검증 가드 추가
    - 신규 env: `TENANT_RLS_RUNTIME_GUARD_MODE=off|warn|enforce` (기본 `off`)
    - `warn`: mismatch 경고 로그, `enforce`: mismatch 즉시 차단
  - 관련 테스트/문서 갱신

- [x] Ops MVP Phase N request-path DB direct read coverage 확장
  - 대상 endpoint(tenant scope):
    - `GET /api/v1/organizations/:id`
    - `GET /api/v1/organizations/:id/memberships`
  - `DATA_BACKEND=postgres`일 때 tenant-scoped direct query 우선 사용, memory backend 동작/응답 shape 유지
  - DB query 레이어에서 tenant scope 조건을 명시적으로 강제하고 runtime guard 모드(`TENANT_RLS_RUNTIME_GUARD_MODE`)와 정합 유지
  - read path 선택 + tenant 필터링 검증 테스트 및 README/백로그 문서 갱신

- [x] Ops MVP Phase Q request-path/guard rollout 마무리
  - tenant-scoped read 경로 확장:
    - `GET /api/v1/organizations` (search/page/limit 포함)
    - `GET /api/v1/organizations/:id/audit-logs` (기존 filter 계약 유지)
  - `DATA_BACKEND=postgres`에서 tenant-scoped direct query 우선 사용, memory backend 응답 shape 유지
  - runtime guard rollout 문서 확정:
    - `TENANT_RLS_RUNTIME_GUARD_MODE`를 `off -> warn -> enforce` 체크포인트/abort 기준과 함께 명시
    - 신규 선택 env `TENANT_RLS_RUNTIME_GUARD_STARTUP_WARN=true|false` (기본 `false`)
  - targeted 테스트 추가:
    - tenant read path 선택 + tenant filtering correctness
    - startup warning/guard sanity 로직

- [x] Ops MVP Phase O SaaS 인프라 자동화 하드닝 1차 적용
  - Terraform 모듈 skeleton 추가: `infra/terraform/modules/{vpc,rds,ecs,s3}`
  - 안전 기본값 적용: `allow_resource_creation=false` + module toggle(`enable_*`) 기본 false
  - 환경별 tfvars 샘플 추가: `infra/terraform/environments/{dev,staging,prod}.tfvars`
  - helper script 추가: `infra/scripts/terraform-plan.sh`, `infra/scripts/terraform-apply.sh`
    - 환경 인자 필수, apply 대화형 확인, prod apply는 `--allow-prod` 없으면 거부
  - PR IaC 검증 워크플로우 추가: `.github/workflows/terraform-pr-checks.yml`
    - fmt/validate/plan(no-apply), terraform/AWS creds 누락 시 skip-safe


---

## 아직 남은 작업 (Phase 5 후속)

- [x] JWT claims → `tenantContext(tenantId,userId,role)` 매핑 스펙 확정 (Ops MVP Phase L)
  - 신규 env: `JWT_TENANT_ID_CLAIM`(+`JWT_TENANT_ID_FALLBACK_CLAIMS`), `JWT_USER_ID_CLAIM`(+`JWT_USER_ID_FALLBACK_CLAIMS`), `JWT_ROLE_CLAIM`(+`JWT_ROLE_FALLBACK_CLAIMS`)
  - 기본값은 기존 계약 유지(tenant_id/tid, sub/user_id, role/roles[0]), fallback env를 빈 문자열로 두면 fallback 비활성화
  - startup/auth 초기화 시 claim selector 형식 검증(`TENANT_AUTH_JWT_CLAIM_MAPPING_INVALID`)
- [x] OAuth/OIDC 로그인 API 콜백 + 플랫폼 토큰 발급 체계 연결 (Ops MVP Phase E)
  - 신규 API:
    - `GET /api/v1/auth/jwks`
    - `GET /api/v1/auth/google/start`
    - `GET /api/v1/auth/google/callback`
  - membership 매핑: `sub` 우선 + `email` fallback, 복수 membership 시 `tenantId` 필수
  - 플랫폼 JWT: RS256 + JWKS(`kid`) 노출, env 키 우선/미설정 시 ephemeral 키 생성 경고
- [x] 조직/멤버십 API 고도화 (초대 토큰/페이지네이션/검색/비활성화)
- [x] queue snapshot persistence를 transaction 기반으로 고도화해 강제 종료 시점의 마지막 write 유실 가능성 최소화
- [x] tenant 인덱싱/행 수준 격리(RLS) 설계 (`docs/architecture/TENANT_RLS_ROLLOUT.md`)
- [x] tenant RLS migration/role 분리 opt-in preview 적용 (`TENANT_RLS_MODE`)
- [ ] full request-path DB direct query 범위 확장 (현재 `GET /api/v1/scans`, `GET /api/v1/scans/:id`, `GET /api/v1/organizations`, `GET /api/v1/organizations/:id`, `GET /api/v1/organizations/:id/memberships`, `GET /api/v1/organizations/:id/audit-logs` 전환 완료)
- [x] runtime role separation guard 운영 기본값/롤아웃 정책 확정 (`TENANT_RLS_RUNTIME_GUARD_MODE` off→warn→enforce 절차 + 체크포인트/abort 기준 문서화)
- [x] staging read-only RLS canary helper/배포 연동 (`infra/scripts/verify-rls-canary.sh`, `deploy-staging.yml`)
- [x] 감사 로그 영속화/보존정책/검색 쿼리 고도화(기본 필터 + retention prune)
- [x] staging/prod 배포 워크플로우 초안 구현 (graceful skip + post-deploy smoke contract)
- [ ] SaaS 인프라(IaC) 실제 리소스 프로비저닝/배포 자동화 고도화

---

## 운영/실서비스 MVP complete 판정 조건 (현재)

- [x] staging/prod 배포 워크플로우 verify/preflight/deploy/smoke 계약 구현
- [x] staging smoke 이후 optional RLS canary 실행 + enabled/config complete일 때 mismatch fail-fast
- [x] canary 비활성/구성 누락 시 skip(exit 0) + Step Summary 사유 기록으로 CI 탄력성 보장
- [x] PostgreSQL RLS migration/role 분리 opt-in enforce 적용 (`TENANT_RLS_MODE=enforce`, 기본값 `off`)

---

## 참고

- `docs/workflow/MASTER_PLAN.md` (Phase 5 상위 목표)
- `docs/architecture/AUTH_TRANSITION.md` (Header → JWT/OAuth 전환 설계)
- `docs/architecture/TENANT_RLS_ROLLOUT.md` (Tenant RLS 단계적 도입 설계)
- `README.md` (현재 API 계약/환경변수/배포 워크플로우 계약)
