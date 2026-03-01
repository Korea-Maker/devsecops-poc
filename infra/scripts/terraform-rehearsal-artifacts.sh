#!/usr/bin/env bash
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TERRAFORM_DIR="${REPO_ROOT}/infra/terraform"
PREFLIGHT_SCRIPT="${SCRIPT_DIR}/terraform-preflight-validate.sh"

TARGET_ENV="staging"
ALLOW_CREATE_PLAN="false"
CI_MODE="false"
STRICT_MODE="false"
ARTIFACT_ROOT_REL="infra/rehearsal-artifacts"

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [dev|staging|prod] [--allow-create-plan] [--artifact-root <path>] [--ci] [--strict]

Description:
  Terraform dry-run rehearsal artifact 번들을 생성합니다.
  - preflight + terraform safe-plan 커맨드를 실행/기록
  - terraform/aws 준비가 안 된 경우에도 structured bundle을 생성하고 step을 skipped로 남깁니다.
  - 절대 apply는 실행하지 않습니다.

Options:
  --allow-create-plan     allow_resource_creation=true plan도 추가로 기록 (기본 false)
  --artifact-root <path>  artifact 루트 경로 (기본: infra/rehearsal-artifacts)
  --ci                    CI 요약(GITHUB_STEP_SUMMARY) 작성
  --strict                failed step 존재 시 exit 1 (기본: always exit 0)
  -h, --help              도움말 출력

Examples:
  $(basename "$0") staging
  $(basename "$0") prod --allow-create-plan
  $(basename "$0") dev --artifact-root /tmp/rehearsal-artifacts --strict
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
    --allow-create-plan)
      ALLOW_CREATE_PLAN="true"
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
    --strict)
      STRICT_MODE="true"
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

  "${cmd[@]}" > "$log_file_abs" 2>&1
  exit_code=$?

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

terraform_available="false"
if command -v terraform >/dev/null 2>&1; then
  terraform_available="true"
fi

aws_creds_hint="false"
if [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  aws_creds_hint="true"
fi
if [[ -n "${AWS_PROFILE:-}" || -n "${AWS_ROLE_ARN:-}" || -n "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ]]; then
  aws_creds_hint="true"
fi

aws_creds_available="false"

# 1) Value/template preflight
if [[ -f "$PREFLIGHT_SCRIPT" ]]; then
  run_step "preflight_validate" "${LOG_DIR}/preflight-validate.log" bash "$PREFLIGHT_SCRIPT" "$TARGET_ENV" --ci
else
  fail_step "preflight_validate" "${LOG_DIR}/preflight-validate.log" "127" "preflight 스크립트를 찾을 수 없음" "bash ${PREFLIGHT_SCRIPT} ${TARGET_ENV} --ci"
fi

# 2) AWS identity/credential hint check (skip-safe)
if command -v aws >/dev/null 2>&1; then
  aws_cmd_str="aws sts get-caller-identity --output json"
  if aws sts get-caller-identity --output json > "${LOG_DIR}/aws-identity.log" 2>&1; then
    aws_creds_available="true"
    record_step "aws_identity_check" "success" "0" "logs/aws-identity.log" "aws sts identity 확인 완료" "$aws_cmd_str"
  else
    aws_exit="$?"
    if [[ "$aws_creds_hint" == "true" ]]; then
      aws_creds_available="true"
      record_step "aws_identity_check" "skipped" "$aws_exit" "logs/aws-identity.log" "aws sts 실패(비차단). credential hint 감지되어 terraform plan은 시도" "$aws_cmd_str"
    else
      aws_creds_available="false"
      record_step "aws_identity_check" "skipped" "$aws_exit" "logs/aws-identity.log" "aws credential 미확인으로 terraform plan 단계는 skip" "$aws_cmd_str"
    fi
  fi
else
  if [[ "$aws_creds_hint" == "true" ]]; then
    aws_creds_available="true"
    skip_step "aws_identity_check" "${LOG_DIR}/aws-identity.log" "aws CLI 없음. credential hint 감지(AWS_PROFILE/AKID 등)로 terraform plan 시도" "aws sts get-caller-identity --output json"
  else
    aws_creds_available="false"
    skip_step "aws_identity_check" "${LOG_DIR}/aws-identity.log" "aws CLI 없음 + credential hint 없음으로 terraform plan skip" "aws sts get-caller-identity --output json"
  fi
fi

safe_plan_file="${PLAN_DIR}/${TARGET_ENV}-safe.tfplan"
create_plan_file="${PLAN_DIR}/${TARGET_ENV}-allow-create.tfplan"

if [[ "$terraform_available" == "true" ]]; then
  run_step "terraform_fmt_check" "${LOG_DIR}/terraform-fmt-check.log" terraform -chdir="$TERRAFORM_DIR" fmt -check -recursive

  run_step "terraform_init_backend_false" "${LOG_DIR}/terraform-init.log" terraform -chdir="$TERRAFORM_DIR" init -backend=false -input=false

  if [[ "$LAST_STEP_STATUS" == "success" ]]; then
    run_step "terraform_validate" "${LOG_DIR}/terraform-validate.log" terraform -chdir="$TERRAFORM_DIR" validate
  else
    skip_step "terraform_validate" "${LOG_DIR}/terraform-validate.log" "terraform init 실패로 validate 생략" "terraform -chdir=${TERRAFORM_DIR} validate"
  fi

  validate_status="$(step_status "terraform_validate")"
  if [[ "$validate_status" == "success" ]]; then
    if [[ "$aws_creds_available" == "true" ]]; then
      run_step "terraform_plan_safe" "${LOG_DIR}/terraform-plan-safe.log" terraform -chdir="$TERRAFORM_DIR" plan -input=false -lock=false -refresh=false -var-file="environments/${TARGET_ENV}.tfvars" -var="allow_resource_creation=false" -out="$safe_plan_file"

      if [[ "$LAST_STEP_STATUS" == "success" ]]; then
        run_step "terraform_show_safe" "${LOG_DIR}/terraform-show-safe.log" terraform -chdir="$TERRAFORM_DIR" show -no-color "$safe_plan_file"
      else
        skip_step "terraform_show_safe" "${LOG_DIR}/terraform-show-safe.log" "terraform_plan_safe 실패로 show 생략" "terraform -chdir=${TERRAFORM_DIR} show -no-color ${safe_plan_file}"
      fi
    else
      skip_step "terraform_plan_safe" "${LOG_DIR}/terraform-plan-safe.log" "AWS credential unavailable로 safe plan 생략" "terraform -chdir=${TERRAFORM_DIR} plan ... -var=allow_resource_creation=false"
      skip_step "terraform_show_safe" "${LOG_DIR}/terraform-show-safe.log" "safe plan 미생성으로 show 생략" "terraform -chdir=${TERRAFORM_DIR} show -no-color ${safe_plan_file}"
    fi
  else
    skip_step "terraform_plan_safe" "${LOG_DIR}/terraform-plan-safe.log" "terraform validate 미통과로 safe plan 생략" "terraform -chdir=${TERRAFORM_DIR} plan ... -var=allow_resource_creation=false"
    skip_step "terraform_show_safe" "${LOG_DIR}/terraform-show-safe.log" "safe plan 미생성으로 show 생략" "terraform -chdir=${TERRAFORM_DIR} show -no-color ${safe_plan_file}"
  fi

  if [[ "$ALLOW_CREATE_PLAN" == "true" ]]; then
    if [[ "$validate_status" == "success" && "$aws_creds_available" == "true" ]]; then
      run_step "terraform_plan_allow_create" "${LOG_DIR}/terraform-plan-allow-create.log" terraform -chdir="$TERRAFORM_DIR" plan -input=false -lock=false -refresh=false -var-file="environments/${TARGET_ENV}.tfvars" -var="allow_resource_creation=true" -out="$create_plan_file"

      if [[ "$LAST_STEP_STATUS" == "success" ]]; then
        run_step "terraform_show_allow_create" "${LOG_DIR}/terraform-show-allow-create.log" terraform -chdir="$TERRAFORM_DIR" show -no-color "$create_plan_file"
      else
        skip_step "terraform_show_allow_create" "${LOG_DIR}/terraform-show-allow-create.log" "allow-create plan 실패로 show 생략" "terraform -chdir=${TERRAFORM_DIR} show -no-color ${create_plan_file}"
      fi
    else
      skip_step "terraform_plan_allow_create" "${LOG_DIR}/terraform-plan-allow-create.log" "validate/aws 조건 미충족으로 allow-create plan 생략" "terraform -chdir=${TERRAFORM_DIR} plan ... -var=allow_resource_creation=true"
      skip_step "terraform_show_allow_create" "${LOG_DIR}/terraform-show-allow-create.log" "allow-create plan 미생성으로 show 생략" "terraform -chdir=${TERRAFORM_DIR} show -no-color ${create_plan_file}"
    fi
  fi
else
  skip_step "terraform_fmt_check" "${LOG_DIR}/terraform-fmt-check.log" "terraform CLI 없음" "terraform -chdir=${TERRAFORM_DIR} fmt -check -recursive"
  skip_step "terraform_init_backend_false" "${LOG_DIR}/terraform-init.log" "terraform CLI 없음" "terraform -chdir=${TERRAFORM_DIR} init -backend=false -input=false"
  skip_step "terraform_validate" "${LOG_DIR}/terraform-validate.log" "terraform CLI 없음" "terraform -chdir=${TERRAFORM_DIR} validate"
  skip_step "terraform_plan_safe" "${LOG_DIR}/terraform-plan-safe.log" "terraform CLI 없음" "terraform -chdir=${TERRAFORM_DIR} plan ... -var=allow_resource_creation=false"
  skip_step "terraform_show_safe" "${LOG_DIR}/terraform-show-safe.log" "terraform CLI 없음" "terraform -chdir=${TERRAFORM_DIR} show -no-color ${safe_plan_file}"

  if [[ "$ALLOW_CREATE_PLAN" == "true" ]]; then
    skip_step "terraform_plan_allow_create" "${LOG_DIR}/terraform-plan-allow-create.log" "terraform CLI 없음" "terraform -chdir=${TERRAFORM_DIR} plan ... -var=allow_resource_creation=true"
    skip_step "terraform_show_allow_create" "${LOG_DIR}/terraform-show-allow-create.log" "terraform CLI 없음" "terraform -chdir=${TERRAFORM_DIR} show -no-color ${create_plan_file}"
  fi
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

required_steps=(preflight_validate terraform_init_backend_false terraform_validate terraform_plan_safe)
go_decision="GO"
for step in "${required_steps[@]}"; do
  current_status="$(step_status "$step")"
  if [[ "$current_status" != "success" ]]; then
    go_decision="STOP"
    break
  fi
done

LATEST_FILE="${ARTIFACT_ROOT_ABS}/LATEST"
mkdir -p "$ARTIFACT_ROOT_ABS"
printf "%s\n" "$ARTIFACT_DIR_REL" > "$LATEST_FILE"

{
  echo "# Terraform Dry-Run Rehearsal Summary"
  echo
  echo "- generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- target_env: ${TARGET_ENV}"
  echo "- artifact_dir: ${ARTIFACT_DIR_REL}"
  echo "- terraform_available: ${terraform_available}"
  echo "- aws_creds_hint: ${aws_creds_hint}"
  echo "- aws_creds_available: ${aws_creds_available}"
  echo "- overall_status: ${overall_status}"
  echo "- go_decision: ${go_decision}"
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

  echo
  echo "## Stop/Go Quick Rule"
  echo "- GO: preflight + terraform init/validate + terraform safe plan 이 모두 success"
  echo "- STOP: 위 필수 step 중 하나라도 failed/skipped"
} > "$SUMMARY_MD"

{
  echo "{"
  echo "  \"generatedAtUtc\": \"$(json_escape "$(date -u +%Y-%m-%dT%H:%M:%SZ)")\","
  echo "  \"targetEnv\": \"$(json_escape "$TARGET_ENV")\","
  echo "  \"artifactDir\": \"$(json_escape "$ARTIFACT_DIR_REL")\","
  echo "  \"terraformAvailable\": ${terraform_available},"
  echo "  \"awsCredsHint\": ${aws_creds_hint},"
  echo "  \"awsCredsAvailable\": ${aws_creds_available},"
  echo "  \"overallStatus\": \"$(json_escape "$overall_status")\","
  echo "  \"goDecision\": \"$(json_escape "$go_decision")\","
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
    echo "### Terraform rehearsal dry-run (${TARGET_ENV})"
    echo "- artifact: \`${ARTIFACT_DIR_REL}\`"
    echo "- overall status: **${overall_status}**"
    echo "- go decision: **${go_decision}**"
    echo "- terraform available: \`${terraform_available}\`"
    echo "- aws credentials available: \`${aws_creds_available}\`"
    echo
    echo "상세는 \`${ARTIFACT_DIR_REL}/status-summary.md\` 및 \`${ARTIFACT_DIR_REL}/status.json\` 확인."
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "✅ Terraform rehearsal artifact bundle 생성 완료"
echo "ARTIFACT_DIR=${ARTIFACT_DIR_REL}"
echo "OVERALL_STATUS=${overall_status}"
echo "GO_DECISION=${go_decision}"

if [[ "$STRICT_MODE" == "true" && "$failed_count" -gt 0 ]]; then
  exit 1
fi

exit 0
