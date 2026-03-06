# 환경변수 설정

## 핵심 설정

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DATA_BACKEND` | `memory` | `memory` 또는 `postgres` |
| `DATABASE_URL` | — | PostgreSQL 연결 문자열 (`postgres` 백엔드 시 필수) |
| `SCAN_EXECUTION_MODE` | `mock` | `mock` 또는 `native` |
| `TENANT_AUTH_MODE` | `disabled` | `disabled` 또는 `required` |
| `AUTH_MODE` | `header` | `header` 또는 `jwt` (`TENANT_AUTH_MODE=required` 시 적용) |

---

## 스캔 워커

| 변수 | 기본값 | 설명 |
|---|---|---|
| `SCAN_RETRY_BACKOFF_BASE_MS` | `100` | 재시도 백오프 기준값(ms) |
| `SCAN_MAX_RETRIES` | `2` | 최대 재시도 횟수 |

---

## Tenant RLS

| 변수 | 기본값 | 설명 |
|---|---|---|
| `TENANT_RLS_MODE` | `off` | `off`, `shadow`, `enforce` |
| `TENANT_RLS_RUNTIME_GUARD_MODE` | `off` | `off`, `warn`, `enforce` |
| `TENANT_RLS_RUNTIME_GUARD_STARTUP_WARN` | `false` | `enforce` + `guard=off` 조합에서 startup 경고 |
| `TENANT_AUDIT_LOG_RETENTION_DAYS` | — | 감사 로그 보존 기간(일). 미설정 시 비활성화 |

---

## JWT 인증 (`AUTH_MODE=jwt`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `JWT_ISSUER` | — | JWT issuer (필수) |
| `JWT_AUDIENCE` | — | JWT audience (필수) |
| `JWT_JWKS_URL` | — | JWT JWKS endpoint (필수, http/https) |
| `JWT_TENANT_ID_CLAIM` | `tenant_id` | tenantId primary claim selector |
| `JWT_TENANT_ID_FALLBACK_CLAIMS` | `tid` | tenantId fallback selector (CSV, 빈 문자열이면 비활성) |
| `JWT_USER_ID_CLAIM` | `sub` | userId primary claim selector |
| `JWT_USER_ID_FALLBACK_CLAIMS` | `user_id` | userId fallback selector (CSV) |
| `JWT_ROLE_CLAIM` | `role` | role primary claim selector |
| `JWT_ROLE_FALLBACK_CLAIMS` | `roles[0]` | role fallback selector (CSV) |

---

## Google OIDC

| 변수 | 기본값 | 설명 |
|---|---|---|
| `OIDC_GOOGLE_CLIENT_ID` | — | Google OAuth client id (필수) |
| `OIDC_GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret (필수) |
| `OIDC_GOOGLE_REDIRECT_URI` | — | Google OAuth redirect URI (필수) |

---

## 플랫폼 JWT 발급

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PLATFORM_JWT_PRIVATE_KEY_PEM` | — | 플랫폼 access token 서명 개인키(PEM) |
| `PLATFORM_JWT_PUBLIC_KEY_PEM` | — | 플랫폼 access token 공개키(PEM, JWKS 노출용) |
| `PLATFORM_JWT_KID` | — | 플랫폼 JWKS key id |
| `PLATFORM_JWT_ISSUER` | `https://devsecops.local` | 플랫폼 access token issuer |
| `PLATFORM_JWT_AUDIENCE` | `devsecops-api` | 플랫폼 access token audience |
| `PLATFORM_JWT_ACCESS_TTL_SEC` | `3600` | 플랫폼 access token 만료(초) |

---

## GitHub 연동

| 변수 | 기본값 | 설명 |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | — | webhook 시그니처 검증 시크릿 (선택) |
| `GITHUB_APP_ID` | — | GitHub App ID (미구현, 향후 예정) |
| `DEVSECOPS_API_URL` | — | GitHub Actions에서 사용할 API 베이스 URL |

---

## GitHub Actions Secrets/Variables

배포 워크플로우에 필요한 설정. 상세는 [`docs/workflow/DEPLOYMENT.md`](workflow/DEPLOYMENT.md) 참조.

### Staging

| 종류 | 이름 | 필수 |
|---|---|---|
| Secret | `STAGING_DEPLOY_WEBHOOK_URL` | 필수 |
| Secret | `STAGING_DEPLOY_WEBHOOK_TOKEN` | 필수 |
| Variable | `STAGING_SMOKE_API_HEALTH_URL` | 필수 |
| Variable | `STAGING_SMOKE_WEB_HEALTH_URL` | 필수 |
| Secret | `STAGING_RLS_CANARY_ALLOWED_HEADERS` | 선택 |
| Secret | `STAGING_RLS_CANARY_DENIED_HEADERS` | 선택 |
| Variable | `STAGING_RLS_CANARY_ENABLED` | 선택 |
| Variable | `STAGING_RLS_CANARY_API_BASE_URL` | 선택 |
| Variable | `STAGING_RLS_CANARY_PROBE_PATH` | 선택 |
| Variable | `STAGING_RLS_CANARY_EXPECT_ALLOWED_STATUS` | 선택 |
| Variable | `STAGING_RLS_CANARY_EXPECT_DENIED_STATUSES` | 선택 |

### Production

| 종류 | 이름 | 필수 |
|---|---|---|
| Secret | `PRODUCTION_DEPLOY_WEBHOOK_URL` | 필수 |
| Secret | `PRODUCTION_DEPLOY_WEBHOOK_TOKEN` | 필수 |
| Variable | `PRODUCTION_SMOKE_API_HEALTH_URL` | 필수 |
| Variable | `PRODUCTION_SMOKE_WEB_HEALTH_URL` | 필수 |

### Terraform

| 종류 | 이름 | 필수 |
|---|---|---|
| Secret | `AWS_ROLE_TO_ASSUME` | OIDC 방식 (권장) |
| Secret | `AWS_ACCESS_KEY_ID` | Static 방식 (대안) |
| Secret | `AWS_SECRET_ACCESS_KEY` | Static 방식 (대안) |
| Secret | `AWS_SESSION_TOKEN` | 선택 |
| Variable | `TERRAFORM_AWS_REGION` | 선택 |
