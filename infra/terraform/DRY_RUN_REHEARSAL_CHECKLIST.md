# Terraform Dry-Run Rehearsal Checklist (Ops MVP Phase P)

첫 실전 `plan/apply` 리허설 전에 사용하는 실행 체크리스트.

## 0) 역할(Who)

| 역할 | 담당 | 책임 |
|---|---|---|
| Rehearsal Lead | `<이름>` | 전체 진행, go/no-go 판단 |
| Terraform Operator | `<이름>` | 스크립트 실행, 로그 기록 |
| Reviewer (2nd pair) | `<이름>` | plan diff/안전 가드 검토 |
| App Verifier | `<이름>` | 서비스 헬스/기능 smoke 확인 |
| DB Verifier | `<이름>` | RDS/연결/지표 확인 |

> 최소 2인(Operator + Reviewer) 이상 참여.

## 1) 일정(When)

- [ ] 리허설 일시(KST): `<YYYY-MM-DD HH:MM~HH:MM>`
- [ ] 변경 동결/조용한 시간대 확인
- [ ] 커뮤니케이션 채널 고정: `<Slack/Telegram>`
- [ ] 중단 기준(Abort Criteria) 공유 완료

## 2) 사전 준비 (T-1 day ~ T-30 min)

- [ ] `infra/terraform/environments/<env>.tfvars` 최신화
- [ ] `infra/terraform/environments/templates/<env>.values.tfvars.template` 운영 노트 작성
- [ ] 시크릿은 Secrets Manager/CI Secret에만 존재함을 확인 (repo 저장 금지)
- [ ] AWS 권한(읽기/plan/apply 대상 계정) 확인
- [ ] 최근 main 기준 동기화 (`git pull --ff-only`)

## 3) 실행 전 자동 검증 (T-15 min)

```bash
# 환경별 준비 상태 검증
bash infra/scripts/terraform-preflight-validate.sh <dev|staging|prod>

# 전체 환경 검증(선택)
bash infra/scripts/terraform-preflight-validate.sh all
```

- [ ] preflight 실패 0건
- [ ] 실패 시 값/템플릿 보완 후 재실행

## 4) Dry-run 실행 절차

### Step A. Safe plan (생성 없음)

```bash
bash infra/scripts/terraform-plan.sh <env>
```

- [ ] `allow_resource_creation=false` 확인
- [ ] 예상과 다른 destroy/replace 없음

### Step B. Create plan rehearsal (필요 시)

```bash
bash infra/scripts/terraform-plan.sh <env> --allow-create
```

- [ ] 생성/변경 리소스가 승인 범위 내인지 검토
- [ ] Reviewer 승인(문서/코멘트) 확보

### Step C. Apply rehearsal (선택, 승인 후)

```bash
# prod는 반드시 --allow-prod 필요
bash infra/scripts/terraform-apply.sh <env> [--allow-create]
```

- [ ] apply 확인 프롬프트를 이중 확인
- [ ] 실행 로그를 채널/티켓에 기록

## 5) 검증 포인트(Verification Points)

- [ ] Terraform output 정상 생성/조회
- [ ] VPC/Subnet/Security Group 기본 상태 정상
- [ ] RDS 상태(`available`), 백업/삭제보호 정책 기대값 일치
- [ ] ECS Cluster/ALB/CloudWatch log group 기대값 일치
- [ ] S3 bucket(versioning/lifecycle) 기대값 일치
- [ ] 애플리케이션 smoke 체크(health endpoint)

## 6) 롤백 계획(Rollback)

- [ ] 롤백 책임자: `<이름>`
- [ ] 롤백 트리거 조건 명시 (예: 예상 외 변경, 헬스체크 실패, 에러율 급증)
- [ ] 롤백 방법 합의:
  - [ ] 직전 안정 plan/apply로 되돌리기
  - [ ] 필요 시 수동 리소스 정리(runbook 링크)
  - [ ] 서비스 라우팅/태스크 이전 버전 전환
- [ ] 롤백 ETA 공유 (`<예: 10~15분>`)

## 7) 종료 및 기록

- [ ] 결과: `PASS` / `FAIL` / `ABORT`
- [ ] 이슈/리스크/추가 액션 문서화
- [ ] 다음 rehearsal 또는 실제 apply 일정 확정
- [ ] 변경사항을 `docs/workflow/DEPLOYMENT.md` 또는 티켓에 반영
