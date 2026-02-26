# devsecops-poc — Claude Code 작업 규칙

## 프로젝트 개요

스타트업 개발팀을 위한 DevSecOps 플랫폼 PoC. 종욱(Jonguk)이 단독으로 개발 중이며, 보안 스캔·취약점 분석·CI/CD 통합 기능을 하나의 도구로 제공하는 것이 목표다. Claude Code를 핵심 개발 파트너로 활용한다.

### 주요 디렉터리

```
docs/workflow/   — 실행 계획, 루프, 미결 질문
src/             — 핵심 애플리케이션 코드 (결정 후 구조화)
infra/           — 인프라·배포 설정
scripts/         — 빌드·스캔·유틸리티 스크립트
.omc/            — Claude Code / OMC 세션 상태
```

---

## 코딩 스타일

- **언어**: [결정 필요] (TypeScript / Python / Go / Rust 중 선택)
- **포매터**: [결정 필요] (Prettier / Black / gofmt / rustfmt)
- **린터**: [결정 필요] (ESLint / Ruff / golangci-lint / Clippy)
- **네이밍**: [결정 필요] — 함수·변수는 camelCase 또는 snake_case (언어 관례 따름)
- **파일 구성**: [결정 필요] — 기능 단위 모듈화 원칙 적용 예정

---

## 검증 명령어

```bash
# 린트 검사
# [결정 필요] npm run lint / ruff check . / golangci-lint run / cargo clippy

# 타입 검사
# [결정 필요] tsc --noEmit / mypy src/ / go build ./...

# 테스트 실행
# [결정 필요] npm test / pytest / go test ./... / cargo test

# 보안 스캔
# [결정 필요] semgrep --config=auto / bandit -r src/ / gosec ./...

# 빌드
# [결정 필요] npm run build / docker build . / cargo build --release
```

커밋 전 반드시 위 명령어를 순서대로 실행한다.

---

## 커밋 컨벤션

형식: `type(scope): 설명` (한국어 설명 허용)

**타입**

| 타입 | 용도 |
|------|------|
| `feat` | 새 기능 |
| `fix` | 버그 수정 |
| `docs` | 문서 변경 |
| `style` | 포맷·공백 등 코드 의미 무관 변경 |
| `refactor` | 기능 변경 없는 리팩터링 |
| `test` | 테스트 추가·수정 |
| `chore` | 빌드·의존성·설정 변경 |
| `security` | 보안 관련 변경 |

**스코프 예시**: `core`, `scanner`, `dashboard`, `api`, `infra`, `ci`

**Claude 공동 작업 표기** — Claude가 기여한 커밋에는 항상 추가:

```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## 안전 가드

- `.env` 파일 또는 시크릿을 절대 커밋하지 않는다
- `main` 브랜치에 force push 절대 금지
- 커밋 전 반드시 검증 명령어를 실행한다
- 파일 편집 전 반드시 먼저 읽는다
- pre-commit 훅을 건너뛰지 않는다 (`--no-verify` 사용 금지)
- 모든 검사를 통과하지 않으면 배포하지 않는다
- 보안에 민감한 변경은 `/security-review` 또는 `senior-secops` 스킬을 실행한다

---

## Claude Code 작업 규칙

- 2개 이상 파일 변경 → `/team` 사용
- 아키텍처·설계 결정 → `/plan` 사용
- 구현 후 반드시 검증 실행 (`verifier` 에이전트 또는 검증 명령어)
- 기술 스택 결정 시 이 파일의 플레이스홀더를 즉시 업데이트한다
- 모든 커뮤니케이션·주석·커밋 메시지는 한국어 사용 (기술 용어·코드 제외)

---

## 주요 참고 문서

- `docs/workflow/MASTER_PLAN.md` — 전체 실행 계획
- `docs/workflow/EXECUTION_LOOP.md` — 실행 루프 정의
- `docs/workflow/QUESTIONS_FOR_JONGWOOK.md` — 미결 질문 목록
