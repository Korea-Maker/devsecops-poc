# devsecops-poc 작업 가이드 (Claude)

## 프로젝트 개요

스타트업 개발팀(1~5명)을 위한 DevSecOps PoC.

- MVP 보안 범위: **SAST + SCA + Secret**
- 아키텍처: **Next.js + Fastify + PostgreSQL**
- 인증 방향: **Google SSO(후속 Phase 구현)**
- CI 연동 방향: **GitHub App(후속 Phase 구현)**

## 디렉터리

```bash
apps/api/            # Fastify API (@devsecops/api)
apps/web/            # Next.js Web (@devsecops/web)
docs/workflow/       # 의사결정/실행 문서
```

---

## 검증 명령어 (pnpm 고정)

아래 순서대로 실행한다.

```bash
pnpm install
pnpm --filter @devsecops/api test
pnpm --filter @devsecops/api typecheck
pnpm --filter @devsecops/web typecheck
pnpm --filter @devsecops/api build
pnpm --filter @devsecops/web build
```

### 빠른 최소 검증 (필수)

```bash
pnpm --filter @devsecops/api test
pnpm --filter @devsecops/api typecheck
```

---

## 코딩 규칙

- 언어: TypeScript
- 문서/주석/커뮤니케이션: 한국어 기본
- 환경변수/시크릿: 커밋 금지 (`.env` 금지)
- 범위 밖 구현은 TODO로 명시하고 무리해서 확장하지 않는다
- 다파일/중간 이상 난이도 구현은 기본적으로 ` /team ` 모드로 진행하고, 단순 수정만 단일 에이전트로 처리한다

---

## 참고 문서

- `README.md`
- `docs/workflow/DECISIONS.md`
