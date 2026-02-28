# AUTH_TRANSITION.md — Header 기반 인증에서 JWT/OAuth로 전환하기

## 문서 목적

Phase 5에서 도입한 테넌트/RBAC 계약을 유지하면서, 인증 소스를 **header → JWT/OAuth**로 옮기는 경계/신뢰 모델/롤아웃 절차를 명확히 정의한다.

---

## 1) Auth Boundary (인증 경계)

### 현재(운영 중)

- `TENANT_AUTH_MODE=disabled`
  - 기존 동작 유지 (`tenantId=default`)
- `TENANT_AUTH_MODE=required` + `AUTH_MODE=header`
  - 아래 헤더 기반으로 요청 컨텍스트 구성
    - `x-tenant-id` (선택, 기본값 `default`)
    - `x-user-id` (필수)
    - `x-user-role` (필수: `owner|admin|member|viewer`)
- `TENANT_AUTH_MODE=required` + `AUTH_MODE=jwt`
  - `Authorization: Bearer <token>` 검증
  - JOSE + remote JWKS 기반 서명 검증(`RS256`, `ES256`)
  - `iss`/`aud` 환경변수 검증
  - 검증 성공 후 claims에서 tenant/user/role 컨텍스트 구성

### JWT claim 매핑 계약

- `tenantId`: `tenant_id` (fallback `tid`) — required
- `userId`: `sub` (fallback `user_id`) — required
- `role`: `role` (fallback `roles[0]`) — required
  - 허용값: `owner | admin | member | viewer`

---

## 2) Trust Model

| 경계 | Header 모드 신뢰 | JWT 모드 신뢰 |
|---|---|---|
| Client → API | 헤더 주입 주체(내부 게이트웨이/프록시) | JWT 서명 + issuer/audience 검증 결과 |
| API 내부 RBAC | `tenantContext.role` 기반 | 동일 |
| 테넌트 격리 | `tenantContext.tenantId` 기반 | 동일 |

핵심 원칙:

1. **검증 전 claim은 신뢰하지 않는다.**
2. `TENANT_AUTH_MODE` 계약은 유지해 기존 클라이언트/테스트를 깨지 않는다.
3. 전환 기간에는 `AUTH_MODE=header`를 fallback으로 유지하고 점진 전환한다.

---

## 3) 환경변수 계약

### 기존(유지)

- `TENANT_AUTH_MODE=disabled|required`
- `AUTH_MODE=header|jwt` (기본 `header`)

### JWT 모드에서 필수

- `JWT_ISSUER`
- `JWT_AUDIENCE`
- `JWT_JWKS_URL` (`http/https` URL)

유효성 규칙:

- 필수값 누락 시 `503 TENANT_AUTH_JWT_CONFIG_INCOMPLETE`
- `JWT_JWKS_URL` 형식 오류 시 `503 TENANT_AUTH_JWT_CONFIG_INVALID`

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

### JWT 모드

- 토큰/헤더/서명/클레임
  - `TENANT_AUTH_BEARER_TOKEN_REQUIRED` (401)
  - `TENANT_AUTH_INVALID_AUTHORIZATION_HEADER` (401)
  - `TENANT_AUTH_INVALID_BEARER_TOKEN` (401)
  - `TENANT_AUTH_INVALID_BEARER_TOKEN_SIGNATURE` (401)
  - `TENANT_AUTH_JWT_ISSUER_MISMATCH` (401)
  - `TENANT_AUTH_JWT_AUDIENCE_MISMATCH` (401)
  - `TENANT_AUTH_TENANT_ID_CLAIM_REQUIRED` (401)
  - `TENANT_AUTH_USER_ID_CLAIM_REQUIRED` (401)
  - `TENANT_AUTH_USER_ROLE_CLAIM_REQUIRED` (401)
  - `TENANT_AUTH_INVALID_USER_ROLE_CLAIM` (401)
- 설정/JWKS
  - `TENANT_AUTH_JWT_CONFIG_INCOMPLETE` (503)
  - `TENANT_AUTH_JWT_CONFIG_INVALID` (503)
  - `TENANT_AUTH_JWKS_UNREACHABLE` (503)
  - `TENANT_AUTH_JWKS_INVALID` (503)

---

## 5) 롤아웃 노트

### Step 0. 기본 안정화

- 기본값 유지: `TENANT_AUTH_MODE=disabled`, `AUTH_MODE=header`
- 기존 header 기반 클라이언트/테스트는 그대로 동작

### Step 1. IdP 연동 준비

- issuer/audience/JWKS endpoint 확정
- access token claim 스키마를 아래 계약으로 정렬
  - `tenant_id|tid`, `sub|user_id`, `role|roles[0]`

### Step 2. Staging JWT 카나리

- `TENANT_AUTH_MODE=required`, `AUTH_MODE=jwt` 적용
- 인증 실패율(401), 설정 오류(503), tenant 격리 회귀 테스트 관찰

### Step 3. 프로덕션 점진 전환

- 서비스 단위로 `AUTH_MODE=jwt` 전환
- 문제 발생 시 즉시 `AUTH_MODE=header`로 롤백 가능

### Step 4. Header 모드 정리(선택)

- 모든 연동 완료 후 header 모드 제거 여부를 결정
- 제거 전 운영/보안 요구사항(내부 프록시 의존도, 장애 대응 절차) 검토

---

## 6) 남은 TODO

- [ ] OAuth 로그인/토큰 발급 플로우(웹) 연결
- [ ] 운영 관측 지표(인증 실패율, 토큰 검증 지연) 추가
- [ ] key rotation/키 폐기(runbook) 운영 가이드 문서화
