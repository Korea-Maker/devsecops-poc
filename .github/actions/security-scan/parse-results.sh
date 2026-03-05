#!/usr/bin/env bash
# parse-results.sh
# 3개 보안 스캔 엔진(semgrep, trivy, gitleaks)의 JSON 결과를 통합 파싱한다.
#
# 입력 환경변수:
#   FAIL_THRESHOLD  - critical | high | medium | none (기본: critical)
#   ENGINES         - 실행된 엔진 목록, 쉼표 구분 (예: semgrep,trivy,gitleaks)
#   GITHUB_OUTPUT   - GitHub Actions output 파일 경로
#
# 출력:
#   comment-body.md     - PR 코멘트 Markdown 본문
#   GITHUB_OUTPUT       - total-findings, critical-count, high-count,
#                         medium-count, low-count, blocked
#
# severity 매핑 규칙 (common.ts:normalizeSeverity() 와 일치):
#   semgrep : ERROR→high  WARNING→medium  INFO→low
#   trivy   : CRITICAL→critical  HIGH→high  MODERATE/MEDIUM→medium  LOW→low
#   gitleaks: severity 필드 없거나 빈 경우 → high  (gitleaks.ts:61 참조)

set -euo pipefail

FAIL_THRESHOLD="${FAIL_THRESHOLD:-critical}"
ENGINES="${ENGINES:-semgrep,trivy,gitleaks}"
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
MAX_FINDINGS_PER_ENGINE=25
OUTPUT_FILE="comment-body.md"

# Markdown 테이블 셀 내 특수 문자를 이스케이프한다.
escape_md() {
  local s="$1"
  # 개행/CR 제거 (테이블 깨짐 방지)
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  s="${s//|/\\|}"
  s="${s//\`/\\\`}"
  s="${s//</\&lt;}"
  s="${s//>/\&gt;}"
  s="${s//[/\\[}"
  s="${s//]/\\]}"
  if [ "${#s}" -gt 200 ]; then
    s="${s:0:197}..."
  fi
  printf '%s' "$s"
}

engine_enabled() {
  echo "$ENGINES" | tr ',' '\n' | grep -qx "$1"
}

if ! command -v jq &>/dev/null; then
  echo "::error::jq가 설치되어 있지 않습니다." >&2
  exit 1
fi

# --- 카운터 (bash 3.2 호환 — 연관 배열 미사용) ---
semgrep_critical=0; semgrep_high=0; semgrep_medium=0; semgrep_low=0; semgrep_total=0; semgrep_status="skip"
trivy_critical=0; trivy_high=0; trivy_medium=0; trivy_low=0; trivy_total=0; trivy_status="skip"
gitleaks_critical=0; gitleaks_high=0; gitleaks_medium=0; gitleaks_low=0; gitleaks_total=0; gitleaks_status="skip"

SEMGREP_ROWS=$(mktemp)
TRIVY_ROWS=$(mktemp)
GITLEAKS_ROWS=$(mktemp)
trap 'rm -f "$SEMGREP_ROWS" "$TRIVY_ROWS" "$GITLEAKS_ROWS"' EXIT

# ---------------------------------------------------------------------------
# semgrep 파싱
# ---------------------------------------------------------------------------
if engine_enabled "semgrep"; then
  if [ ! -s "semgrep-results.json" ]; then
    echo "::warning::semgrep 결과 파일이 없거나 비어있습니다."
    semgrep_status="missing"
  elif ! jq empty semgrep-results.json 2>/dev/null; then
    echo "::warning::semgrep 결과가 유효한 JSON이 아닙니다."
    semgrep_status="failed"
  else
    semgrep_status="ok"
    idx=0
    while IFS= read -r row; do
      raw_sev=$(echo "$row" | jq -r '.extra.severity // "INFO"')
      file_path=$(echo "$row" | jq -r '.path // ""')
      line_num=$(echo "$row" | jq -r '.start.line // ""')
      rule_id=$(echo "$row" | jq -r '.check_id // ""')
      description=$(echo "$row" | jq -r '.extra.message // ""')

      upper_sev="$(echo "$raw_sev" | tr '[:lower:]' '[:upper:]')"
      case "$upper_sev" in
        *CRITICAL*) sev="critical"; semgrep_critical=$((semgrep_critical + 1)) ;;
        ERROR|*HIGH*) sev="high"; semgrep_high=$((semgrep_high + 1)) ;;
        WARNING|*MEDIUM*|*MODERATE*) sev="medium"; semgrep_medium=$((semgrep_medium + 1)) ;;
        *) sev="low"; semgrep_low=$((semgrep_low + 1)) ;;
      esac

      idx=$((idx + 1))
      if [ "$idx" -le "$MAX_FINDINGS_PER_ENGINE" ]; then
        echo "| $idx | $sev | $(escape_md "$rule_id") | $(escape_md "$file_path") | $line_num | $(escape_md "$description") |" >> "$SEMGREP_ROWS"
      fi
    done < <(jq -c '.results[]?' semgrep-results.json 2>/dev/null)
    semgrep_total=$((semgrep_critical + semgrep_high + semgrep_medium + semgrep_low))

    if [ "$semgrep_high" -gt 0 ]; then
      echo "::warning::semgrep에서 high severity ${semgrep_high}건 검출"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# trivy 파싱
# ---------------------------------------------------------------------------
if engine_enabled "trivy"; then
  if [ ! -s "trivy-results.json" ]; then
    echo "::warning::trivy 결과 파일이 없거나 비어있습니다."
    trivy_status="missing"
  elif ! jq empty trivy-results.json 2>/dev/null; then
    echo "::warning::trivy 결과가 유효한 JSON이 아닙니다."
    trivy_status="failed"
  else
    trivy_status="ok"
    idx=0
    while IFS= read -r vuln_line; do
      raw_sev=$(echo "$vuln_line" | jq -r '.sev // "LOW"')
      target=$(echo "$vuln_line" | jq -r '.target // ""')
      vuln_id=$(echo "$vuln_line" | jq -r '.vid // ""')
      title=$(echo "$vuln_line" | jq -r '.title // ""')

      upper_sev="$(echo "$raw_sev" | tr '[:lower:]' '[:upper:]')"
      case "$upper_sev" in
        CRITICAL) sev="critical"; trivy_critical=$((trivy_critical + 1)) ;;
        HIGH) sev="high"; trivy_high=$((trivy_high + 1)) ;;
        MEDIUM|MODERATE) sev="medium"; trivy_medium=$((trivy_medium + 1)) ;;
        *) sev="low"; trivy_low=$((trivy_low + 1)) ;;
      esac

      idx=$((idx + 1))
      if [ "$idx" -le "$MAX_FINDINGS_PER_ENGINE" ]; then
        echo "| $idx | $sev | $(escape_md "$vuln_id") | $(escape_md "$target") | — | $(escape_md "$title") |" >> "$TRIVY_ROWS"
      fi
    done < <(jq -c '
      [.Results[]? | .Target as $t | (
        ((.Vulnerabilities // [])[] | {sev: .Severity, target: $t, vid: .VulnerabilityID, title: .Title}),
        ((.Misconfigurations // [])[] | {sev: .Severity, target: $t, vid: .ID, title: .Title}),
        ((.Secrets // [])[] | {sev: .Severity, target: $t, vid: .RuleID, title: .Title})
      )] | .[]' trivy-results.json 2>/dev/null)
    trivy_total=$((trivy_critical + trivy_high + trivy_medium + trivy_low))

    if [ "$trivy_high" -gt 0 ]; then
      echo "::warning::trivy에서 high severity ${trivy_high}건 검출"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# gitleaks 파싱
# ---------------------------------------------------------------------------
if engine_enabled "gitleaks"; then
  if [ ! -s "gitleaks-results.json" ]; then
    echo "::warning::gitleaks 결과 파일이 없거나 비어있습니다."
    gitleaks_status="missing"
  elif ! jq empty gitleaks-results.json 2>/dev/null; then
    echo "::warning::gitleaks 결과가 유효한 JSON이 아닙니다."
    gitleaks_status="failed"
  else
    gitleaks_status="ok"
    idx=0
    while IFS= read -r row; do
      file_path=$(echo "$row" | jq -r '.File // ""')
      line_num=$(echo "$row" | jq -r '.StartLine // ""')
      rule_id=$(echo "$row" | jq -r '.RuleID // ""')
      description=$(echo "$row" | jq -r '.Description // ""')

      # gitleaks는 기본 high (gitleaks.ts:61과 일치)
      sev="high"
      gitleaks_high=$((gitleaks_high + 1))

      idx=$((idx + 1))
      if [ "$idx" -le "$MAX_FINDINGS_PER_ENGINE" ]; then
        echo "| $idx | $sev | $(escape_md "$rule_id") | $(escape_md "$file_path") | $line_num | $(escape_md "$description") |" >> "$GITLEAKS_ROWS"
      fi
    done < <(jq -c '.[]?' gitleaks-results.json 2>/dev/null)
    gitleaks_total=$((gitleaks_critical + gitleaks_high + gitleaks_medium + gitleaks_low))

    if [ "$gitleaks_high" -gt 0 ]; then
      echo "::warning::gitleaks에서 high severity ${gitleaks_high}건 검출"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 집계
# ---------------------------------------------------------------------------
total_critical=$((semgrep_critical + trivy_critical + gitleaks_critical))
total_high=$((semgrep_high + trivy_high + gitleaks_high))
total_medium=$((semgrep_medium + trivy_medium + gitleaks_medium))
total_low=$((semgrep_low + trivy_low + gitleaks_low))
total_findings=$((total_critical + total_high + total_medium + total_low))

# ---------------------------------------------------------------------------
# Threshold 판정
# ---------------------------------------------------------------------------
blocked=false
blocking_count=0

case "${FAIL_THRESHOLD}" in
  none)     blocked=false ;;
  medium)   blocking_count=$((total_critical + total_high + total_medium)); [ "$blocking_count" -gt 0 ] && blocked=true ;;
  high)     blocking_count=$((total_critical + total_high)); [ "$blocking_count" -gt 0 ] && blocked=true ;;
  critical) blocking_count=$total_critical; [ "$blocking_count" -gt 0 ] && blocked=true ;;
  *)
    echo "::warning::알 수 없는 FAIL_THRESHOLD '${FAIL_THRESHOLD}'. critical로 대체합니다." >&2
    blocking_count=$total_critical; [ "$blocking_count" -gt 0 ] && blocked=true
    ;;
esac

# ---------------------------------------------------------------------------
# GITHUB_OUTPUT 설정
# ---------------------------------------------------------------------------
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "total-findings=${total_findings}"
    echo "critical-count=${total_critical}"
    echo "high-count=${total_high}"
    echo "medium-count=${total_medium}"
    echo "low-count=${total_low}"
    echo "blocked=${blocked}"
  } >> "$GITHUB_OUTPUT"
fi

# ---------------------------------------------------------------------------
# Markdown PR Comment 생성
# ---------------------------------------------------------------------------
{
  echo "<!-- devsecops-security-scan -->"
  echo "## 🔒 Security Scan Results"
  echo ""

  if [ "$blocked" = "true" ]; then
    echo "❌ **${blocking_count} finding(s) at or above \`${FAIL_THRESHOLD}\` threshold → merge blocked**"
  else
    echo "✅ **No blocking findings** (threshold: \`${FAIL_THRESHOLD}\`)"
  fi

  echo ""
  echo "### Summary"
  echo "| Engine | Critical | High | Medium | Low | Total |"
  echo "|--------|----------|------|--------|-----|-------|"

  for engine in semgrep trivy gitleaks; do
    if ! engine_enabled "$engine"; then continue; fi
    eval "s=\${${engine}_status}"
    eval "ec=\${${engine}_critical}"
    eval "eh=\${${engine}_high}"
    eval "em=\${${engine}_medium}"
    eval "el=\${${engine}_low}"
    eval "et=\${${engine}_total}"
    case "$s" in
      ok)      echo "| $engine | $ec | $eh | $em | $el | $et |" ;;
      missing) echo "| $engine | — | — | — | — | 스캔 실패 |" ;;
      failed)  echo "| $engine | — | — | — | — | 파싱 실패 |" ;;
      *)       echo "| $engine | 0 | 0 | 0 | 0 | 0 |" ;;
    esac
  done

  echo "| **Total** | **${total_critical}** | **${total_high}** | **${total_medium}** | **${total_low}** | **${total_findings}** |"

  echo ""
  echo "### Findings"

  for engine in semgrep trivy gitleaks; do
    if ! engine_enabled "$engine"; then continue; fi
    eval "s=\${${engine}_status}"
    eval "et=\${${engine}_total}"

    rows_file=""
    case "$engine" in
      semgrep)  rows_file="$SEMGREP_ROWS" ;;
      trivy)    rows_file="$TRIVY_ROWS" ;;
      gitleaks) rows_file="$GITLEAKS_ROWS" ;;
    esac

    echo ""
    echo "<details>"
    echo "<summary>${engine} (${et} findings)</summary>"
    echo ""

    if [ "$s" = "ok" ] && [ "$et" -gt 0 ] && [ -s "$rows_file" ]; then
      echo "| # | Severity | Rule | File | Line | Description |"
      echo "|---|----------|------|------|------|-------------|"
      cat "$rows_file"
      if [ "$et" -gt "$MAX_FINDINGS_PER_ENGINE" ]; then
        echo ""
        echo "... and $((et - MAX_FINDINGS_PER_ENGINE)) more"
      fi
    elif [ "$s" = "missing" ]; then
      echo "_스캔 실패: 결과 파일이 존재하지 않습니다._"
    elif [ "$s" = "failed" ]; then
      echo "_파싱 실패: 결과 파일이 유효한 JSON이 아닙니다._"
    else
      echo "_발견 사항 없음_"
    fi

    echo ""
    echo "</details>"
  done

  if [ "$total_findings" -eq 0 ]; then
    echo ""
    echo "> 🎉 No security findings detected."
  fi

  echo ""
  echo "---"
  echo "ℹ️ Block threshold: \`${FAIL_THRESHOLD}\` | Scan completed at ${TIMESTAMP}"
} > "$OUTPUT_FILE"

echo "--- 스캔 결과 요약 ---"
echo "  total   : ${total_findings}"
echo "  critical: ${total_critical}"
echo "  high    : ${total_high}"
echo "  medium  : ${total_medium}"
echo "  low     : ${total_low}"
echo "  threshold: ${FAIL_THRESHOLD}  blocked: ${blocked}"
echo "  comment-body.md 생성 완료"
