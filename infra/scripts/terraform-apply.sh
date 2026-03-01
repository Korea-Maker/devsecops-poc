#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="${SCRIPT_DIR}/../terraform"
PLAN_SCRIPT="${SCRIPT_DIR}/terraform-plan.sh"
PREFLIGHT_SCRIPT="${SCRIPT_DIR}/terraform-preflight-validate.sh"

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") <dev|staging|prod> [--allow-create] [--allow-prod] [--plan-file <file>] [--skip-preflight] [--skip-plan] [--non-interactive] [--confirm-apply-token <token>] [--confirm-prod-token <token>]

Safety guards:
  - 환경 인자(dev|staging|prod) 필수
  - apply 전 preflight 완전성 검증(기본)
  - apply 전 plan 재생성(기본)
  - apply 전 항상 확인(기본: 대화형)
  - production(prod) apply는 --allow-prod 없으면 즉시 거부

Options:
  --allow-create            allow_resource_creation=true로 plan/apply 수행
  --allow-prod              prod 환경 apply 명시 허용 플래그 (필수)
  --plan-file <file>        plan 파일 경로 (기본: infra/terraform/plans/<env>.tfplan)
  --skip-preflight          내부 옵션 (외부 파이프라인에서 preflight 완료 시)
  --skip-plan               내부 옵션 (기존 plan 파일을 그대로 apply)
  --non-interactive         CI/자동화 모드(토큰 기반 확인 문자열 검증)
  --confirm-apply-token     non-interactive 모드에서 반드시 apply
  --confirm-prod-token      non-interactive + prod 모드에서 반드시 prod-apply
  -h, --help                도움말 출력

Examples:
  $(basename "$0") staging
  $(basename "$0") staging --allow-create
  $(basename "$0") prod --allow-prod --allow-create
  $(basename "$0") staging --skip-preflight --skip-plan --non-interactive --confirm-apply-token apply
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" || $# -lt 1 ]]; then
  usage
  exit $([[ $# -lt 1 ]] && echo 1 || echo 0)
fi

ENVIRONMENT="$1"
shift

ALLOW_CREATE="false"
ALLOW_PROD="false"
PLAN_FILE=""
SKIP_PREFLIGHT="false"
SKIP_PLAN="false"
NON_INTERACTIVE="false"
CONFIRM_APPLY_TOKEN=""
CONFIRM_PROD_TOKEN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-create)
      ALLOW_CREATE="true"
      shift
      ;;
    --allow-prod)
      ALLOW_PROD="true"
      shift
      ;;
    --plan-file)
      [[ $# -ge 2 ]] || {
        echo "❌ --plan-file 옵션에는 파일 경로가 필요합니다." >&2
        exit 1
      }
      PLAN_FILE="$2"
      shift 2
      ;;
    --skip-preflight)
      SKIP_PREFLIGHT="true"
      shift
      ;;
    --skip-plan)
      SKIP_PLAN="true"
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE="true"
      shift
      ;;
    --confirm-apply-token)
      [[ $# -ge 2 ]] || {
        echo "❌ --confirm-apply-token 옵션에는 값이 필요합니다." >&2
        exit 1
      }
      CONFIRM_APPLY_TOKEN="$2"
      shift 2
      ;;
    --confirm-prod-token)
      [[ $# -ge 2 ]] || {
        echo "❌ --confirm-prod-token 옵션에는 값이 필요합니다." >&2
        exit 1
      }
      CONFIRM_PROD_TOKEN="$2"
      shift 2
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

if [[ "$ENVIRONMENT" == "prod" && "$ALLOW_PROD" != "true" ]]; then
  echo "❌ production(prod) apply는 --allow-prod 플래그 없이는 실행할 수 없습니다." >&2
  exit 1
fi

if [[ "$SKIP_PREFLIGHT" != "true" && ! -x "$PREFLIGHT_SCRIPT" ]]; then
  echo "❌ preflight 스크립트를 실행할 수 없습니다: $PREFLIGHT_SCRIPT" >&2
  exit 1
fi

if [[ "$SKIP_PLAN" != "true" && ! -x "$PLAN_SCRIPT" ]]; then
  echo "❌ plan 스크립트를 실행할 수 없습니다: $PLAN_SCRIPT" >&2
  exit 1
fi

if [[ -z "$PLAN_FILE" ]]; then
  PLAN_FILE="${TERRAFORM_DIR}/plans/${ENVIRONMENT}.tfplan"
fi

PLAN_DIR="$(dirname "$PLAN_FILE")"
mkdir -p "$PLAN_DIR"

if [[ "$PLAN_FILE" = /* ]]; then
  PLAN_FILE_ABS="$PLAN_FILE"
else
  PLAN_FILE_ABS="$(cd "$PLAN_DIR" && pwd)/$(basename "$PLAN_FILE")"
fi

if ! command -v terraform >/dev/null 2>&1; then
  echo "❌ terraform CLI를 찾을 수 없습니다. 설치 후 다시 실행하세요." >&2
  exit 1
fi

if [[ "$SKIP_PREFLIGHT" != "true" ]]; then
  echo "▶ 0) preflight validation"
  "$PREFLIGHT_SCRIPT" "$ENVIRONMENT"
else
  echo "▶ 0) preflight validation (skip-preflight=true)"
fi

if [[ "$SKIP_PLAN" != "true" ]]; then
  echo "▶ 1) apply 대상 plan 생성"
  if [[ "$ALLOW_CREATE" == "true" ]]; then
    "$PLAN_SCRIPT" "$ENVIRONMENT" --allow-create --out "$PLAN_FILE_ABS" --skip-preflight
  else
    "$PLAN_SCRIPT" "$ENVIRONMENT" --out "$PLAN_FILE_ABS" --skip-preflight
  fi
else
  echo "▶ 1) apply 대상 plan 재사용 (skip-plan=true)"
  if [[ ! -f "$PLAN_FILE_ABS" ]]; then
    echo "❌ --skip-plan 모드에서는 기존 plan 파일이 필요합니다: $PLAN_FILE_ABS" >&2
    exit 1
  fi
fi

echo
echo "================ Terraform Apply Guard ================"
echo "Environment            : $ENVIRONMENT"
echo "allow_resource_creation: $ALLOW_CREATE"
echo "Plan file              : $PLAN_FILE_ABS"
echo "skip_preflight         : $SKIP_PREFLIGHT"
echo "skip_plan              : $SKIP_PLAN"
echo "non_interactive        : $NON_INTERACTIVE"
echo "======================================================="

if [[ "$NON_INTERACTIVE" == "true" ]]; then
  if [[ "$ENVIRONMENT" == "prod" && "$CONFIRM_PROD_TOKEN" != "prod-apply" ]]; then
    echo "❌ non-interactive prod apply는 --confirm-prod-token prod-apply 가 필요합니다." >&2
    exit 1
  fi

  if [[ "$CONFIRM_APPLY_TOKEN" != "apply" ]]; then
    echo "❌ non-interactive apply는 --confirm-apply-token apply 가 필요합니다." >&2
    exit 1
  fi
else
  if [[ "$ENVIRONMENT" == "prod" ]]; then
    read -r -p "⚠️  PROD 적용 확인: 'prod-apply' 를 정확히 입력해야 진행됩니다: " prod_confirm
    if [[ "$prod_confirm" != "prod-apply" ]]; then
      echo "❌ production 확인 문자열이 일치하지 않아 중단합니다."
      exit 1
    fi
  fi

  read -r -p "정말 apply를 진행할까? 진행하려면 'apply' 입력: " confirm
  if [[ "$confirm" != "apply" ]]; then
    echo "ℹ️ apply를 취소했습니다."
    exit 0
  fi
fi

echo "▶ 2) terraform apply 실행"
terraform -chdir="$TERRAFORM_DIR" apply -input=false "$PLAN_FILE_ABS"

echo "✅ Terraform apply 완료"
