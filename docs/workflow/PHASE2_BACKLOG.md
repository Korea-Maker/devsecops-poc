# Phase 2 백로그 — 스캔 인프라 MVP

> 업데이트: 2026-02-27
> 목적: Phase 2 Week 1 (이번 주)에 구현할 5개 핵심 목표와 검증 기준을 명시한다.
> 대상: scanner 도메인 공통 타입 → 어댑터 구현 → API 라우트 통합
>
> 문서 표기 규칙:
> - **현재 계약(Current Contract)**: 지금 코드베이스에서 실제로 동작/유지하는 기준
> - **초기 계획(역사)**: Week 1 당시 목표/예시로, 현재 구현과 다를 수 있는 기록

---

## 이번 주 구현 목표 (5개)

| # | 목표 | 소유 파일 | 예상 시간 | 의존성 |
|---|------|---------|---------|--------|
| 1 | 스캔 도메인 공통 타입 정의 | `apps/api/src/scanner/types.ts` | 1-2h | 없음 |
| 2 | SAST/SCA/Secret 어댑터 구현 (현재: mock/native 기본 구현, 역사: 스텁 계획) | `apps/api/src/scanner/adapters/{semgrep,trivy,gitleaks}.ts` | 2-3h | #1 |
| 3 | 어댑터 Registry 구현 (현재: `getAdapter`/`listEngines`) | `apps/api/src/scanner/registry.ts` | 1-2h | #1 |
| 4 | POST /api/v1/scans → 202 응답 | `apps/api/src/routes/scans.ts` | 1-2h | #1, #3 |
| 5 | GET /api/v1/scans/:id 상태 조회 | `apps/api/src/routes/scans.ts` | 1-2h | #4 |

---

## 목표 1: 스캔 도메인 공통 타입 정의

### 설명
`scanner/types.ts`에서 스캔 도메인 공통 타입을 정의한다.
- **ScanEngineType**: `'semgrep' | 'trivy' | 'gitleaks'`
- **ScanRequest**: 스캔 요청 입력 (`id`, `engine`, `repoUrl`, `branch`, `status`, `createdAt`)
- **ScanResultSummary**: 스캔 결과 요약 (`scanId`, `engine`, 취약점 카운트, `completedAt`)
- **ScanAdapter**: 모든 어댑터가 구현해야 할 인터페이스(`scan(request)`)

### 검증 기준

| 기준 | 체크 항목 |
|-----|---------|
| 타입 정의 완성 | `ScanEngineType`, `ScanRequest`, `ScanResultSummary`, `ScanAdapter` 모두 export 됨 |
| 타입체크 통과 | `pnpm --filter @devsecops/api typecheck` 0 errors |
| 인터페이스 명확성 | `ScanAdapter` 인터페이스에 `scan(request)` 메서드 시그니처 포함 |
| 상태 정의 | 스캔 상태: `'queued' \| 'running' \| 'completed' \| 'failed'` |

---

## 목표 2: SAST/SCA/Secret 어댑터 구현

### 현재 계약 (Current Contract, Phase 2-6 기준)
`scanner/adapters/`의 3개 어댑터는 모두 `ScanAdapter`를 구현하며, 아래 동작을 제공한다.

- `SCAN_EXECUTION_MODE=mock`: 입력 기반 deterministic 결과 반환
- `SCAN_EXECUTION_MODE=native`: semgrep/trivy/gitleaks CLI 실행 + JSON 파싱 + findings 집계
- native 실패 시 엔진명 포함 에러 메시지 계약 유지
  - 실행 실패: `[engine] native 실행 실패: ...`
  - 결과 형식 실패: `[engine] native 결과 형식 오류: ...`

### 초기 계획(역사)
Week 1 초기 계획에서는 아래처럼 TODO 스텁만 우선 배치하는 목표였다.

#### semgrep.ts (역사 예시)
```typescript
// ScanAdapter 구현
// scan(): TODO - semgrep CLI 호출 로직
// parseResults(): TODO - SARIF 또는 JSON 파싱
```

#### trivy.ts (역사 예시)
```typescript
// ScanAdapter 구현
// scan(): TODO - trivy CLI 호출 로직
// parseResults(): TODO - JSON 파싱
```

#### gitleaks.ts (역사 예시)
```typescript
// ScanAdapter 구현
// scan(): TODO - gitleaks CLI 호출 로직
// parseResults(): TODO - JSON 파싱
```

> 위 스텁 중심 설명은 "초기 계획" 기록이며, 현재 코드는 이미 실행 경로(mock/native)를 포함한다.

### 검증 기준 (현재 계약)

| 기준 | 체크 항목 |
|-----|---------|
| 파일 구성 | 3개 어댑터 모두 `ScanAdapter` 구현 |
| 실행 모드 분기 | `mock`/`native` 분기 동작 (`SCAN_EXECUTION_MODE`) |
| native 에러 계약 | 실행/형식 오류 모두 엔진명 포함 메시지 보장 |
| 타입 안전 | `pnpm --filter @devsecops/api typecheck` 0 errors |

---

## 목표 3: 어댑터 Registry 구현

### 현재 계약 (Current Contract, Phase 2-6 기준)
`scanner/registry.ts`는 엔진별 어댑터 등록/조회에 대해 아래 두 함수를 제공한다.

- **`getAdapter(engineType: ScanEngineType): ScanAdapter`**
  엔진 타입에 따라 해당 어댑터 인스턴스를 반환한다.

- **`listEngines(): ScanEngineType[]`**
  등록된 엔진 목록을 반환한다.

### 초기 계획(역사)
초기 계획에는 `isEngineSupported(engineType: string): boolean`을 별도 export하는 요구가 있었다.

- 현재 구현에는 `isEngineSupported()`가 **없다**.
- 현재 코드 기준에서는 `listEngines().includes(engine as ScanEngineType)`로 대체 가능하다.
- `isEngineSupported()`를 별도 함수로 둘지는 후속 리팩터링 TODO로 관리한다.

### 검증 기준 (현재 계약)

| 기준 | 체크 항목 |
|-----|---------|
| Registry 함수 | `getAdapter()`, `listEngines()` export |
| 엔진 매핑 | `'semgrep'` → semgrep, `'trivy'` → trivy, `'gitleaks'` → gitleaks |
| 타입 안전 | registry 호출 시 정확한 어댑터 타입 반환 |
| TODO 명확성 | `isEngineSupported()`는 역사적 요구사항이며 현재 미구현임을 문서에 명시 |
| 커버리지 | `pnpm --filter @devsecops/api typecheck` 0 errors |

---

## 목표 4: POST /api/v1/scans → 202 큐 등록 응답

### 설명
`routes/scans.ts`의 POST 엔드포인트를 구현한다. 스캔 요청을 받아 in-memory 저장소에 등록하고, 현재 구현 계약에 맞는 202 응답을 반환한다.

#### 현재 구현 계약 (Current Contract)

##### 요청 (Request)
```json
{
  "engine": "semgrep",
  "repoUrl": "https://github.com/user/repo",
  "branch": "main"
}
```

- `branch` 생략 시 기본값은 `main`

##### 응답 (Response - 202 Accepted)
```json
{
  "scanId": "4b5f0e5e-7a12-4dbe-94db-2cf6f0b01b80",
  "status": "queued"
}
```

- POST 응답에는 `createdAt`이 포함되지 않음
- `createdAt`은 `GET /api/v1/scans/:id`에서 확인 가능

#### 초기 설계 예시 (역사)
기존 문서의 `repositoryUrl/engineType/configId`, `createdAt 포함 POST 응답` 예시는 초기 설계안이며, 현재 구현과는 다르다.

### 검증 기준

| 기준 | 체크 항목 |
|-----|---------|
| 엔드포인트 | POST /api/v1/scans 구현 |
| 응답 코드 | 202 Accepted |
| 응답 바디 | `{ scanId, status: 'queued' }` 포함 (`createdAt` 미포함) |
| scanId 생성 | 고유한 UUID 생성 (`randomUUID`) |
| 상태 저장 | in-memory `scanStore`에 레코드 저장 (`id`, `engine`, `repoUrl`, `branch`, `status`, `createdAt`, `retryCount`) |
| 타입체크 | `pnpm --filter @devsecops/api typecheck` 0 errors |

---

## 목표 5: GET /api/v1/scans/:id → 상태 조회

### 설명
`routes/scans.ts`의 GET 엔드포인트를 구현한다. `:id`로 저장된 스캔 레코드를 조회하고, 존재하면 200, 없으면 404를 반환한다.

#### 현재 구현 계약 (Current Contract)

##### 응답 예시 (200 OK)
```json
{
  "id": "4b5f0e5e-7a12-4dbe-94db-2cf6f0b01b80",
  "engine": "semgrep",
  "repoUrl": "https://github.com/user/repo",
  "branch": "main",
  "status": "queued",
  "createdAt": "2026-02-27T12:00:00.000Z",
  "retryCount": 0
}
```

- 응답 키는 `scanId`가 아니라 `id`
- 상태에 따라 `completedAt`, `lastError`가 추가될 수 있음

##### 응답 예시 (404 Not Found)
```json
{
  "error": "스캔을 찾을 수 없습니다"
}
```

#### 초기 설계 예시 (역사)
기존 문서의 `scanId/engineType/repositoryUrl/vulnerabilityCount` 예시는 초기 설계안이며, 현재 구현과는 다르다.

### 검증 기준

| 기준 | 체크 항목 |
|-----|---------|
| 엔드포인트 | GET /api/v1/scans/:id 구현 |
| 존재하는 스캔 | 200 응답 + 스캔 레코드 반환(`id`, `engine`, `repoUrl`, `branch`, `status`, `createdAt`, `retryCount`) |
| 존재하지 않는 스캔 | 404 응답 + 에러 메시지 |
| 테스트 3개 통과 | ① POST → scanId 생성, ② GET (존재O) → 200, ③ GET (존재X) → 404 |
| 타입체크 | `pnpm --filter @devsecops/api typecheck` 0 errors |

---

## 검증 체크리스트 (누적)

이 주의 모든 목표 완료 후 다음을 확인한다.

```
[ ] 목표 1: scanner/types.ts 정의 완료, typecheck 통과
[ ] 목표 2: 3개 어댑터 ScanAdapter 구현 + mock/native 실행 경로 확인
[ ] 목표 3: registry.ts 구현, getAdapter()/listEngines() export (isEngineSupported는 현재 미구현)
[ ] 목표 4: POST /api/v1/scans 구현, 202 응답, 테스트 1개 통과
[ ] 목표 5: GET /api/v1/scans/:id 구현, 테스트 3개 통과
[ ] 전체 typecheck: pnpm --filter @devsecops/api typecheck 0 errors
[ ] 전체 테스트: pnpm --filter @devsecops/api test 통과
[ ] 빌드: pnpm --filter @devsecops/api build 성공
```

---

## 다음 주 예고 (Week 2)

- 어댑터 실제 구현 (semgrep, trivy, gitleaks CLI 호출)
- 비동기 큐잉 (Job Queue 패턴)
- 스캔 결과 DB 저장소 통합
- E2E 테스트 (저장소 → 스캔 → 결과 확인)

---

## Phase 2-2 완료 항목

> 업데이트: 2026-02-27
> 목적: Phase 2-2에서 scans API를 실무 수준으로 강화한 내용을 기록한다.

### 완료 체크리스트

- [x] API 요청 검증 강화: POST /api/v1/scans에 engine/repoUrl/branch 검증 추가, 400 에러 응답
- [x] 조회 API 확장: GET /api/v1/scans 목록 조회 + status 쿼리 필터 지원
- [x] 도메인 분리: scanStore를 scanner/store.ts로 추출, scans.ts는 라우팅 중심으로 단순화
- [x] 테스트 보강: invalid engine/repoUrl 400 검증, 목록 조회, status 필터 등 테스트 케이스 추가
- [x] 코드 품질: 한국어 주석, 타입 안전성, 외부 스캐너 미구현(TODO 유지)

### 변경 파일

| 파일 | 변경 내용 |
|------|----------|
| `apps/api/src/scanner/store.ts` | 신규 - scanStore 도메인 로직 분리 |
| `apps/api/src/routes/scans.ts` | 수정 - 검증 추가, 목록 조회 엔드포인트, store.ts 사용 |
| `apps/api/tests/scans.test.ts` | 수정 - 테스트 케이스 추가 |
| `docs/workflow/PHASE2_BACKLOG.md` | 수정 - Phase 2-2 완료 항목 섹션 추가 |

---

## Phase 2-3 완료 항목

> 업데이트: 2026-02-27
> 목적: in-memory 비동기 스캔 큐(Job Queue) 스켈레톤 도입 및 API 연동 완료 내역 기록

### 완료 체크리스트

- [x] `scanner/queue.ts` 신규 추가: `enqueueScan`, `getQueueSize`, `processNextScanJob`, `startScanWorker`, `stopScanWorker` 구현
- [x] 큐 처리 상태 전이 적용: `queued -> running -> completed` (mock 지연 처리, 외부 CLI 호출 없음)
- [x] `scanner/store.ts` 확장: `updateScanStatus(id, status)` 추가 및 종료 시각(`completedAt`) 기록
- [x] `POST /api/v1/scans` 연동: `createScan` 직후 `enqueueScan(scanId)` 호출
- [x] 서버 시작/종료 시 워커 라이프사이클 연결: 시작 시 worker start, 종료 시 stop
- [x] 큐 동작 테스트 추가: enqueue 후 `processNextScanJob` 호출 시 상태 전이 검증(결정적 fake timer 기반)

### 남은 TODO (Phase 2-4+)

- [ ] 실제 스캐너 실행 파이프라인 연결(semgrep/trivy/gitleaks CLI 실행은 다음 단계에서 구현)
- [ ] 큐 영속화(프로세스 재시작 내구성) 또는 외부 큐로 전환 검토
- [ ] 실패 재시도/백오프 정책 및 dead-letter 처리
- [ ] 스캔 결과 상세 저장소(DB)와 상태 전이 이벤트 기록 확장

---

## Phase 2-4 완료 항목

> 업데이트: 2026-02-27
> 목적: in-memory 스캔 큐의 실패 복원력 강화(retry/backoff/dead-letter) 완료 내역 기록

### 완료 체크리스트

- [x] `scanner/queue.ts` 확장: 실패 시 재시도 큐잉 + 지수 백오프(`base * 2^(n-1)`) 적용
- [x] 최대 재시도 횟수 초과 시 `failed` 전이 + dead-letter 큐 적재
- [x] dead-letter 조회 함수 추가: `getDeadLetterSize()`, `listDeadLetters()`
- [x] 테스트 결정성 보장용 훅 추가: `setScanForcedFailuresForTest(scanId, failures)`
- [x] `scanner/store.ts` 확장: `retryCount`, `lastError` 필드 및 `updateScanMeta()` 보조 함수 추가
- [x] `apps/api/tests/queue.test.ts` 보강:
  - [x] 1회 실패 후 재시도 성공 상태 전이 검증
  - [x] 최대 재시도 초과 시 `failed + dead-letter` 검증
- [x] 기존 API 계약 유지: POST 202 응답, `scanId/status` 형식 유지
- [x] 외부 스캐너 실행 미구현 유지: mock 지연 처리만 사용

### 남은 TODO

- [ ] 재시도 정책을 환경 변수화(예: base backoff, max retries)할지 결정
- [ ] dead-letter 재처리(re-drive) API/운영 절차 정의
- [ ] 워커 중지 시 예약된 retry timer 처리 정책(유지/취소) 명세화
- [ ] 프로세스 재시작에도 안전한 영속 큐 전환(예: Redis/Broker) 검토

---

## Phase 2-5 완료 항목

> 업데이트: 2026-02-27
> 목적: dead-letter 재처리 흐름과 운영 제어(API + 테스트)를 완성한 내역 기록

### 완료 체크리스트

- [x] `scanner/queue.ts` 확장
  - [x] `redriveDeadLetter(scanId)` 구현 및 결과 타입 계약 명확화
    - `accepted`: dead-letter 제거 + `queued` 전이 + enqueue
    - `not_found`: dead-letter 미존재
    - `orphaned_scan`: store 레코드 없음(해당 dead-letter 유지)
  - [x] redrive 성공 시 `retryCount=0`, `lastError` 제거 정책 적용
  - [x] 재시도 정책 환경변수화 (`SCAN_RETRY_BACKOFF_BASE_MS`, `SCAN_MAX_RETRIES`)
  - [x] 환경변수 누락/오입력 시 기본값 유지 (`100ms`, `2회`)
- [x] scans API 확장
  - [x] `GET /api/v1/scans/dead-letters` 구현
  - [x] `POST /api/v1/scans/:id/redrive` 구현
  - [x] redrive 성공 시 `202 + { scanId, status: 'queued' }` 반환
  - [x] dead-letter에 없는 항목 redrive 시 `404` 반환
  - [x] orphan dead-letter redrive 시 `409` 반환
- [x] 테스트 보강
  - [x] `apps/api/tests/queue.test.ts`에 redrive 성공/실패 동작 검증 추가
  - [x] `apps/api/tests/scans.test.ts`에 dead-letter 목록 조회 및 redrive 성공/실패 API 케이스 추가
  - [x] 기존 테스트 시나리오 회귀 없이 통과

### 남은 TODO

- [ ] 워커 중지 시 예약된 retry timer 처리 정책(유지/취소) 명세화
- [ ] 프로세스 재시작에도 안전한 영속 큐 전환(예: Redis/Broker) 검토
- [ ] 실제 외부 스캐너 실행 파이프라인 연결(semgrep/trivy/gitleaks CLI)

---

## Phase 2-6 완료 항목

> 업데이트: 2026-02-27
> 목적: 실제 스캐너 실행 파이프라인 1차(실행 경로 도입 + 기본 안정성 확보) 완료 내역 기록

### 완료 체크리스트

- [x] 어댑터 실행 모드 분기 도입 (`SCAN_EXECUTION_MODE`)
  - [x] 기본값 `mock` (미설정/비정상 값 fallback)
  - [x] `native` 모드에서 semgrep/trivy/gitleaks CLI 실행 시도 및 최소 JSON 파싱 구현
  - [x] native 실패 시 엔진명 + 원인 포함 에러 메시지로 디버깅 가능성 확보
- [x] 큐 성공 경로를 mock 지연 완료에서 실제 어댑터 호출 기반으로 전환
  - [x] scan 레코드 → `ScanRequest` 변환 후 엔진별 adapter 실행
  - [x] 결과 요약(findings 카운트) 저장소 반영
  - [x] 성공 시 `completed` 전이
- [x] 저장소/API 응답 확장
  - [x] `ScanRecord`에 findings 요약 필드 추가
  - [x] `GET /api/v1/scans/:id`에서 완료 스캔의 findings 확인 가능
- [x] 테스트 보강
  - [x] queue 성공 처리 시 findings 저장 검증
  - [x] mock 모드 어댑터 결과 포맷/결정성 검증 테스트 신규 추가
  - [x] 기존 dead-letter/redrive 회귀 없음
- [x] 문서 동기화
  - [x] 본 문서에 Phase 2-6 완료 섹션 추가
  - [x] README 현재 구현 상태를 실제 API/큐 동작 기준으로 갱신

### 남은 TODO (Phase 2-8+)

- [ ] native 모드 고도화
  - [ ] clone 캐시 전략/TTL 정책 정립 (중복 clone 최소화)
  - [ ] 임시 workspace 용량 제한/정리 정책 운영화
  - [ ] 엔진별 파서 정밀도 개선 (Semgrep rule metadata, Trivy 패키지/컴포넌트 정보, Gitleaks rule severity 매핑)
  - [ ] CLI 버전 차이 대응 및 표준 에러 코드 매핑
- [ ] 스캔 결과 상세(파일/라인 단위) 저장소 모델 설계 및 API 확장
- [ ] in-memory 큐를 영속 큐(예: Redis/Broker)로 전환 검토

---

## Phase 2-7 완료 항목

> 업데이트: 2026-02-27
> 목적: native 모드 스캔 전 소스 준비(workspace) 단계를 도입해 repoUrl 직접 전달 한계를 개선

### 완료 체크리스트

- [x] 소스 준비 모듈 추가 (`apps/api/src/scanner/source-prep.ts`)
  - [x] `prepareScanSource(repoUrl, branch, mode)` API 추가
  - [x] `mock` 모드: repoUrl passthrough + no-op cleanup
  - [x] `native` 모드 + 로컬 경로: clone 없이 원본 경로 사용
  - [x] `native` 모드 + 원격 URL(`http/https/ssh/git@/file://`): 임시 디렉터리 shallow clone 후 로컬 경로 반환
  - [x] clone 실패 시 원인(stderr/message) 포함 에러 반환
  - [x] 반환값에 `cleanup()` 포함 (임시 clone 정리)
- [x] 큐 연동 (`apps/api/src/scanner/queue.ts`)
  - [x] `adapter.scan` 호출 전에 source-prep 수행
  - [x] adapter에는 준비된 로컬 경로를 `request.repoUrl`로 전달(기존 인터페이스 유지)
  - [x] 스캔 성공/실패와 무관하게 `finally`에서 cleanup 실행 보장
  - [x] retry/backoff/dead-letter/redrive 기존 계약 유지
- [x] 테스트 보강 (`apps/api/tests/*`)
  - [x] `source-prep.test.ts` 신규 추가
    - [x] mock 모드 no-op
    - [x] native + 로컬 경로
    - [x] native + file:// remote clone (임시 git repo)
  - [x] queue/scans 회귀 테스트 유지
  - [x] 외부 네트워크 없이 로컬 git 기반으로 테스트 가능
- [x] 문서 업데이트
  - [x] README에 native 모드 소스 준비 정책 반영
  - [x] 본 문서에 Phase 2-7 완료 섹션 추가

### 남은 TODO (Phase 2-8+)

- [ ] clone 캐시/재사용 전략 설계 (동일 repo/branch 반복 스캔 최적화)
- [ ] source-prep 단계 메트릭/로그(prepare 시간, clone 크기, cleanup 실패율) 추가
- [ ] source-prep 실패 에러 코드 표준화(운영 알림/대시보드 연동용)

## 참고 문서

- `DECISIONS.md` — Phase 1 확정 의사결정
- `MASTER_PLAN.md` — 전체 로드맵
- `../../README.md` — 프로젝트 구조
