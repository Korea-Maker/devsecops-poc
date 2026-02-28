# Terraform 운영 가이드 (Ops MVP Phase O)

이 디렉터리는 **safe-by-default** 원칙으로 설계된 Terraform skeleton이다.

- 기본값으로는 리소스가 생성되지 않는다.
- `terraform apply`를 실행해도 `allow_resource_creation=false`이면 no-op 계획이 나온다.
- 실제 생성은 **명시적 create 스위치 + 모듈 토글 + apply 확인**이 모두 필요하다.

---

## 디렉터리 구조

```text
infra/terraform/
├── main.tf
├── variables.tf
├── outputs.tf
├── environments/
│   ├── dev.tfvars
│   ├── staging.tfvars
│   └── prod.tfvars
├── modules/
│   ├── vpc/
│   ├── rds/
│   ├── ecs/
│   └── s3/
└── plans/
```

---

## 모듈 토글 정책

루트 변수:

- `allow_resource_creation` (기본: `false`)
- `enable_vpc`, `enable_rds`, `enable_ecs`, `enable_s3` (기본: 전부 `false`)

실제 리소스 생성 조건:

1. `allow_resource_creation=true`
2. 필요한 `enable_*` 모듈 토글이 `true`
3. `terraform-apply.sh`에서 환경 확인 통과

---

## 권장 실행 순서

### 1) 계획 확인 (안전 모드, 생성 없음)

```bash
bash infra/scripts/terraform-plan.sh staging
```

### 2) 생성 포함 계획 확인

```bash
bash infra/scripts/terraform-plan.sh staging --allow-create
```

### 3) 적용 (대화형 확인)

```bash
# no-op apply (기본 안전모드)
bash infra/scripts/terraform-apply.sh staging

# 실제 생성 허용 apply
bash infra/scripts/terraform-apply.sh staging --allow-create
```

### 4) 프로덕션 적용 (추가 가드)

```bash
# --allow-prod 없으면 즉시 거부됨
bash infra/scripts/terraform-apply.sh prod --allow-prod --allow-create
```

> prod apply는 `--allow-prod` + 추가 확인 문자열 입력까지 통과해야 진행된다.

---

## CI 정책

PR에서는 `.github/workflows/terraform-pr-checks.yml`에서 다음만 수행한다.

- `terraform fmt -check -recursive`
- `terraform validate` (backend=false init)
- `terraform plan` (staging tfvars, `allow_resource_creation=false`, creds가 있을 때만)

즉, CI에서 apply는 절대 실행하지 않는다.

---

## TODO (다음 단계)

- Remote backend(S3 + DynamoDB lock) 활성화
- ECS task definition/service autoscaling 실연동
- RDS parameter/option group + CloudWatch alarm 연동
- S3 bucket policy least privilege + KMS encryption key 분리
