# Phase 2 백로그 — 스캔 인프라 MVP

> 업데이트: 2026-02-27
> 목적: Phase 2 Week 1 (이번 주)에 구현할 5개 핵심 목표와 검증 기준을 명시한다.
> 대상: scanner 도메인 공통 타입 → 어댑터 구현 → API 라우트 통합

---

## 이번 주 구현 목표 (5개)

| # | 목표 | 소유 파일 | 예상 시간 | 의존성 |
|---|------|---------|---------|--------|
| 1 | 스캔 도메인 공통 타입 정의 | `apps/api/src/scanner/types.ts` | 1-2h | 없음 |
| 2 | SAST/SCA/Secret 어댑터 스텁 | `apps/api/src/scanner/adapters/{semgrep,trivy,gitleaks}.ts` | 2-3h | #1 |
| 3 | 어댑터 Registry 구현 | `apps/api/src/scanner/registry.ts` | 1-2h | #1 |
| 4 | POST /api/v1/scans → 202 응답 | `apps/api/src/routes/scans.ts` | 1-2h | #1, #3 |
| 5 | GET /api/v1/scans/:id 상태 조회 | `apps/api/src/routes/scans.ts` | 1-2h | #4 |

---

## 목표 1: 스캔 도메인 공통 타입 정의

### 설명
`scanner/types.ts`에서 SAST, SCA, Secret 스캔의 공통 타입을 정의한다.
- **ScanEngineType**: `'sast' | 'sca' | 'secret'`
- **ScanRequest**: 스캔 요청 입력 (repositoryUrl, engineType, configId 등)
- **ScanResultSummary**: 스캔 결과 요약 (스캔ID, 상태, 취약점 개수, 타임스탐프)
- **ScanAdapter**: 모든 어댑터가 구현해야 할 인터페이스

### 검증 기준

| 기준 | 체크 항목 |
|-----|---------|
| 타입 정의 완성 | `ScanEngineType`, `ScanRequest`, `ScanResultSummary`, `ScanAdapter` 모두 export 됨 |
| 타입체크 통과 | `pnpm --filter @devsecops/api typecheck` 0 errors |
| 인터페이스 명확성 | `ScanAdapter` 인터페이스에 `scan()`, `parseResults()` 메서드 시그니처 포함 |
| 상태 정의 | 스캔 상태: `'queued' \| 'running' \| 'completed' \| 'failed'` |

---

## 목표 2: SAST/SCA/Secret 어댑터 스텁 구현

### 설명
`scanner/adapters/` 디렉토리에 3개 어댑터를 구현한다. 각 어댑터는 `ScanAdapter` 인터페이스를 구현하며, 실제 스캔 로직은 TODO로 남겨둔다.

#### semgrep.ts
```typescript
// ScanAdapter 구현
// scan(): TODO - semgrep CLI 호출 로직
// parseResults(): TODO - SARIF 또는 JSON 파싱
```

#### trivy.ts
```typescript
// ScanAdapter 구현
// scan(): TODO - trivy CLI 호출 로직
// parseResults(): TODO - JSON 파싱
```

#### gitleaks.ts
```typescript
// ScanAdapter 구현
// scan(): TODO - gitleaks CLI 호출 로직
// parseResults(): TODO - JSON 파싱
```

### 검증 기준

| 기준 | 체크 항목 |
|-----|---------|
| 파일 생성 | 3개 어댑터 모두 생성됨 |
| 인터페이스 준수 | 각 어댑터가 `ScanAdapter` 인터페이스 구현 (타입체크 통과) |
| 메서드 스톱 | `scan()`, `parseResults()` 메서드 모두 TODO 스텁 포함 |
| 타입 안전 | `pnpm --filter @devsecops/api typecheck` 0 errors |

---

## 목표 3: 어댑터 Registry 구현

### 설명
`scanner/registry.ts`에서 엔진별 어댑터를 등록하고 조회하는 registry를 구현한다.

#### 핵심 함수
- **`getAdapter(engineType: ScanEngineType): ScanAdapter`**
  엔진 타입에 따라 해당 어댑터 인스턴스 반환

- **`listEngines(): ScanEngineType[]`**
  지원되는 모든 엔진 목록 반환

- **`isEngineSupported(engineType: string): boolean`**
  엔진 지원 여부 확인

### 검증 기준

| 기준 | 체크 항목 |
|-----|---------|
| Registry 함수 | `getAdapter()`, `listEngines()`, `isEngineSupported()` export |
| 엔진 매핑 | `'sast'` → semgrep, `'sca'` → trivy, `'secret'` → gitleaks |
| 타입 안전 | registry 호출 시 정확한 어댑터 타입 반환 |
| 커버리지 | `pnpm --filter @devsecops/api typecheck` 0 errors |

---

## 목표 4: POST /api/v1/scans → 202 큐 등록 응답

### 설명
`routes/scans.ts`의 POST 엔드포인트를 구현한다. 스캔 요청을 받아 in-memory 저장소에 등록하고 `scanId`를 생성하여 202 응답으로 반환한다.

#### 요청 (Request)
```json
{
  "repositoryUrl": "https://github.com/user/repo",
  "engineType": "sast",
  "configId": "default"
}
```

#### 응답 (Response - 202 Accepted)
```json
{
  "scanId": "scan_8f42c9d1",
  "status": "queued",
  "createdAt": "2026-02-27T12:00:00Z"
}
```

#### 저장소 (In-Memory)
```typescript
const scans: Map<string, ScanResultSummary> = new Map();
// 요청 시 scanId 생성, 상태 'queued' 저장
```

### 검증 기준

| 기준 | 체크 항목 |
|-----|---------|
| 엔드포인트 | POST /api/v1/scans 구현 |
| 응답 코드 | 202 Accepted |
| 응답 바디 | `{ scanId, status: 'queued', createdAt }` 포함 |
| scanId 생성 | 고유한 ID 생성 (예: `scan_${uuid}` 또는 `scan_${timestamp}`) |
| 상태 저장 | in-memory 맵에 scans 상태 저장 |
| 타입체크 | `pnpm --filter @devsecops/api typecheck` 0 errors |

---

## 목표 5: GET /api/v1/scans/:id → 상태 조회

### 설명
`routes/scans.ts`의 GET 엔드포인트를 구현한다. scanId로 저장된 스캔 상태를 조회하고, 존재하면 200, 없으면 404를 반환한다.

#### 응답 예시 (200 OK)
```json
{
  "scanId": "scan_8f42c9d1",
  "status": "queued",
  "engineType": "sast",
  "repositoryUrl": "https://github.com/user/repo",
  "createdAt": "2026-02-27T12:00:00Z",
  "vulnerabilityCount": 0
}
```

#### 응답 예시 (404 Not Found)
```json
{
  "error": "Scan not found",
  "scanId": "scan_invalid"
}
```

### 검증 기준

| 기준 | 체크 항목 |
|-----|---------|
| 엔드포인트 | GET /api/v1/scans/:id 구현 |
| 존재하는 스캔 | 200 응답 + 스캔 상태 반환 |
| 존재하지 않는 스캔 | 404 응답 + 에러 메시지 |
| 테스트 3개 통과 | ① POST → scanId 생성, ② GET (존재O) → 200, ③ GET (존재X) → 404 |
| 타입체크 | `pnpm --filter @devsecops/api typecheck` 0 errors |

---

## 검증 체크리스트 (누적)

이 주의 모든 목표 완료 후 다음을 확인한다.

```
[ ] 목표 1: scanner/types.ts 정의 완료, typecheck 통과
[ ] 목표 2: 3개 어댑터 파일 생성, ScanAdapter 구현, typecheck 통과
[ ] 목표 3: registry.ts 구현, getAdapter()/listEngines() export
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

## 참고 문서

- `DECISIONS.md` — Phase 1 확정 의사결정
- `MASTER_PLAN.md` — 전체 로드맵
- `../../README.md` — 프로젝트 구조
