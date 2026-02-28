# Tenant Row-Level Security (RLS) 롤아웃 설계

## 1) 목적

현재 API는 애플리케이션 레벨에서 `tenantId` 필터링을 수행한다. 이는 MVP 단계에서 충분히 실용적이지만,
운영 단계에서는 **DB 자체에서 tenant 경계를 강제**할 수 있어야 한다.

이 문서는 PostgreSQL RLS를 안전하게 도입하기 위한 **실행 가능한 설계/롤아웃 계획**을 정의한다.

---

## 2) 범위

### 대상 테이블 (tenant 데이터)

- `scans` (`tenant_id` 기준)
- `organizations` (`id` == tenant id)
- `organization_memberships` (`organization_id` 기준)
- `organization_invite_tokens` (`organization_id` 기준)
- `tenant_audit_logs` (`organization_id` 기준)

### 비대상 (1차)

- `scan_queue_jobs`, `scan_dead_letters`, `scan_retry_schedules`
  - 내부 워커 운영 테이블로, API read path에서 직접 노출하지 않음
  - 1차 롤아웃에서는 service role 전용으로 유지

---

## 3) 핵심 원칙

1. **무중단/저위험 전환**: shadow → enforce 2단계 전환
2. **권한 분리**: migration owner role과 runtime app role 분리
3. **요청 단위 세션 컨텍스트**: `current_setting()` 기반 tenant/user/role 전달
4. **즉시 롤백 가능성 확보**: RLS disable 및 credential rollback 절차 사전 준비

---

## 4) 앱-DB 세션 변수 전략

RLS 정책은 아래 세션 변수를 기준으로 동작한다.

- `app.tenant_id` (legacy 호환 alias: `app.current_tenant_id`)
- `app.user_id` (legacy 호환 alias: `app.current_user_id`)
- `app.user_role` (legacy 호환 alias: `app.current_user_role`)

요청/작업 처리 시 DB 트랜잭션 시작 후 `SET LOCAL` 성격으로 주입한다.

```sql
SELECT
  set_config('app.tenant_id', $1, true),
  set_config('app.user_id', $2, true),
  set_config('app.user_role', $3, true),
  set_config('app.current_tenant_id', $1, true),
  set_config('app.current_user_id', $2, true),
  set_config('app.current_user_role', $3, true);
```

`set_config(..., true)`를 사용해 transaction-local scope로 제한하고,
커넥션 풀 재사용 시 다른 요청으로 컨텍스트가 누수되지 않도록 한다.

### 앱 적용 포인트 (권장)

- Fastify request context에서 인증 완료 후 tenant/user/role 확정
- DB 접근 helper (`withTenantDbSession`)에서:
  1) `BEGIN`
  2) `set_config` 3종 주입
  3) 실제 쿼리 실행
  4) `COMMIT`/`ROLLBACK`

---

## 5) 정책 헬퍼 함수 (현재 구현)

```sql
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.tenant_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.tenant_id', true), ''),
    NULLIF(current_setting('app.current_tenant_id', true), '')
  );
$$;

CREATE OR REPLACE FUNCTION app.user_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.user_role', true), ''),
    NULLIF(current_setting('app.current_user_role', true), '')
  );
$$;

CREATE OR REPLACE FUNCTION app.is_service_context()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app.user_role() = 'service' OR app.tenant_id() = '*';
$$;
```

`service` 컨텍스트는 startup/hydration/retention prune 같은 시스템 경로에서만 사용한다.

---

## 6) RLS 정책 예시 (preview 구현)

> 실제 migration(`006_tenant_rls_preview`)은 tenant 대상 테이블별로 `<table>_tenant_isolation` 정책을 생성한다.

```sql
CREATE POLICY scans_tenant_isolation
  ON scans
  USING (app.is_service_context() OR tenant_id = app.tenant_id())
  WITH CHECK (app.is_service_context() OR tenant_id = app.tenant_id());

CREATE POLICY organizations_tenant_isolation
  ON organizations
  USING (app.is_service_context() OR id = app.tenant_id())
  WITH CHECK (app.is_service_context() OR id = app.tenant_id());

CREATE POLICY organization_memberships_tenant_isolation
  ON organization_memberships
  USING (app.is_service_context() OR organization_id = app.tenant_id())
  WITH CHECK (app.is_service_context() OR organization_id = app.tenant_id());

CREATE POLICY organization_invite_tokens_tenant_isolation
  ON organization_invite_tokens
  USING (app.is_service_context() OR organization_id = app.tenant_id())
  WITH CHECK (app.is_service_context() OR organization_id = app.tenant_id());

CREATE POLICY tenant_audit_logs_tenant_isolation
  ON tenant_audit_logs
  USING (app.is_service_context() OR organization_id = app.tenant_id())
  WITH CHECK (app.is_service_context() OR organization_id = app.tenant_id());
```

---

## 7) 단계별 migration/rollout 계획

### Phase A — 사전 점검/스키마 준비

1. 데이터 무결성 확인
   - `scans.tenant_id` null 여부 0건
   - `organization_*`/`tenant_audit_logs`의 `organization_id`가 유효한 `organizations.id`를 참조하는지 확인
2. 인덱스 보강
   - `scans (tenant_id, created_at)`
   - `organization_memberships (organization_id, role)`
   - `organization_invite_tokens (organization_id, expires_at)`
3. helper function 및 policy SQL migration 추가 (단, enforce 전까지 영향 최소화)

### Phase B — Shadow 모드 (`TENANT_RLS_MODE=shadow`)

1. 앱에서 요청/영속화 작업 단위로 세션 변수 주입 시작
2. 기존 애플리케이션 필터(`WHERE tenant_id = ...`)는 유지
3. staging에서 role 전환 없이 query behavior/log 비교
   - tenant 경계 위반 시도 시 expected rejection 시나리오 리허설

### Phase C — Enforce 모드 (`TENANT_RLS_MODE=enforce`)

1. runtime DB credential을 **RLS bypass 권한이 없는 app role**로 전환
2. 대상 테이블 `ENABLE ROW LEVEL SECURITY` + 필요 테이블 `FORCE ROW LEVEL SECURITY` 적용
3. production canary(일부 트래픽) 후 전체 전환

### Phase D — 운영 안정화

1. API 레벨 tenant 필터를 즉시 제거하지 않고 이중 방어 유지
2. RLS 전용 모니터링 쿼리/알람 추가
   - `permission denied for relation ...` 에러율
   - tenant mismatch 탐지 지표

---

## 8) 롤백 계획

롤백은 **모드 롤백 + 필요 시 DB 수동 완화** 순서로 즉시 수행한다.

1. 모드 롤백 (권장, 즉시)
   - `TENANT_RLS_MODE=off`로 재배포/재시작
   - 앱 startup에서 대상 테이블에 `NO FORCE + DISABLE ROW LEVEL SECURITY`를 자동 적용

2. 앱/자격증명 롤백 (필요 시)
   - runtime DB credential을 기존 권한(비-RLS 경로)으로 되돌림
   - 직전 안정 릴리즈로 즉시 재배포

3. DB 수동 완화 (긴급 대응용)

```sql
ALTER TABLE scans NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_invite_tokens NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_audit_logs NO FORCE ROW LEVEL SECURITY;

ALTER TABLE scans DISABLE ROW LEVEL SECURITY;
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships DISABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invite_tokens DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_audit_logs DISABLE ROW LEVEL SECURITY;
```

4. 사후 조치
   - 실패 요청 샘플/로그 수집
   - 정책 충돌 쿼리 재현 후 수정
   - staging 재검증 완료 후 재시도

---

## 9) 검증 체크리스트

- tenant A 토큰으로 tenant B 데이터 조회/수정이 모두 차단되는가?
- owner/admin/member/viewer role별 권한 행위가 정책과 일치하는가?
- queue/dead-letter 운영 API가 기존 계약(tenant scope + admin gate)을 유지하는가?
- 고부하 상황에서 pool 재사용 시 세션 변수 누수가 없는가?
- 장애 시 롤백(runbook 기준) 15분 내 복구 가능한가?

---

## 10) 산출물 상태 (Ops MVP Phase K)

- 본 문서: **완료 (설계 + 운영 runbook 반영)**
- DB migration 코드: **완료**
  - `006_tenant_rls_preview`
  - `app` schema helper 함수(`tenant_id`, `user_id`, `user_role`, `is_service_context`) 추가
  - tenant 대상 테이블 RLS policy + role 생성 idempotency hook(`pg_roles`/`pg_policies`) 반영
- 앱 DB 세션 helper 적용: **완료 (preview 범위)**
  - `TENANT_RLS_MODE=shadow|enforce`에서 transaction-local `set_config` 주입
  - startup/hydration/retention prune은 `service` 컨텍스트로 실행
- 런타임 enforce 토글: **완료**
  - `TENANT_RLS_MODE=enforce`: 대상 테이블 `ENABLE + FORCE`
  - `TENANT_RLS_MODE=off|shadow`: 대상 테이블 `NO FORCE + DISABLE`

## 11) 현재 제약/주의사항 (preview)

- 현재 아키텍처는 PostgreSQL을 **영속화 계층**으로 사용하고, API read/write는 인메모리 스토어 중심으로 동작한다.
- 따라서 RLS enforce는 tenant 대상 영속화 테이블 경계 강화 용도로 우선 적용되며,
  queue/dead-letter/retry 운영 테이블은 서비스 전용 범위로 유지한다.
- full request-path RLS(모든 조회를 DB direct query로 강제)는 후속 구조 전환 시점에 단계적으로 확장한다.

