# Terraform 운영 가이드 (Ops MVP Phase O + P + T)

이 디렉터리는 **safe-by-default** 원칙으로 설계된 Terraform skeleton이다.

- 기본값으로는 리소스가 생성되지 않는다.
- 실제 생성은 **명시적 create 스위치 + 모듈 토글 + 수동 승인**이 모두 필요하다.
- `terraform-plan.sh`/`terraform-apply.sh`/`terraform-apply-pipeline.sh`는 실행 전 `terraform-preflight-validate.sh`를 통해 값/템플릿 상태를 먼저 검증한다.
- GitHub workflow `.github/workflows/terraform-manual-apply.yml`은 `workflow_dispatch`로만 동작하며, push/PR에서 자동 apply를 절대 수행하지 않는다.

---

## 디렉터리 구조

```text
infra/terraform/
├── main.tf
├── variables.tf
├── outputs.tf
├── DRY_RUN_REHEARSAL_CHECKLIST.md
├── OPERATOR_HANDOFF.md
├── environments/
│   ├── dev.tfvars
│   ├── staging.tfvars
│   ├── prod.tfvars
│   └── templates/
│       ├── README.md
│       ├── dev.values.tfvars.template
│       ├── staging.values.tfvars.template
│       └── prod.values.tfvars.template
├── modules/
│   ├── vpc/
│   ├── rds/
│   ├── ecs/
│   └── s3/
└── plans/
```

추가 아티팩트 경로:

- dry-run 리허설: `infra/rehearsal-artifacts/`
- 수동 apply 파이프라인: `infra/apply-artifacts/`

---

## 모듈 토글 정책

루트 변수:

- `allow_resource_creation` (기본: `false`)
- `enable_vpc`, `enable_rds`, `enable_ecs`, `enable_s3` (기본: 전부 `false`)

실제 리소스 생성 조건:

1. `allow_resource_creation=true`
2. 필요한 `enable_*` 모듈 토글이 `true`
3. apply guard(`--allow-prod`, 확인 문자열, 수동 워크플로우 가드) 통과

---

## 권장 실행 순서 (로컬/운영자)

### 1) dry-run rehearsal 아티팩트 번들 생성 (권장)

```bash
bash infra/scripts/terraform-rehearsal-artifacts.sh staging
```

### 2) 값/템플릿 preflight 검증

```bash
bash infra/scripts/terraform-preflight-validate.sh staging
```

### 3) 계획 확인 (안전 모드, 생성 없음)

```bash
bash infra/scripts/terraform-plan.sh staging
```

### 4) 생성 포함 계획 확인

```bash
bash infra/scripts/terraform-plan.sh staging --allow-create
```

### 5) 운영자/CI 래퍼 실행 (기본: plan-only)

```bash
bash infra/scripts/terraform-apply-pipeline.sh staging --allow-create
```

### 6) apply 실행 (명시적으로만)

```bash
# staging apply
bash infra/scripts/terraform-apply-pipeline.sh staging --allow-create --apply

# production apply (추가 보호장치)
bash infra/scripts/terraform-apply-pipeline.sh prod --allow-create --apply --allow-prod
```

> `terraform-apply-pipeline.sh`는 내부적으로 `preflight -> plan -> optional apply`를 순서대로 실행하고, 단계별 로그/요약 JSON을 남긴다.

---

## GitHub 수동 apply 워크플로우

워크플로우: `.github/workflows/terraform-manual-apply.yml`

### 트리거

- `workflow_dispatch`만 허용
- push/PR 자동 트리거 없음

### 강제 가드

- branch restriction: `main`에서만 실행 가능
- confirm 문자열: `APPLY_TERRAFORM_<ENV>` 필수
- 환경 재입력 confirm: `confirm_environment=<selected env>` 일치 필수
- prod apply 시 `production_confirm=PROD_APPLY_ACK` 추가 확인 필수
- AWS credentials/secrets 미구성 시 명확한 이유로 즉시 중단

### 입력값

- `environment`: `dev|staging|prod`
- `allow_create`: `true|false` (기본 false)
- `execute_apply`: `true|false` (기본 false, plan-only)
- `confirm`, `confirm_environment`, `production_confirm`

### 아티팩트

- `infra/apply-artifacts/<timestamp>-<env>/`
  - `logs/preflight-validate.log`
  - `logs/terraform-plan.log`
  - `logs/terraform-apply.log`
  - `status-summary.md`, `status.json`, `commands.log`

---

## GitHub 환경 보호/시크릿 권장 설정

최소 권장:

1. GitHub Environments 생성: `dev`, `staging`, `prod`
2. 보호 규칙
   - `staging`: 최소 1명 required reviewer
   - `prod`: 최소 2명 required reviewer + wait timer(권장)
   - Deployment branches: `main`만 허용
3. Environment 또는 repository secrets
   - 인증 방식 A(OIDC 권장): `AWS_ROLE_TO_ASSUME`
   - 인증 방식 B(static): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
   - 선택: `AWS_SESSION_TOKEN`
4. 선택 변수
   - `TERRAFORM_AWS_REGION` (미설정 시 tfvars의 `aws_region` 사용)

---

## Dry-run rehearsal 문서

- 체크리스트: [`DRY_RUN_REHEARSAL_CHECKLIST.md`](./DRY_RUN_REHEARSAL_CHECKLIST.md)
- 운영자 핸드오프: [`OPERATOR_HANDOFF.md`](./OPERATOR_HANDOFF.md)
- 환경 템플릿: [`environments/templates/`](./environments/templates/)

---

## CI 정책

- PR: `.github/workflows/terraform-pr-checks.yml`
  - (optional/non-blocking) preflight
  - fmt/validate/plan(safe)
  - apply 없음
- 수동 dry-run: `.github/workflows/terraform-rehearsal-dry-run.yml`
- 수동 apply: `.github/workflows/terraform-manual-apply.yml`

즉, **자동 실행 경로(push/PR)에서는 apply가 절대 일어나지 않는다.**

---

## 아직 외부에서 준비해야 하는 것

코드/자동화 외부 선행조건(이 저장소 밖):

- 실제 AWS 계정/결제/조직 정책 준비
- Terraform 실행 IAM 권한(최소권한) 및 신뢰 정책(OIDC 또는 access key)
- Remote backend(S3 + DynamoDB lock) 실구성 및 state 운영정책 확정
- 환경별 GitHub Environment approvals/reviewers 실제 등록

위 항목이 준비되지 않으면 워크플로우는 guard 단계에서 중단되거나, plan-only로만 운영된다.
