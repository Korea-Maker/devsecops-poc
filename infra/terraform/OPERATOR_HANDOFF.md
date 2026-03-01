# Terraform Operator Handoff (Ops MVP Phase R + T)

Terraform 리허설/수동 apply를 운영자가 **안전하게 인수인계**하기 위한 실행 가이드.

핵심 원칙:

- 기본 동작은 plan-only(비파괴)다.
- 실제 apply는 GitHub 수동 워크플로우에서만 수행한다.
- 모든 실행은 아티팩트(`status-summary.md`, `status.json`, 로그)를 남긴다.

---

## 1) 범위

이 문서가 다루는 범위:

- dry-run rehearsal 실행 및 결과 해석
- 첫 실 프로비저닝 실행(runbook)
- 중단/롤백 의사결정 기준

이 문서가 다루지 않는 범위:

- AWS 계정 생성/결제/조직 정책 세팅
- IAM 신규 설계(권한 모델 수립)
- Terraform remote backend 실제 계정 리소스 구성

---

## 2) Dry-run rehearsal (apply 없음)

### 실행 전 체크 (2분)

- [ ] 최신 코드 동기화 (`git pull --ff-only`)
- [ ] 대상 `tfvars`/template 업데이트 완료
- [ ] 리허설 채널(예: Slack/Telegram) 고정
- [ ] Terraform/AWS 준비 여부 확인 (없어도 리허설 스크립트는 skip-safe)

### 실행 명령

```bash
# safe plan만
bash infra/scripts/terraform-rehearsal-artifacts.sh staging

# allow-create plan까지 포함(선택)
bash infra/scripts/terraform-rehearsal-artifacts.sh staging --allow-create-plan
```

### 산출물

`infra/rehearsal-artifacts/<timestamp>-<env>/`

- `status-summary.md`
- `status.json`
- `commands.log`
- `logs/*.log`
- `plans/*.tfplan` (생성된 경우)

---

## 3) 첫 실 프로비저닝 runbook (GitHub 수동 apply)

> 로컬 단말에서 직접 실 apply를 시도하지 말고, `.github/workflows/terraform-manual-apply.yml`를 사용한다.

### 사전 준비 (최초 1회)

- [ ] GitHub Environments: `dev`, `staging`, `prod` 생성
- [ ] 보호 규칙 설정
  - [ ] `staging`: required reviewer ≥ 1
  - [ ] `prod`: required reviewer ≥ 2 + wait timer(권장)
  - [ ] deployment branch restriction: `main`
- [ ] 시크릿 구성
  - [ ] OIDC 방식: `AWS_ROLE_TO_ASSUME` **또는**
  - [ ] static 방식: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
  - [ ] (선택) `AWS_SESSION_TOKEN`
- [ ] (선택) 변수 `TERRAFORM_AWS_REGION` 설정 (미설정 시 tfvars 값 사용)

### 실행 순서

1. (권장) dry-run rehearsal로 변경 영향 재확인
2. GitHub Actions → **Terraform Manual Apply** 실행
3. 입력값 설정
   - `environment`: `staging` (최초 권장)
   - `allow_create`: `true` (실 생성이 필요할 때만)
   - `execute_apply`: `true`
   - `confirm`: `APPLY_TERRAFORM_STAGING` (env에 맞춰 변경)
   - `confirm_environment`: `staging`
   - `production_confirm`: prod apply일 때만 `PROD_APPLY_ACK`
4. Environment approval(리뷰어 승인) 통과 후 실행
5. 아티팩트 확인
   - `status-summary.md`
   - `status.json`
   - `logs/terraform-plan.log`
   - `logs/terraform-apply.log`

### 권장 단계별 롤아웃

1) `dev` plan-only (`execute_apply=false`)
2) `staging` plan-only
3) `staging` apply
4) `prod` plan-only
5) `prod` apply (이중 확인 + 승인)

---

## 4) Stop / Go 기준

### GO

- `preflight_validate`: success
- `terraform_plan`: success
- (apply 요청 시) `terraform_apply`: success
- plan/apply 결과가 변경 승인 범위 내

### STOP

- preflight/plan/apply 중 하나라도 failed
- 의도하지 않은 파괴적 변경(destroy/replace) 감지
- credential/secret/approval guard 실패

---

## 5) 실패 시 대응

### preflight/plan 실패

1. 즉시 STOP 선언
2. `status-summary.md` + 핵심 로그 공유
3. tfvars/권한/구성 수정 후 재실행

### apply 실패

1. 추가 apply 금지
2. 동일 아티팩트 기반 원인 분석
3. 필요 시 `terraform plan` 재실행으로 drift 확인
4. 승인된 복구 절차에 따라 후속 작업(롤백/재적용) 수행

---

## 6) 제출 패키지 (핸드오프 최소 단위)

- `status-summary.md`
- `status.json`
- `commands.log`
- 대응 코멘트(티켓/PR 코멘트 3~5줄)

---

## 7) 아직 외부에서 준비해야 하는 것

- 실제 AWS 계정/조직 정책/비용 승인
- Terraform 실행 IAM 권한 및 신뢰 정책
- Remote backend(S3 + DynamoDB lock) 실제 리소스 준비
- GitHub Environment reviewer/approval 운영체계 확정

위 항목은 코드로 대체할 수 없는 운영 선행조건이다.
