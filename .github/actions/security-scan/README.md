# Security Scan Composite Action

PR이 열리거나 업데이트될 때 3개 보안 스캔 엔진을 실행하고, 결과를 PR Comment로 자동 작성하는 재사용 가능한 GitHub Action.

## 스캔 엔진

| 엔진 | 유형 | 설명 |
|------|------|------|
| semgrep | SAST | 정적 코드 분석 |
| trivy | SCA | 의존성 취약점 탐지 |
| gitleaks | Secret | 시크릿/자격증명 노출 탐지 |

## 사용법

### 이 레포 내에서 사용

```yaml
- uses: ./.github/actions/security-scan
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

### 다른 레포에서 사용

```yaml
- uses: your-org/devsecops-poc/.github/actions/security-scan@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    fail-threshold: high  # critical 외에 high도 차단
```

### 전체 예시 (workflow)

```yaml
name: Security Scan
on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/devsecops-poc/.github/actions/security-scan@main
        id: scan
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          fail-threshold: critical
      - run: echo "Blocked=${{ steps.scan.outputs.blocked }}"
        if: always()
```

## Inputs

| Input | Required | Default | 설명 |
|-------|----------|---------|------|
| `github-token` | Yes | — | GitHub API 인증 토큰 (`${{ secrets.GITHUB_TOKEN }}`) |
| `fail-threshold` | No | `critical` | merge 차단 기준 (`critical`, `high`, `medium`, `none`) |
| `engines` | No | `semgrep,trivy,gitleaks` | 실행할 엔진 (쉼표 구분) |
| `semgrep-config` | No | `auto` | semgrep 설정 (`auto`, 특정 ruleset 경로 등) |

## Outputs

| Output | 설명 |
|--------|------|
| `total-findings` | 전체 finding 수 |
| `critical-count` | Critical severity 수 |
| `high-count` | High severity 수 |
| `medium-count` | Medium severity 수 |
| `low-count` | Low severity 수 |
| `comment-url` | PR 코멘트 URL |
| `blocked` | threshold 초과 여부 (`true` / `false`) |

## Threshold 동작

| Threshold | 차단 조건 |
|-----------|----------|
| `critical` | Critical finding이 1개 이상이면 차단 |
| `high` | Critical 또는 High finding이 1개 이상이면 차단 |
| `medium` | Critical, High, 또는 Medium finding이 1개 이상이면 차단 |
| `none` | 차단하지 않음 (정보 제공만) |

## PR Comment

스캔 결과는 PR에 자동으로 Comment로 작성됩니다:
- 동일 PR에서 push가 반복되면 기존 Comment를 업데이트합니다 (마커 기반)
- severity별 건수 요약 테이블 포함
- 각 finding의 파일/라인/규칙/설명 상세 목록 포함 (엔진당 최대 25개)
- fork PR에서는 Comment 작성이 제한될 수 있습니다

## 필요 권한

```yaml
permissions:
  contents: read        # 소스 코드 체크아웃
  pull-requests: write  # PR Comment 작성
```
