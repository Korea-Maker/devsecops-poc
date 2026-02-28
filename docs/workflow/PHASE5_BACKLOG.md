# Phase 5: 멀티 테넌시 + 인증/인가 백로그

## 목표

스캔 API에 최소한의 멀티 테넌트 격리와 헤더 기반 인증/인가를 도입해,
조직(tenant) 간 데이터 노출을 차단하는 기반을 완성한다.

---

## 이번 반영 범위 (완료)

- [x] Fastify 요청 단위 tenant/auth 컨텍스트 미들웨어 추가
  - 파일: `apps/api/src/tenants/auth.ts`
  - 환경변수: `TENANT_AUTH_MODE=disabled|required` (기본 `disabled`)
  - `required` 모드 헤더 계약:
    - `x-tenant-id` (선택, 미전달 시 `default`)
    - `x-user-id` (필수)
    - `x-user-role` (필수: `owner|admin|member|viewer`)
  - 역할 비교 헬퍼(`hasRoleAtLeast`) + 최소 권한 체크(`requireMinimumRole`) 제공

- [x] Scans API tenant 격리 적용
  - `POST /api/v1/scans`: tenant context의 `tenantId`를 scan 레코드에 저장
  - `GET /api/v1/scans`: 요청 tenant 스캔만 반환 (`status` 필터 유지)
  - `GET /api/v1/scans/:id`: 타 tenant 스캔 접근 시 `404`

- [x] Queue/Dead-letter endpoint tenant 누수 방지(실용적 필터)
  - `GET /api/v1/scans/queue/status`: tenant 필터 기반 집계 지원
  - `GET /api/v1/scans/dead-letters`: tenant 범위만 반환
  - `POST /api/v1/scans/:id/redrive`: 타 tenant 항목은 `not_found` 처리
  - `TENANT_AUTH_MODE=required`일 때 위 3개 endpoint는 `admin` 이상 권한 필요
  - `TENANT_AUTH_MODE=disabled`에서는 기존 동작 유지

- [x] Tenant 도메인/스토어 보강
  - 파일: `apps/api/src/tenants/store.ts`
  - 기본 tenant bootstrap 유지 (`default`)
  - 입력 검증(name/slug 비어있음 방지)
  - slug 중복 생성 방지 (`TENANT_DUPLICATE_SLUG`)
  - `clearOrganizationStore()` 이후에도 기본 tenant 재부팅

- [x] 테스트/문서 갱신
  - API 테스트 추가:
    - tenant 격리(list/get)
    - `TENANT_AUTH_MODE=required` 헤더 누락/역할 오류
    - queue/dead-letter admin 권한 검사
  - README에 멀티테넌시/헤더 계약/환경변수 문서화

---

## 아직 남은 작업 (Phase 5 후속)

- [ ] 실제 인증 체계 연동 (JWT/OAuth/SSO) 및 헤더 신뢰 경계 정립
- [ ] 조직/멤버십 CRUD API (org 생성, 멤버 초대/역할 변경)
- [ ] queue/process-next tenant 정책 정리 (tenant 단위 수동 처리 전략)
- [ ] DB 영속화 + tenant 인덱싱/행 수준 격리(RLS) 설계
- [ ] 감사 로그(누가 어떤 tenant 리소스에 접근/재처리했는지)
- [ ] SaaS 인프라(IaC) 및 staging/prod 배포 파이프라인 고도화

---

## 참고

- `docs/workflow/MASTER_PLAN.md` (Phase 5 상위 목표)
- `README.md` (현재 API 계약/환경변수)
