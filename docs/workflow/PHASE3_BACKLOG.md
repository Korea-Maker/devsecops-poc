# Phase 3: 대시보드 & 리포팅

## 목표

보안 스캔 현황을 실시간으로 확인하고, 스캔 상세 정보를 조회하며, HTML 리포트를 다운로드할 수 있는 대시보드를 구현한다.

---

## 체크리스트

- [x] 요약 통계 카드 (총 스캔, 상태별 개수, findings 총합)
- [x] 큐 상태 카드 (queuedJobs / deadLetters / pendingRetryTimers / workerRunning / processing)
- [x] 스캔 목록 (테이블 + 모바일 카드 뷰)
- [x] 필터 (상태 / 엔진)
- [x] 검색 (scanId 또는 repoUrl)
- [x] 정렬 (createdAt 최신순 / 오래된순)
- [x] URL querystring 유지 (useSearchParams + router.replace)
- [x] 스캔 상세 뷰 (`/scans/[id]`)
- [x] 상태별 해결 가이드 텍스트
- [x] 에러 코드별 해결 가이드
- [x] Findings severity 카드 (completed일 때)
- [x] 리포트 페이지 (`/reports/[id]`)
- [x] HTML 리포트 다운로드 (Blob + createObjectURL)
- [x] PDF 대체: print-to-PDF 안내 + @media print CSS
- [x] 반응형 디자인 (모바일/태블릿/데스크톱)
- [x] API 프록시 설정 (next.config.ts rewrites)
- [x] 공유 타입/API 클라이언트 (`lib/types.ts`, `lib/api.ts`)

---

## 변경 파일 목록

### 신규 생성

| 파일 | 설명 |
|------|------|
| `apps/web/src/lib/types.ts` | 프론트엔드 공유 타입 (ScanRecord, QueueStatus 등) |
| `apps/web/src/lib/api.ts` | API 클라이언트 (fetchScans, fetchScan, fetchQueueStatus, fetchDeadLetters) |
| `apps/web/src/app/page.module.css` | 대시보드 CSS Module |
| `apps/web/src/app/scans/[id]/page.tsx` | 스캔 상세 페이지 |
| `apps/web/src/app/scans/[id]/page.module.css` | 스캔 상세 CSS Module |
| `apps/web/src/app/reports/[id]/page.tsx` | 리포트 페이지 |
| `apps/web/src/app/reports/[id]/page.module.css` | 리포트 CSS Module |
| `docs/workflow/PHASE3_BACKLOG.md` | 이 문서 |

### 수정

| 파일 | 변경 내용 |
|------|-----------|
| `apps/web/next.config.ts` | API 프록시 rewrites 추가 (`/api/*` → `localhost:3001`) |
| `apps/web/src/app/page.tsx` | 기존 Phase 1 정적 페이지 → 대시보드 전면 교체 |
| `README.md` | Phase 3 대시보드/리포트 섹션 추가 |

---

## 사용법

### 대시보드 (홈)

```
http://localhost:3000
```

- 스캔 현황, findings 요약, 큐 상태를 한눈에 확인
- 5초마다 자동 새로고침
- 상태/엔진 필터, scanId/repoUrl 검색, 정렬 지원
- URL querystring으로 필터 상태 유지 (예: `?filter=failed&engine=semgrep`)

### 스캔 상세

```
http://localhost:3000/scans/{scanId}
```

- 스캔 메타 정보 (ID, 엔진, URL, 브랜치, 시간)
- 상태별 해결 가이드 텍스트
- Findings severity 카드 (completed 상태)
- 오류 코드/메시지 + 해결 가이드 (failed 상태)

### 리포트

```
http://localhost:3000/reports/{scanId}
```

- 스캔 정보 요약 + findings 테이블
- "HTML 리포트 다운로드" 버튼 → standalone HTML 파일 저장
- `Ctrl+P` / `Cmd+P` → PDF 저장 안내 (인쇄 최적화 CSS 적용)

---

## 리스크 및 제약

| 항목 | 설명 |
|------|------|
| 인메모리 스토어 | API 서버 재시작 시 모든 스캔 데이터 소실 (PostgreSQL 연동 Phase 2+ 예정) |
| Mock 데이터 | 기본 실행 모드가 `mock`이므로 실제 스캔 결과가 아닌 deterministic 더미 데이터 |
| 인증 미구현 | Google SSO 미구현 — 누구나 대시보드 접근 가능 |
| 클라이언트 필터링 | 엔진 필터와 검색은 클라이언트사이드 — 대량 데이터 시 성능 이슈 가능 |
| 실시간 업데이트 | WebSocket 아닌 polling (5초) — 지연 발생 가능 |
| CSS Module | 외부 UI 라이브러리 미사용 — 일관된 디자인 시스템 부재 |
| PDF 생성 | 직접 PDF 생성 미지원 — 브라우저 인쇄 기능으로 대체 |
