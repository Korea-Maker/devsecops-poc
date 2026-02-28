# Terraform Environment Value Templates

이 디렉터리는 `dev/staging/prod` 환경별 **값 준비 템플릿**을 담는다.

- `*.values.tfvars.template` 파일을 기준으로 환경 값을 점검/정리한다.
- 시크릿은 절대 저장하지 않는다. (예: `db_master_password`는 `null` 유지)
- 템플릿 작성 후 `infra/terraform/environments/<env>.tfvars`에 반영한다.
- `bash infra/scripts/terraform-preflight-validate.sh <env>`로 완전성 검증을 수행한다.

필수 섹션:
- `section:network`
- `section:db`
- `section:ecs`
- `section:s3`
- `section:operational-notes`
