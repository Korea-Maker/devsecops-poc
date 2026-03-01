# Terraform Dry-Run Operator Handoff (Ops MVP Phase R)

Terraform 리허설을 **실제 apply 없이(dry-run only)** 수행하고, 운영자 인수인계에 필요한 산출물을 남기기 위한 실행 가이드.

---

## 1) 목적 / 범위

- `preflight + terraform safe plan` 실행 결과를 아티팩트로 저장
- 아티팩트 경로: `infra/rehearsal-artifacts/<timestamp>-<env>/`
- **절대 포함하지 않는 것**: `terraform apply`, 시크릿 평문, 환경변수 덤프

---

## 2) 실행 전 체크 (2분)

- [ ] 최신 코드 동기화 (`git pull --ff-only`)
- [ ] 대상 `tfvars`/template 업데이트 완료
- [ ] 리허설 채널(예: Slack/Telegram) 고정
- [ ] Terraform/AWS 준비 여부 확인 (없어도 스크립트는 skip-safe로 동작)

---

## 3) 실행 명령 (복붙용)

### A. 기본 리허설 (safe plan만)

```bash
bash infra/scripts/terraform-rehearsal-artifacts.sh staging
```

### B. 생성 포함 plan까지 리허설(선택)

```bash
bash infra/scripts/terraform-rehearsal-artifacts.sh staging --allow-create-plan
```

### C. 실패 step이 있으면 non-zero로 받고 싶은 경우(선택)

```bash
bash infra/scripts/terraform-rehearsal-artifacts.sh staging --strict
```

실행 완료 시 표준 출력에서 아래 키를 확인:

- `ARTIFACT_DIR=...`
- `OVERALL_STATUS=...`
- `GO_DECISION=...`

---

## 4) 기대 산출물

예시:

```text
infra/rehearsal-artifacts/20260301T001122Z-staging/
├── commands.log
├── status.tsv
├── status.json
├── status-summary.md
├── logs/
│   ├── preflight-validate.log
│   ├── terraform-init.log
│   ├── terraform-validate.log
│   ├── terraform-plan-safe.log
│   └── ...
└── plans/
    ├── staging-safe.tfplan
    └── (optional) staging-allow-create.tfplan
```

> `terraform` 또는 AWS credential이 준비되지 않은 경우에도 동일한 구조가 생성되며, 해당 step은 `skipped`로 명시된다.

---

## 5) Stop / Go 기준

### GO

아래 필수 step이 모두 `success`이고, plan diff가 승인 범위 내일 때:

- `preflight_validate`
- `terraform_init_backend_false`
- `terraform_validate`
- `terraform_plan_safe`

### STOP

아래 중 하나라도 해당하면 즉시 중단:

- 필수 step 중 하나라도 `failed` 또는 `skipped`
- `terraform_show_safe` 결과에 예상 외 `destroy/replace` 포함
- preflight 결과에서 placeholder/TODO 또는 필수 키 누락 발견

---

## 6) 롤백 / 중단 액션

### Dry-run 리허설 실패 시

리허설은 apply를 수행하지 않으므로 **클라우드 리소스 롤백은 불필요**.

1. 리허설 채널에 `STOP` 선언
2. `status-summary.md` + 핵심 로그 공유
3. 원인 수정(tfvars/tooling/credential) 후 재실행

### (예외) 실수로 apply가 수행된 경우

1. 즉시 변경 중지(추가 apply 금지)
2. `bash infra/scripts/terraform-plan.sh <env>`로 현재 변경 범위 재확인
3. 템플릿 운영 노트의 rollback owner 승인 후, 기존 승인된 롤백 절차(`terraform-apply.sh`) 수행

---

## 7) 제출 패키지 (핸드오프 최소 단위)

- `status-summary.md`
- `status.json`
- `commands.log`
- 실패/경고 step 대응 코멘트(티켓/PR 코멘트 3~5줄)

이 4가지만 있으면 운영자 핸드오프 가능.
