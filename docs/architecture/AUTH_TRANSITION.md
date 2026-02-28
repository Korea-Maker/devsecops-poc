# AUTH_TRANSITION.md — Header 기반 인증에서 JWT/OAuth로 전환하기

## 문서 목적

Phase 5에서 도입한 테넌트/RBAC 계약을 유지하면서, 인증 소스를 **header → JWT/OAuth**로 옮기는 경계/신뢰 모델/롤아웃 절차를 명확히 정의한다.

---

## 1) Auth Boundary (인증 경계)

### 현재(운영 중)

- API 내부 경계에서 아래 헤더를 신뢰해 요청 컨텍스트를 구성한다.
  - `x-tenant-id` (선택, 기본값 `default`)
  - `x-user-id` (필수)
  - `x-user-role` (필수: `owner|admin|member|viewer`)
- 강제 여부는 `TENANT_AUTH_MODE=disabled|required`로 제어한다.

### 전환 준비(스캐폴드)

- 인증 소스 선택 변수 추가:
  - `AUTH_MODE=header|jwt` (기본값 `header`)
- `AUTH_MODE=jwt` 시 `Authorization: Bearer <token>`를 읽고 JWT 구조를 검사한다.
- 단, 현재는 **서명 검증(JWKS/JOSE)이 미구현**이므로 토큰을 신뢰하지 않고 `501 TENANT_AUTH_JWT_NOT_IMPLEMENTED`로 종료한다.

### 목표(최종)

- API가 외부 Bearer 토큰(JWT)을 직접 검증한다.
- `tenant/user/role` 컨텍스트를 검증된 claims에서 추출한다.
- OAuth/OIDC(IdP) 연동은 토큰 발급·수명·회전(rotate) 책임, API는 검증·인가 책임을 가진다.

---

## 2) Trust Model

| 경계 | 현재 신뢰 | 목표 신뢰 |
|---|---|---|
| Client → API | 헤더 주입 주체(내부 게이트웨이/프록시)를 신뢰 | JWT 서명 + issuer/audience/exp 검증 결과를 신뢰 |
| API 내부 RBAC | `tenantContext.role` 기반 | 동일 (입력 소스만 헤더 → JWT claims로 변경) |
| 테넌트 격리 | `tenantContext.tenantId` 기반 | 동일 |

핵심 원칙:

1. **검증 전 claim은 신뢰하지 않는다.**
2. `TENANT_AUTH_MODE` 계약은 유지하여 기존 클라이언트/테스트를 깨지 않는다.
3. 전환은 “토큰 발급 먼저 → API 검증 활성화 나중” 순서로 점진 적용한다.

---

## 3) 환경변수 계약

### 기존(유지)

- `TENANT_AUTH_MODE=disabled|required`

### 신규(전환용)

- `AUTH_MODE=header|jwt` (기본 `header`)
- `JWT_ISSUER` (placeholder)
- `JWT_AUDIENCE` (placeholder)
- `JWT_JWKS_URL` (placeholder)

주의:

- 현재 스캐폴드에서 `AUTH_MODE=jwt`를 사용하면,
  - 토큰/헤더 형식 오류는 401
  - JWT 설정값 누락은 503
  - 설정값이 있어도 검증 미구현으로 501

---

## 4) API 에러 계약

공통 shape:

```json
{ "error": "string", "code": "string(optional)" }
```

### Header 모드

- `TENANT_AUTH_USER_ID_REQUIRED` (401)
- `TENANT_AUTH_USER_ROLE_REQUIRED` (401)
- `TENANT_AUTH_INVALID_USER_ROLE` (400)
- `TENANT_FORBIDDEN` (403)

### JWT 모드(스캐폴드)

- `TENANT_AUTH_BEARER_TOKEN_REQUIRED` (401)
- `TENANT_AUTH_INVALID_AUTHORIZATION_HEADER` (401)
- `TENANT_AUTH_INVALID_BEARER_TOKEN` (401)
- `TENANT_AUTH_JWT_CONFIG_INCOMPLETE` (503)
- `TENANT_AUTH_JWT_NOT_IMPLEMENTED` (501)

---

## 5) 마이그레이션/롤아웃 플랜

### Step 0. 현재 상태 고정

- 운영은 `TENANT_AUTH_MODE=required`, `AUTH_MODE=header` 유지.
- 기존 헤더 기반 클라이언트/테스트 계약 유지.

### Step 1. IdP 준비

- OAuth/OIDC provider에서 issuer/audience/JWKS endpoint 확정.
- access token claim 스키마 확정(예: `sub`, `tenant_id`, `role`).

### Step 2. API JWT 검증 구현

- JOSE/JWKS 기반 서명 검증 + `iss/aud/exp/nbf` 검증 구현.
- 검증 성공 시 `tenantContext`를 JWT claims에서 구성.
- role claim 유효성(`owner|admin|member|viewer`) 강제.

### Step 3. 카나리 배포

- staging에서 `AUTH_MODE=jwt` 적용.
- 401/403/5xx 지표 관찰 + tenant 격리 회귀 테스트 실행.

### Step 4. 프로덕션 전환

- 점진적으로 서비스 단위 `AUTH_MODE=jwt` 전환.
- 헤더 모드는 일정 기간 fallback으로 유지 후 제거 여부 결정.

---

## 6) 남은 TODO

- [ ] JWT 서명 검증(JWKS) 구현
- [ ] claim 매핑 스펙 문서화(`tenant_id`, `role` 표준화)
- [ ] OAuth 로그인/토큰 발급 플로우(웹) 연결
- [ ] 운영 관측 지표(인증 실패율, 토큰 검증 지연) 추가
