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

## 현재 구현 상태 (Phase 1)

### API (`apps/api`)

- `GET /health` → `{ ok: true, service: "api" }`
- `POST /api/v1/scans` → `501` stub (`TODO` 포함)

### Web (`apps/web`)

- Next.js App Router 최소 화면
- 프로젝트 요약, 확정 의사결정, API 연결 노트 표시

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
```

---

## 문서

- `docs/workflow/DECISIONS.md`: 확정 의사결정 / 미결정 / 리스크
- `CLAUDE.md`: 프로젝트 작업 규칙 및 검증 루틴
