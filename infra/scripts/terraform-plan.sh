#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="${SCRIPT_DIR}/../terraform"
PREFLIGHT_SCRIPT="${SCRIPT_DIR}/terraform-preflight-validate.sh"

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") <dev|staging|prod> [--allow-create] [--out <plan-file>] [--skip-preflight]

Options:
  --allow-create    Terraform plan 시 allow_resource_creation=true로 실행
                    (기본값 false: 안전 모드)
  --out <file>      plan output 파일 경로 (기본: infra/terraform/plans/<env>.tfplan)
  --skip-preflight  내부 옵션 (apply 스크립트에서 preflight 중복 실행 방지)
  -h, --help        도움말 출력

Examples:
  $(basename "$0") staging
  $(basename "$0") dev --allow-create --out infra/terraform/plans/dev-create.tfplan
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" || $# -lt 1 ]]; then
  usage
  exit $([[ $# -lt 1 ]] && echo 1 || echo 0)
fi

ENVIRONMENT="$1"
shift

ALLOW_CREATE="false"
PLAN_OUT=""
SKIP_PREFLIGHT="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-create)
      ALLOW_CREATE="true"
      shift
      ;;
    --out)
      [[ $# -ge 2 ]] || {
        echo "❌ --out 옵션에는 파일 경로가 필요합니다." >&2
        exit 1
      }
      PLAN_OUT="$2"
      shift 2
      ;;
    --skip-preflight)
      SKIP_PREFLIGHT="true"
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

case "$ENVIRONMENT" in
  dev|staging|prod) ;;
  *)
    echo "❌ 환경 값은 dev|staging|prod 중 하나여야 합니다." >&2
    exit 1
    ;;
esac

if [[ "$SKIP_PREFLIGHT" != "true" ]]; then
  if [[ ! -x "$PREFLIGHT_SCRIPT" ]]; then
    echo "❌ preflight 스크립트를 실행할 수 없습니다: $PREFLIGHT_SCRIPT" >&2
    exit 1
  fi

  echo "▶ Terraform preflight validation"
  "$PREFLIGHT_SCRIPT" "$ENVIRONMENT"
fi

if ! command -v terraform >/dev/null 2>&1; then
  echo "❌ terraform CLI를 찾을 수 없습니다. 설치 후 다시 실행하세요." >&2
  exit 1
fi

TFVARS_FILE="${TERRAFORM_DIR}/environments/${ENVIRONMENT}.tfvars"
if [[ ! -f "$TFVARS_FILE" ]]; then
  echo "❌ tfvars 파일이 없습니다: $TFVARS_FILE" >&2
  exit 1
fi

if [[ -z "$PLAN_OUT" ]]; then
  PLAN_OUT="${TERRAFORM_DIR}/plans/${ENVIRONMENT}.tfplan"
fi

PLAN_DIR="$(dirname "$PLAN_OUT")"
mkdir -p "$PLAN_DIR"

if [[ "$PLAN_OUT" = /* ]]; then
  PLAN_OUT_ABS="$PLAN_OUT"
else
  PLAN_OUT_ABS="$(cd "$PLAN_DIR" && pwd)/$(basename "$PLAN_OUT")"
fi

echo "▶ Terraform init (backend=false)"
terraform -chdir="$TERRAFORM_DIR" init -backend=false -input=false >/dev/null

echo "▶ Terraform validate"
terraform -chdir="$TERRAFORM_DIR" validate >/dev/null

echo "▶ Terraform plan"
terraform -chdir="$TERRAFORM_DIR" plan \
  -input=false \
  -lock=false \
  -refresh=false \
  -var-file="environments/${ENVIRONMENT}.tfvars" \
  -var="allow_resource_creation=${ALLOW_CREATE}" \
  -out="$PLAN_OUT_ABS"

echo
if [[ "$ALLOW_CREATE" == "true" ]]; then
  echo "⚠️  allow_resource_creation=true 로 plan 생성됨"
else
  echo "✅ 안전 모드 plan 생성됨 (allow_resource_creation=false)"
fi

echo "📄 Plan file: $PLAN_OUT_ABS"
