# Previo

스타트업(초기 1~5명 팀)을 위한 **DevSecOps 플랫폼**.

보안 전담 인력이 없는 작은 개발팀이, 복잡한 설정 없이 **SAST + SCA + Secret 스캔**을 CI 흐름에 붙일 수 있도록 만드는 프로젝트다.

---

## 기술 스택

| 영역 | 선택 |
|---|---|
| Frontend | Next.js 15 (App Router) + TypeScript |
| Backend | Fastify 5 + TypeScript (ESM) |
| Database | PostgreSQL (인메모리 모드 지원) |
| 보안 스캔 | Semgrep (SAST) + Trivy (SCA) + Gitleaks (Secret) |
| CI/CD | GitHub Actions |
| 인프라 | Terraform + AWS (VPC/RDS/ECS/S3) |
| 패키지 매니저 | pnpm workspace (모노레포) |
| 테스트 | Vitest + Supertest |

---

## 빠른 시작

```bash
pnpm install
cp .env.example .env
docker compose up -d            # PostgreSQL (선택)

pnpm --filter @previo/api dev   # API: localhost:3001
pnpm --filter @previo/web dev   # Web: localhost:3000
```

### 검증

```bash
pnpm --filter @previo/api test
pnpm --filter @previo/api typecheck
pnpm --filter @previo/web typecheck
pnpm --filter @previo/api build
pnpm --filter @previo/web build
```

---

## 주요 기능

### API (`apps/api`)

- **보안 스캔 파이프라인**: 스캔 요청 → 큐 적재 → 워커 처리 → 결과 저장
  - 3개 엔진(Semgrep/Trivy/Gitleaks) 통합
  - retry + exponential backoff + dead-letter 지원
  - mock/native 실행 모드 전환 (`SCAN_EXECUTION_MODE`)
- **멀티테넌시**: 조직/멤버십/초대/감사로그 관리
  - Header 또는 JWT 기반 인증 (`TENANT_AUTH_MODE` + `AUTH_MODE`)
  - PostgreSQL Row-Level Security 단계적 적용
- **Google OIDC 로그인**: code 교환 → 플랫폼 JWT 발급
- **GitHub 연동**: webhook 수신 → push/PR 이벤트에서 자동 스캔 트리거
- **데이터 백엔드**: 인메모리 또는 PostgreSQL 선택 (`DATA_BACKEND`)

### Web (`apps/web`)

- **대시보드**: 스캔 현황, findings 통계, 큐 상태 (5초 자동 새로고침)
- **스캔 상세**: 메타 정보, 상태별 해결 가이드, findings severity
- **리포트**: HTML 다운로드, 필터/정렬/검색, 반응형 디자인

---

## GitHub Actions

> 모든 워크플로우는 **graceful skip** 패턴 — secrets가 없으면 배포 단계만 스킵하고 워크플로우는 실패하지 않는다.

### 설정 없이 바로 동작

| 워크플로우 | 트리거 | 하는 일 |
|---|---|---|
| CI (`ci.yml`) | push/PR → main | typecheck → test → build |
| Security Scan (`security-scan.yml`) | PR → main | Semgrep + Trivy + Gitleaks 스캔 + PR 코멘트 |
| Terraform PR Checks (`terraform-pr-checks.yml`) | PR (infra 변경) | fmt/validate/plan 검증 |

### 배포 활성화

GitHub 리포지토리 **Settings → Secrets and variables → Actions**에서 설정:

| 환경 | 종류 | 이름 | 설명 |
|---|---|---|---|
| Staging | Secret | `STAGING_DEPLOY_WEBHOOK_URL` | 배포 트리거 웹훅 URL |
| Staging | Secret | `STAGING_DEPLOY_WEBHOOK_TOKEN` | 웹훅 인증 Bearer 토큰 |
| Staging | Variable | `STAGING_SMOKE_API_HEALTH_URL` | 예: `https://api-staging.example.com/health` |
| Staging | Variable | `STAGING_SMOKE_WEB_HEALTH_URL` | 예: `https://staging.example.com` |
| Production | Secret | `PRODUCTION_DEPLOY_WEBHOOK_URL` | 배포 트리거 웹훅 URL |
| Production | Secret | `PRODUCTION_DEPLOY_WEBHOOK_TOKEN` | 웹훅 인증 Bearer 토큰 |
| Production | Variable | `PRODUCTION_SMOKE_API_HEALTH_URL` | 예: `https://api.example.com/health` |
| Production | Variable | `PRODUCTION_SMOKE_WEB_HEALTH_URL` | 예: `https://example.com` |

Terraform AWS 인증 (선택): `AWS_ROLE_TO_ASSUME` (OIDC 권장) 또는 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`

상세 계약은 [`docs/workflow/DEPLOYMENT.md`](docs/workflow/DEPLOYMENT.md) 참조.

---

## 프로젝트 구조

```
previo/
├── apps/
│   ├── api/                  # Fastify API (@previo/api)
│   └── web/                  # Next.js Web (@previo/web)
├── infra/
│   ├── docker/               # Docker Compose 설정
│   ├── terraform/            # AWS IaC (VPC/RDS/ECS/S3)
│   └── scripts/              # 운영 스크립트
├── .github/
│   ├── workflows/            # CI/CD 워크플로우
│   └── actions/              # 재사용 Composite Actions
└── docs/                     # 상세 문서
```

---

## 현재 제약 사항

- **Mock 모드 기본**: `SCAN_EXECUTION_MODE=mock`이 기본값 (deterministic 더미 데이터)
- **인증 제한**: API OIDC + JWT 발급 구현 완료, 웹 로그인 UX/세션 처리는 미구현
- **GitHub App 미연동**: Check Run 등 GitHub API 미구현 (PR Comment는 Composite Action으로 구현)
- **Tenant RLS opt-in**: 기본값 `off`, `shadow` → `enforce` 단계적 적용
- **클라이언트 필터링**: 엔진 필터/검색은 클라이언트사이드 처리

---

## 문서

| 문서 | 내용 |
|---|---|
| [`docs/API.md`](docs/API.md) | API 라우트, 인증 계약, 오류 코드 |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | 전체 환경변수 목록 |
| [`docs/workflow/DEPLOYMENT.md`](docs/workflow/DEPLOYMENT.md) | 배포 전략, 체크리스트, 시크릿 계약 |
| [`docs/workflow/DECISIONS.md`](docs/workflow/DECISIONS.md) | 확정 의사결정 / 리스크 |
| [`docs/architecture/AUTH_TRANSITION.md`](docs/architecture/AUTH_TRANSITION.md) | Header → JWT/OAuth 전환 설계 |
| [`docs/architecture/TENANT_RLS_ROLLOUT.md`](docs/architecture/TENANT_RLS_ROLLOUT.md) | Tenant RLS 도입 설계 + 운영 runbook |
| [`infra/terraform/OPERATOR_HANDOFF.md`](infra/terraform/OPERATOR_HANDOFF.md) | Terraform 운영자 핸드오프 |
