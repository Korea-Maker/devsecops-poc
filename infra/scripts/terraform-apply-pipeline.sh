#!/usr/bin/env bash
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PREFLIGHT_SCRIPT="${SCRIPT_DIR}/terraform-preflight-validate.sh"
PLAN_SCRIPT="${SCRIPT_DIR}/terraform-plan.sh"
APPLY_SCRIPT="${SCRIPT_DIR}/terraform-apply.sh"

TARGET_ENV="staging"
ALLOW_CREATE="false"
EXECUTE_APPLY="false"
ALLOW_PROD="false"
CI_MODE="false"
ARTIFACT_ROOT_REL="infra/apply-artifacts"

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [dev|staging|prod] [--allow-create] [--apply] [--allow-prod] [--artifact-root <path>] [--ci]

Description:
  운영자/CI용 terraform 실행 래퍼입니다.
  - preflight -> plan -> optional apply 순서로 수행
  - 기존 스크립트(terraform-preflight-validate.sh / terraform-plan.sh / terraform-apply.sh)를 그대로 호출
  - 단계별 로그/상태 아티팩트를 남기고 실패 시 즉시 비정상 종료(exit 1)

Options:
  --allow-create          plan/apply에서 allow_resource_creation=true 전달
  --apply                 apply 단계 실행 (기본: false, plan-only)
  --allow-prod            prod apply 명시 허용(필수)
  --artifact-root <path>  산출물 루트 경로 (기본: infra/apply-artifacts)
  --ci                    GITHUB_STEP_SUMMARY 요약 출력
  -h, --help              도움말 출력

Examples:
  $(basename "$0") staging
  $(basename "$0") staging --allow-create
  $(basename "$0") staging --allow-create --apply
  $(basename "$0") prod --allow-create --apply --allow-prod
USAGE
}

if [[ $# -gt 0 ]]; then
  case "$1" in
    dev|staging|prod)
      TARGET_ENV="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-create)
      ALLOW_CREATE="true"
      shift
      ;;
    --apply)
      EXECUTE_APPLY="true"
      shift
      ;;
    --allow-prod)
      ALLOW_PROD="true"
      shift
      ;;
    --artifact-root)
      [[ $# -ge 2 ]] || {
        echo "❌ --artifact-root 옵션에는 경로가 필요합니다." >&2
        exit 1
      }
      ARTIFACT_ROOT_REL="$2"
      shift 2
      ;;
    --ci)
      CI_MODE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "❌ 알 수 없는 옵션: $1" >&2
      usage
      exit 1
      ;;
  esac
done

case "$TARGET_ENV" in
  dev|staging|prod) ;;
  *)
    echo "❌ 환경 값은 dev|staging|prod 중 하나여야 합니다." >&2
    exit 1
    ;;
esac

if [[ "$TARGET_ENV" == "prod" && "$EXECUTE_APPLY" == "true" && "$ALLOW_PROD" != "true" ]]; then
  echo "❌ prod apply 실행 시 --allow-prod 플래그가 필요합니다." >&2
  exit 1
fi

if [[ "$ARTIFACT_ROOT_REL" = /* ]]; then
  ARTIFACT_ROOT_ABS="$ARTIFACT_ROOT_REL"
  ARTIFACT_ROOT_DISPLAY="$ARTIFACT_ROOT_REL"
else
  ARTIFACT_ROOT_ABS="${REPO_ROOT}/${ARTIFACT_ROOT_REL}"
  ARTIFACT_ROOT_DISPLAY="$ARTIFACT_ROOT_REL"
fi

TIMESTAMP_UTC="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_DIR_ABS="${ARTIFACT_ROOT_ABS}/${TIMESTAMP_UTC}-${TARGET_ENV}"
if [[ "$ARTIFACT_ROOT_REL" = /* ]]; then
  ARTIFACT_DIR_REL="$ARTIFACT_DIR_ABS"
else
  ARTIFACT_DIR_REL="${ARTIFACT_ROOT_DISPLAY}/${TIMESTAMP_UTC}-${TARGET_ENV}"
fi

LOG_DIR="${ARTIFACT_DIR_ABS}/logs"
PLAN_DIR="${ARTIFACT_DIR_ABS}/plans"
mkdir -p "$LOG_DIR" "$PLAN_DIR"

COMMANDS_LOG="${ARTIFACT_DIR_ABS}/commands.log"
STEP_RECORDS_FILE="${ARTIFACT_DIR_ABS}/status.tsv"
STATUS_JSON="${ARTIFACT_DIR_ABS}/status.json"
SUMMARY_MD="${ARTIFACT_DIR_ABS}/status-summary.md"
PLAN_FILE_ABS="${PLAN_DIR}/${TARGET_ENV}.tfplan"

printf "step\tstatus\texit_code\tlog_file\treason\tcommand\n" > "$STEP_RECORDS_FILE"
: > "$COMMANDS_LOG"

LAST_STEP_STATUS=""
LAST_STEP_EXIT_CODE=""

sanitize_field() {
  local value="${1:-}"
  value="${value//$'\n'/ }"
  value="${value//$'\r'/ }"
  value="${value//$'\t'/ }"
  printf '%s' "$value"
}

json_escape() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

command_to_string() {
  local out=""
  local arg
  for arg in "$@"; do
    out+="$(printf '%q' "$arg") "
  done
  printf '%s' "${out% }"
}

record_step() {
  local step="$1"
  local status="$2"
  local exit_code="$3"
  local log_file="$4"
  local reason="$5"
  local command="$6"

  printf "%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$(sanitize_field "$step")" \
    "$(sanitize_field "$status")" \
    "$(sanitize_field "$exit_code")" \
    "$(sanitize_field "$log_file")" \
    "$(sanitize_field "$reason")" \
    "$(sanitize_field "$command")" >> "$STEP_RECORDS_FILE"

  LAST_STEP_STATUS="$status"
  LAST_STEP_EXIT_CODE="$exit_code"
}

run_step() {
  local step="$1"
  local log_file_abs="$2"
  shift 2
  local -a cmd=("$@")
  local cmd_str
  local relative_log
  local exit_code
  local status
  local reason

  cmd_str="$(command_to_string "${cmd[@]}")"
  relative_log="${log_file_abs#${ARTIFACT_DIR_ABS}/}"

  {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] STEP=${step}"
    echo "+ ${cmd_str}"
  } >> "$COMMANDS_LOG"

  if "${cmd[@]}" > "$log_file_abs" 2>&1; then
    exit_code=0
  else
    exit_code=$?
  fi

  if [[ "$exit_code" -eq 0 ]]; then
    status="success"
    reason="completed"
  else
    status="failed"
    reason="command exited ${exit_code}"
  fi

  {
    echo "status=${status}"
    echo "exit_code=${exit_code}"
    echo "log_file=${relative_log}"
    echo
  } >> "$COMMANDS_LOG"

  record_step "$step" "$status" "$exit_code" "$relative_log" "$reason" "$cmd_str"
}

skip_step() {
  local step="$1"
  local log_file_abs="$2"
  local reason="$3"
  local command="${4:-N/A}"
  local relative_log

  relative_log="${log_file_abs#${ARTIFACT_DIR_ABS}/}"
  {
    echo "SKIPPED"
    echo "reason=${reason}"
    echo "command=${command}"
  } > "$log_file_abs"

  {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] STEP=${step}"
    echo "status=skipped"
    echo "reason=${reason}"
    echo "log_file=${relative_log}"
    echo
  } >> "$COMMANDS_LOG"

  record_step "$step" "skipped" "-" "$relative_log" "$reason" "$command"
}

fail_step() {
  local step="$1"
  local log_file_abs="$2"
  local exit_code="$3"
  local reason="$4"
  local command="${5:-N/A}"
  local relative_log

  relative_log="${log_file_abs#${ARTIFACT_DIR_ABS}/}"
  {
    echo "FAILED"
    echo "reason=${reason}"
    echo "exit_code=${exit_code}"
    echo "command=${command}"
  } > "$log_file_abs"

  {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] STEP=${step}"
    echo "status=failed"
    echo "exit_code=${exit_code}"
    echo "reason=${reason}"
    echo "log_file=${relative_log}"
    echo
  } >> "$COMMANDS_LOG"

  record_step "$step" "failed" "$exit_code" "$relative_log" "$reason" "$command"
}

step_status() {
  local target_step="$1"
  awk -F'\t' -v target="$target_step" 'NR > 1 && $1 == target { print $2; exit }' "$STEP_RECORDS_FILE"
}

md_escape() {
  local value="${1:-}"
  value="${value//|/\\|}"
  printf '%s' "$value"
}

if [[ ! -x "$PREFLIGHT_SCRIPT" ]]; then
  fail_step "preflight_validate" "${LOG_DIR}/preflight-validate.log" "127" "preflight script not executable" "bash ${PREFLIGHT_SCRIPT} ${TARGET_ENV} --ci"
else
  run_step "preflight_validate" "${LOG_DIR}/preflight-validate.log" bash "$PREFLIGHT_SCRIPT" "$TARGET_ENV" --ci
fi

if [[ "$(step_status "preflight_validate")" == "success" ]]; then
  if [[ ! -x "$PLAN_SCRIPT" ]]; then
    fail_step "terraform_plan" "${LOG_DIR}/terraform-plan.log" "127" "plan script not executable" "bash ${PLAN_SCRIPT} ${TARGET_ENV} --out ${PLAN_FILE_ABS} --skip-preflight"
  else
    plan_cmd=(bash "$PLAN_SCRIPT" "$TARGET_ENV" --out "$PLAN_FILE_ABS" --skip-preflight)
    if [[ "$ALLOW_CREATE" == "true" ]]; then
      plan_cmd+=(--allow-create)
    fi
    run_step "terraform_plan" "${LOG_DIR}/terraform-plan.log" "${plan_cmd[@]}"
  fi
else
  skip_step "terraform_plan" "${LOG_DIR}/terraform-plan.log" "preflight 미통과로 plan 생략" "bash ${PLAN_SCRIPT} ${TARGET_ENV} --out ${PLAN_FILE_ABS} --skip-preflight"
fi

apply_executed="false"
if [[ "$EXECUTE_APPLY" == "true" ]]; then
  if [[ "$(step_status "terraform_plan")" == "success" ]]; then
    if [[ ! -x "$APPLY_SCRIPT" ]]; then
      fail_step "terraform_apply" "${LOG_DIR}/terraform-apply.log" "127" "apply script not executable" "bash ${APPLY_SCRIPT} ${TARGET_ENV} --plan-file ${PLAN_FILE_ABS} --skip-preflight --skip-plan --non-interactive"
    else
      apply_cmd=(
        bash "$APPLY_SCRIPT" "$TARGET_ENV"
        --plan-file "$PLAN_FILE_ABS"
        --skip-preflight
        --skip-plan
        --non-interactive
        --confirm-apply-token apply
      )

      if [[ "$ALLOW_CREATE" == "true" ]]; then
        apply_cmd+=(--allow-create)
      fi

      if [[ "$TARGET_ENV" == "prod" ]]; then
        apply_cmd+=(--allow-prod --confirm-prod-token prod-apply)
      fi

      run_step "terraform_apply" "${LOG_DIR}/terraform-apply.log" "${apply_cmd[@]}"
      if [[ "$LAST_STEP_STATUS" == "success" ]]; then
        apply_executed="true"
      fi
    fi
  else
    skip_step "terraform_apply" "${LOG_DIR}/terraform-apply.log" "plan 미통과로 apply 생략" "bash ${APPLY_SCRIPT} ${TARGET_ENV} --plan-file ${PLAN_FILE_ABS} ..."
  fi
else
  skip_step "terraform_apply" "${LOG_DIR}/terraform-apply.log" "--apply 미지정(plan-only 모드)" "bash ${APPLY_SCRIPT} ${TARGET_ENV} --plan-file ${PLAN_FILE_ABS} ..."
fi

success_count="$(awk -F'\t' 'NR > 1 && $2 == "success" { c++ } END { print c + 0 }' "$STEP_RECORDS_FILE")"
failed_count="$(awk -F'\t' 'NR > 1 && $2 == "failed" { c++ } END { print c + 0 }' "$STEP_RECORDS_FILE")"
skipped_count="$(awk -F'\t' 'NR > 1 && $2 == "skipped" { c++ } END { print c + 0 }' "$STEP_RECORDS_FILE")"

overall_status="passed"
if [[ "$failed_count" -gt 0 ]]; then
  overall_status="needs_attention"
elif [[ "$skipped_count" -gt 0 ]]; then
  overall_status="partial"
fi

{
  echo "# Terraform Apply Pipeline Summary"
  echo
  echo "- generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- target_env: ${TARGET_ENV}"
  echo "- artifact_dir: ${ARTIFACT_DIR_REL}"
  echo "- allow_create: ${ALLOW_CREATE}"
  echo "- apply_requested: ${EXECUTE_APPLY}"
  echo "- apply_executed: ${apply_executed}"
  echo "- overall_status: ${overall_status}"
  echo
  echo "## Step Results"
  echo "| step | status | exit_code | log_file | reason |"
  echo "|---|---|---:|---|---|"

  while IFS=$'\t' read -r step status exit_code log_file reason command; do
    if [[ "$step" == "step" ]]; then
      continue
    fi

    pretty_exit="$exit_code"
    if [[ -z "$pretty_exit" || "$pretty_exit" == "-" ]]; then
      pretty_exit="-"
    fi

    echo "| $(md_escape "$step") | $(md_escape "$status") | $(md_escape "$pretty_exit") | $(md_escape "$log_file") | $(md_escape "$reason") |"
  done < "$STEP_RECORDS_FILE"
} > "$SUMMARY_MD"

{
  echo "{"
  echo "  \"generatedAtUtc\": \"$(json_escape "$(date -u +%Y-%m-%dT%H:%M:%SZ)")\"," 
  echo "  \"targetEnv\": \"$(json_escape "$TARGET_ENV")\"," 
  echo "  \"artifactDir\": \"$(json_escape "$ARTIFACT_DIR_REL")\"," 
  echo "  \"allowCreate\": ${ALLOW_CREATE},"
  echo "  \"applyRequested\": ${EXECUTE_APPLY},"
  echo "  \"applyExecuted\": ${apply_executed},"
  echo "  \"overallStatus\": \"$(json_escape "$overall_status")\"," 
  echo "  \"counts\": {"
  echo "    \"success\": ${success_count},"
  echo "    \"failed\": ${failed_count},"
  echo "    \"skipped\": ${skipped_count}"
  echo "  },"
  echo "  \"steps\": ["

  first="true"
  while IFS=$'\t' read -r step status exit_code log_file reason command; do
    if [[ "$step" == "step" ]]; then
      continue
    fi

    if [[ "$first" == "true" ]]; then
      first="false"
    else
      echo ","
    fi

    if [[ "$exit_code" =~ ^[0-9]+$ ]]; then
      exit_json="$exit_code"
    else
      exit_json="null"
    fi

    echo "    {"
    echo "      \"step\": \"$(json_escape "$step")\"," 
    echo "      \"status\": \"$(json_escape "$status")\"," 
    echo "      \"exitCode\": ${exit_json},"
    echo "      \"logFile\": \"$(json_escape "$log_file")\"," 
    echo "      \"reason\": \"$(json_escape "$reason")\"," 
    echo "      \"command\": \"$(json_escape "$command")\""
    echo "    }"
  done < "$STEP_RECORDS_FILE"

  echo
  echo "  ]"
  echo "}"
} > "$STATUS_JSON"

if [[ "$CI_MODE" == "true" && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Terraform apply pipeline (${TARGET_ENV})"
    echo "- artifact: \
\`${ARTIFACT_DIR_REL}\`"
    echo "- allow create: \
\`${ALLOW_CREATE}\`"
    echo "- apply requested: **${EXECUTE_APPLY}**"
    echo "- apply executed: **${apply_executed}**"
    echo "- overall status: **${overall_status}**"
    echo
    echo "상세 로그: \
\`${ARTIFACT_DIR_REL}/status-summary.md\`, \
\`${ARTIFACT_DIR_REL}/status.json\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "ARTIFACT_DIR=${ARTIFACT_DIR_REL}"
echo "PLAN_FILE=${PLAN_FILE_ABS}"
echo "OVERALL_STATUS=${overall_status}"
echo "APPLY_REQUESTED=${EXECUTE_APPLY}"
echo "APPLY_EXECUTED=${apply_executed}"

if [[ "$failed_count" -gt 0 ]]; then
  exit 1
fi

exit 0
