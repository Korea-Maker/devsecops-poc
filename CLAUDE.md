# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

스타트업 개발팀(1~5명)을 위한 DevSecOps PoC. SAST(Semgrep) + SCA(Trivy) + Secret(Gitleaks) 스캔을 통합하고, 대시보드와 GitHub CI/CD 연동을 제공한다.

- 아키텍처: **Fastify 5 API + Next.js 15 Web** (pnpm workspace 모노레포)
- 데이터: 인메모리 Map 스토어 (PostgreSQL 연동 예정)
- 인증: 미구현 (Google SSO 후속 Phase)

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
```

## 아키텍처

### API (`apps/api`) — `@devsecops/api`

ESM(`"type": "module"`) 기반 Fastify 5 서버. `buildApp()` (`src/app.ts`)에서 플러그인 등록.

**라우트 구조:**
- `src/routes/health.ts` — `GET /health`
- `src/routes/scans.ts` — 스캔 CRUD + 큐 관리 (`/api/v1/scans/*`)
- `src/routes/github.ts` — GitHub webhook 수신 (`/api/v1/github/*`)

**스캐너 핵심 흐름:** `POST /api/v1/scans` → `store.createScan()` → `queue.enqueueScan()` → 워커가 `processNextScanJob()` 호출 → `source-prep.prepareScanSource()` → `registry.getAdapter(engine).scan()` → 결과를 `store.updateScanMeta()`에 저장

**스캐너 모듈 (`src/scanner/`):**
- `types.ts` — `ScanAdapter` 인터페이스, `ScanEngineType`, `ScanStatus` 등 핵심 타입
- `store.ts` — 인메모리 Map 기반 스캔 레코드 CRUD (`createScan`, `getScan`, `listScans`, `updateScanStatus`, `updateScanMeta`)
- `queue.ts` — 인메모리 FIFO 큐 + 워커 + retry(exponential backoff) + dead-letter. `processNextScanJob()`이 핵심 처리 루프
- `registry.ts` — 엔진 어댑터 레지스트리 (semgrep/trivy/gitleaks)
- `source-prep.ts` — repoUrl 분류(`classifyRepoUrlInput`) + native 모드 시 git clone 관리
- `adapters/common.ts` — mock/native 모드 분기, CLI 실행 헬퍼, severity 정규화, deterministic mock 생성
- `adapters/{semgrep,trivy,gitleaks}.ts` — 각 엔진별 `ScanAdapter` 구현 (mock + native 모드)

**테넌트 모듈 (`src/tenants/`):** 멀티테넌시 기반. 인증 미구현 시 `DEFAULT_TENANT_ID = 'default'` 사용.

**GitHub 연동 (`src/integrations/github/`):** webhook 수신 → HMAC-SHA256 시그니처 검증 → push/PR 이벤트에서 스캔 트리거 추출 → 3개 엔진 스캔 자동 생성.

### Web (`apps/web`) — `@devsecops/web`

Next.js 15 App Router. `next.config.ts`에서 `/api/*` 요청을 `localhost:3001`로 프록시.

- `src/lib/api.ts` — API 호출 래퍼 (`fetchScans`, `fetchScan`, `fetchQueueStatus`, `fetchDeadLetters`)
- `src/lib/types.ts` — 프론트엔드 타입 정의
- `src/app/page.tsx` — 대시보드 (5초 자동 새로고침, 필터/정렬/검색)
- `src/app/scans/[id]/page.tsx` — 스캔 상세
- `src/app/reports/[id]/page.tsx` — 리포트 (HTML 다운로드)

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

## 코딩 규칙

- 언어: TypeScript (strict mode, ESM)
- 문서/주석/커뮤니케이션: 한국어 기본
- 환경변수/시크릿: `.env` 커밋 금지
- 오류 응답: `{ error: string, code?: string }` 형태 통일
- import 경로: `.js` 확장자 포함 (ESM 요구사항, 예: `from './store.js'`)
- 범위 밖 구현은 TODO로 명시

## 참고 문서

- `README.md` — 전체 구현 상태, API 계약, 환경변수 목록
- `docs/workflow/DECISIONS.md` — 확정 의사결정/리스크
