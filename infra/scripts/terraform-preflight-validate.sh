#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="${SCRIPT_DIR}/../terraform"
ENVIRONMENTS_DIR="${TERRAFORM_DIR}/environments"
TEMPLATES_DIR="${ENVIRONMENTS_DIR}/templates"

CI_MODE="false"
TARGET_ENV="all"

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [dev|staging|prod|all] [--ci]

Description:
  - tfvars 파일과 환경 템플릿의 필수 필드/섹션 완전성을 점검합니다.
  - plan/apply 실행 전 값 준비 상태를 검증하는 preflight guard 용도입니다.

Options:
  --ci            CI 모드 (요약 출력 강화)
  -h, --help      도움말 출력

Examples:
  $(basename "$0") dev
  $(basename "$0") all
  $(basename "$0") staging --ci
USAGE
}

if [[ $# -gt 0 ]]; then
  case "$1" in
    dev|staging|prod|all)
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

readonly REQUIRED_TFVARS_KEYS=(
  environment
  aws_region
  project_name
  allow_resource_creation
  enable_vpc
  enable_rds
  enable_ecs
  enable_s3
  vpc_cidr
  availability_zones
  public_subnet_cidrs
  private_subnet_cidrs
  enable_nat_gateway
  db_name
  db_instance_class
  db_allocated_storage
  db_max_allocated_storage
  db_backup_retention_days
  db_multi_az
  db_deletion_protection
  db_skip_final_snapshot
  db_final_snapshot_identifier
  db_master_username
  db_master_password
  db_engine_version
  ecs_desired_count
  ecs_enable_container_insights
  ecs_enable_alb
  ecs_alb_ingress_cidrs
  ecs_log_retention_days
  s3_artifacts_bucket_name
  s3_logs_bucket_name
  s3_force_destroy
  s3_enable_versioning
  s3_noncurrent_expiration_days
  tags
)

readonly REQUIRED_TEMPLATE_SECTIONS=(
  section:core
  section:network
  section:db
  section:ecs
  section:s3
  section:operational-notes
)

readonly REQUIRED_OPERATIONAL_NOTE_KEYS=(
  ops_owner
  reviewer
  rehearsal_window_kst
  rollback_owner
  rollback_plan
  verification_points
  communication_channel
  ticket_reference
)

has_assignment() {
  local file="$1"
  local key="$2"
  local allow_commented="${3:-false}"
  local pattern

  if [[ "$allow_commented" == "true" ]]; then
    pattern="^[[:space:]#]*${key}[[:space:]]*="
  else
    pattern="^[[:space:]]*${key}[[:space:]]*="
  fi

  grep -Eq "$pattern" "$file"
}

check_non_empty_string() {
  local file="$1"
  local key="$2"
  local line

  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" | head -n 1 || true)"
  if [[ -z "$line" || "$line" =~ =[[:space:]]*\"\" ]]; then
    return 1
  fi

  return 0
}

check_non_empty_list() {
  local file="$1"
  local key="$2"
  local line

  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" | head -n 1 || true)"
  if [[ -z "$line" || "$line" =~ \[[[:space:]]*\] ]]; then
    return 1
  fi

  return 0
}

validate_tfvars() {
  local env="$1"
  local file="${ENVIRONMENTS_DIR}/${env}.tfvars"
  local failed=0
  local key

  echo "🔎 [${env}] tfvars 점검: ${file}"

  if [[ ! -f "$file" ]]; then
    echo "  ❌ 파일 없음"
    return 1
  fi

  for key in "${REQUIRED_TFVARS_KEYS[@]}"; do
    if ! has_assignment "$file" "$key" "false"; then
      echo "  ❌ 필수 키 누락: ${key}"
      failed=1
    fi
  done

  if ! grep -Eq "^[[:space:]]*environment[[:space:]]*=[[:space:]]*\"${env}\"" "$file"; then
    echo "  ❌ environment 값이 '${env}'와 일치하지 않음"
    failed=1
  fi

  for key in environment aws_region project_name vpc_cidr db_name db_instance_class; do
    if ! check_non_empty_string "$file" "$key"; then
      echo "  ❌ 빈 문자열 불가 키 미설정: ${key}"
      failed=1
    fi
  done

  for key in availability_zones public_subnet_cidrs private_subnet_cidrs ecs_alb_ingress_cidrs; do
    if ! check_non_empty_list "$file" "$key"; then
      echo "  ❌ 비어있는 리스트 불가 키 미설정: ${key}"
      failed=1
    fi
  done

  local placeholder_hits
  placeholder_hits="$(grep -En '(<[^>]+>|TODO|REPLACE_ME|CHANGE_ME)' "$file" || true)"
  if [[ -n "$placeholder_hits" ]]; then
    echo "  ❌ tfvars에 placeholder/TODO가 남아 있음"
    echo "$placeholder_hits" | sed 's/^/    - /'
    failed=1
  fi

  if [[ "$failed" -eq 0 ]]; then
    echo "  ✅ tfvars 완전성 통과"
  fi

  return "$failed"
}

validate_template() {
  local env="$1"
  local file="${TEMPLATES_DIR}/${env}.values.tfvars.template"
  local failed=0
  local key

  echo "🧩 [${env}] template 점검: ${file}"

  if [[ ! -f "$file" ]]; then
    echo "  ❌ 파일 없음"
    return 1
  fi

  for key in "${REQUIRED_TEMPLATE_SECTIONS[@]}"; do
    if ! grep -Fq "$key" "$file"; then
      echo "  ❌ 필수 섹션 누락: ${key}"
      failed=1
    fi
  done

  for key in "${REQUIRED_TFVARS_KEYS[@]}"; do
    if ! has_assignment "$file" "$key" "false"; then
      echo "  ❌ 필수 템플릿 키 누락: ${key}"
      failed=1
    fi
  done

  for key in "${REQUIRED_OPERATIONAL_NOTE_KEYS[@]}"; do
    if ! has_assignment "$file" "$key" "true"; then
      echo "  ❌ 운영 노트 키 누락: ${key}"
      failed=1
    fi
  done

  if [[ "$failed" -eq 0 ]]; then
    echo "  ✅ template 완전성 통과"
  fi

  return "$failed"
}

environments=(dev staging prod)
if [[ "$TARGET_ENV" != "all" ]]; then
  environments=("$TARGET_ENV")
fi

total_failed=0

echo "▶ Terraform preflight validation 시작"
for env in "${environments[@]}"; do
  if ! validate_tfvars "$env"; then
    total_failed=$((total_failed + 1))
  fi

  if ! validate_template "$env"; then
    total_failed=$((total_failed + 1))
  fi
done

if [[ "$total_failed" -gt 0 ]]; then
  echo
  echo "❌ Terraform preflight 실패 (실패 그룹: ${total_failed})"

  if [[ "$CI_MODE" == "true" && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### ❌ Terraform preflight failed"
      echo "- target: ${TARGET_ENV}"
      echo "- failed groups: ${total_failed}"
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  exit 1
fi

echo
echo "✅ Terraform preflight 통과 (${#environments[@]}개 환경)"

if [[ "$CI_MODE" == "true" && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### ✅ Terraform preflight passed"
    echo "- target: ${TARGET_ENV}"
    echo "- validated environments: ${#environments[@]}"
  } >> "$GITHUB_STEP_SUMMARY"
fi
