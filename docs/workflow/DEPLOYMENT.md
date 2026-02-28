# 배포 파이프라인 (Deployment Pipeline)

## 개요

DevSecOps PoC의 배포 전략 및 파이프라인 설계. GitHub Actions 기반 staging/production 배포 워크플로우의 최소 실행형(verify/preflight/deploy/smoke + staging optional RLS canary)은 반영되었고, Terraform IaC는 safe-by-default skeleton(vpc/rds/ecs/s3 + tfvars + guard script + PR plan workflow)까지 적용된 상태다.

---

## 배포 흐름

### 개발 → Staging → Production

```
┌──────────────┐
│ 개발자 커밋  │
│ (main 브랜치)│
└──────┬───────┘
       │
       ▼
┌──────────────────┐
│ GitHub Actions   │ ← CI/CD 파이프라인 시작
│ (lint, test)     │
└──────┬───────────┘
       │
       ├─ 실패 시: 빌드 중단
       │
       ▼
┌──────────────────┐
│ Docker Build     │ ← 이미지 빌드
│ (API + Web)      │   - Dockerfile 기반
└──────┬───────────┘   - 캐시 레이어 활용
       │
       ▼
┌──────────────────┐
│ ECR Push         │ ← 이미지 레지스트리
│ (amazon-ecr)     │   - devsecops-api:latest
└──────┬───────────┘   - devsecops-web:latest
       │
       ├─ Staging 배포 (자동)
       │  └─ ECS Task 업데이트
       │  └─ Blue/Green 배포
       │
       └─ Production 배포 (수동 승인)
          └─ ECS Task 업데이트
          └─ Canary 롤아웃 (선택)
```

---

## 환경별 배포 구성

### 1. Development (개발자 로컬)

**도구**: Docker Compose

**배포 방식**:
```bash
cd infra/docker
docker-compose up -d
```

**특징**:
- 로컬 환경에서 실행
- 데이터: 서버 재시작 시 초기화
- 빠른 반복 개발
- 무중단 배포 불필요

**환경 파일**: `.env.development` (로컬)

---

### 2. Staging (테스트/통합 환경)

**도구**: GitHub Actions + Docker Compose 또는 ECS (선택)

**배포 프로세스**:

1. **Trigger**: `main` 브랜치에 push
2. **Build**: Docker 이미지 빌드 (`.github/workflows/deploy-staging.yml`)
3. **Push**: ECR에 이미지 푸시 (태그: `staging-latest`, `staging-{commit-sha}`)
4. **Deploy**: ECS Service 업데이트 또는 Docker Compose 배포
5. **Smoke Test**: 기본 헬스 체크 실행
6. **RLS Canary (선택)**: read-only tenant 격리 probe 실행 (`infra/scripts/verify-rls-canary.sh`)
   - `STAGING_RLS_CANARY_ENABLED=true` + 필수 env/secrets 완비 시 실패를 배포 실패로 처리
   - 미활성화/구성 누락 시 Step Summary 사유 기록 후 skip
7. **Notification**: Slack/이메일 알림

**환경 파일**: `.env.staging` (시크릿)

**배포 시간**: ~5-10분

**롤백**: 이전 Task Definition으로 즉시 전환 가능

---

### 3. Production (실제 운영)

**도구**: GitHub Actions + AWS ECS + ALB + CloudFront

**배포 프로세스**:

1. **Trigger**: 수동 승인 또는 Git tag (`v*` 패턴)
2. **Build**: Docker 이미지 빌드 (staging과 동일)
3. **Push**: ECR에 이미지 푸시 (태그: `prod-latest`, `v{version}`)
4. **Pre-deployment Checks**:
   - 데이터베이스 마이그레이션 검증
   - 시크릿 확인 (AWS Secrets Manager)
   - 보안 스캔 (Trivy, Semgrep)
5. **Blue/Green 배포**:
   - 신규 Task Definition 생성 (green)
   - 신규 Task 10%에 트래픽 라우팅 (canary)
   - 헬스 체크 성공 시 100% 전환
   - 실패 시 즉시 이전 Task(blue)로 롤백
6. **Post-deployment**:
   - 모니터링 메트릭 확인 (에러율, 지연시간)
   - Slack/이메일 배포 완료 알림
   - CloudWatch Dashboard 확인

**환경 파일**: AWS Secrets Manager 관리

**배포 시간**: ~15-20분 (Blue/Green 포함)

**SLA**: 99.9% 가용성 목표

---

## 배포 체크리스트

### Pre-deployment

- [ ] 모든 테스트 통과
- [ ] Code review 완료
- [ ] 보안 스캔 완료 (SAST, SCA)
- [ ] 데이터베이스 마이그레이션 검증
- [ ] 환경 변수 확인 (AWS Secrets Manager)
- [ ] 변경사항 문서화

### Deployment

- [ ] Staging에 먼저 배포하고 smoke test 통과
- [ ] 배포 로그 확인
- [ ] 헬스 체크 성공
- [ ] 기본 기능 테스트 (로그인, 스캔 생성 등)
- [ ] Performance 영향도 확인

### Post-deployment

- [ ] CloudWatch 메트릭 모니터링 (최소 30분)
- [ ] 에러 로그 확인
- [ ] 사용자 피드백 수집
- [ ] 배포 노트 작성

### Rollback (필요 시)

- [ ] 이전 Task Definition으로 즉시 전환
- [ ] 데이터 무결성 확인
- [ ] 원인 분석 및 문서화
- [ ] Hot fix 계획

---

## 롤백 전략

### 자동 롤백

ECS에서 배포 실패 시:
- Task 시작 실패 (health check 계속 실패)
- CPU/Memory 급증 (OOM)
- 에러율 급증 (CloudWatch Alarm)

**Action**: 이전 Task Definition으로 자동 전환

### 수동 롤백

Production 중단 및 긴급 롤백 필요 시:

```bash
# 1. ECS Service 업데이트 (이전 Task Definition)
aws ecs update-service \
  --cluster devsecops-prod \
  --service devsecops-api \
  --task-definition devsecops-api:42

# 2. 배포 상태 확인
aws ecs describe-services \
  --cluster devsecops-prod \
  --services devsecops-api

# 3. 롤백 완료 시간: ~5분
```

---

## CI/CD 워크플로우 (현재 구현)

### 구현됨

- `ci.yml`: push/PR 린트/타입체크/테스트/빌드
- `security-scan.yml`: PR 보안 스캔(Semgrep/Trivy/Gitleaks)
- `deploy-staging.yml`:
  - 트리거: `main` push + 수동 실행
  - verify 게이트: API test/typecheck/build + Web typecheck/build
  - preflight: 필수 secret/variable 누락 시 실패 대신 skip (Step Summary 사유 기록)
  - deploy: staging deploy webhook 호출
  - post-deploy: `infra/scripts/post-deploy-smoke-check.sh` 실행
  - post-smoke(optional): `infra/scripts/verify-rls-canary.sh` 실행 (enabled+config complete일 때만 enforce)
- `deploy-production.yml`:
  - 트리거: `v*` tag push + 수동 실행(`confirm=DEPLOY_PROD`)
  - staging과 동일한 verify/preflight/deploy/smoke 계약
- `terraform-pr-checks.yml`:
  - 트리거: PR (`infra/terraform/**`, `infra/scripts/terraform-*.sh`, workflow 파일 변경)
  - `terraform fmt -check` + `validate` 수행
  - `plan`은 `allow_resource_creation=false` 안전 모드로만 실행
  - terraform binary/AWS creds 누락 시 실패 대신 skip + Step Summary 기록

### 배포 계약 (GitHub repository level)

- Staging
  - required secrets: `STAGING_DEPLOY_WEBHOOK_URL`, `STAGING_DEPLOY_WEBHOOK_TOKEN`
  - required variables: `STAGING_SMOKE_API_HEALTH_URL`, `STAGING_SMOKE_WEB_HEALTH_URL`
  - optional canary secrets: `STAGING_RLS_CANARY_ALLOWED_HEADERS`, `STAGING_RLS_CANARY_DENIED_HEADERS`
  - optional canary variables: `STAGING_RLS_CANARY_ENABLED`, `STAGING_RLS_CANARY_API_BASE_URL`, `STAGING_RLS_CANARY_PROBE_PATH`, `STAGING_RLS_CANARY_EXPECT_ALLOWED_STATUS`, `STAGING_RLS_CANARY_EXPECT_DENIED_STATUSES`
- Production
  - secrets: `PRODUCTION_DEPLOY_WEBHOOK_URL`, `PRODUCTION_DEPLOY_WEBHOOK_TOKEN`
  - variables: `PRODUCTION_SMOKE_API_HEALTH_URL`, `PRODUCTION_SMOKE_WEB_HEALTH_URL`

- Smoke 스크립트 계약: `infra/scripts/post-deploy-smoke-check.sh`
  - required: `SMOKE_API_HEALTH_URL`, `SMOKE_WEB_HEALTH_URL`
  - optional: `SMOKE_TIMEOUT_SECONDS`, `SMOKE_RETRY_COUNT`, `SMOKE_RETRY_DELAY_SECONDS`
- RLS canary 스크립트 계약: `infra/scripts/verify-rls-canary.sh` (read-only GET probe)
  - enable gate: `RLS_CANARY_ENABLED=true`
  - required(enabled일 때): `RLS_CANARY_API_BASE_URL`, `RLS_CANARY_PROBE_PATH`, `RLS_CANARY_ALLOWED_HEADERS`, `RLS_CANARY_DENIED_HEADERS`
  - probe 권장값: tenant A 전용 read-only GET 경로 (예: `/api/v1/scans/<tenant-a-scan-id>`)
  - header 포맷: `Header: value|Header-2: value` (`Authorization: Bearer ...` 포함 가능)
  - optional: `RLS_CANARY_EXPECT_ALLOWED_STATUS`(기본 `200`), `RLS_CANARY_EXPECT_DENIED_STATUSES`(기본 `401,403,404`), `RLS_CANARY_TIMEOUT_SECONDS`
- Terraform 스크립트 계약
  - `infra/scripts/terraform-preflight-validate.sh <env|all>`: tfvars + template 완전성 검증
  - `infra/scripts/terraform-plan.sh <env>`: `dev|staging|prod` 환경 인자 필수 (preflight 자동 실행)
  - `infra/scripts/terraform-plan.sh <env> --allow-create`: 명시적으로 create plan 허용
  - `infra/scripts/terraform-apply.sh <env>`: preflight + apply 전 대화형 확인
  - `infra/scripts/terraform-apply.sh prod ...`: `--allow-prod` 없으면 즉시 거부
  - 리허설 런북: `infra/terraform/DRY_RUN_REHEARSAL_CHECKLIST.md`


### Terraform IaC 실행 절차 (safe-by-default)

```bash
# 1) 포맷/검증
terraform -chdir=infra/terraform fmt -recursive
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate

# 2) 값/템플릿 preflight
bash infra/scripts/terraform-preflight-validate.sh staging

# 3) 안전 모드 plan (기본)
bash infra/scripts/terraform-plan.sh staging

# 4) 생성 포함 plan/apply (명시적으로만)
bash infra/scripts/terraform-plan.sh staging --allow-create
bash infra/scripts/terraform-apply.sh staging --allow-create

# 5) production apply (추가 플래그 + 확인 문자열)
bash infra/scripts/terraform-apply.sh prod --allow-prod --allow-create
```

> CI에서는 apply를 실행하지 않고, PR에서 fmt/validate/plan(안전 모드)만 수행한다.

### 운영/실서비스 MVP complete 판정 조건 (현재)

- verify/preflight/deploy/smoke 파이프라인이 staging/prod에서 모두 동작
- staging은 smoke 이후 optional RLS canary를 실행하고, 활성화+구성 완비 시 tenant 격리 mismatch를 실패로 처리
- canary 비활성화/구성 누락은 명시적 skip(exit 0) + Step Summary 사유 기록으로 CI 탄력성 유지

### 후속 고도화

- deploy webhook 단계를 ECS/ECR/GitOps 실배포 단계로 교체
- DB migration 검증/승인 단계 추가
- Canary/Blue-Green 자동화 및 알림 연계

---

## 환경 변수 관리

### Development

**.env.development** (로컬, git ignored):
```
DATABASE_URL=postgresql://admin:postgres@localhost:5432/devsecops
LOG_LEVEL=debug
JWT_SECRET=dev-secret-key
GOOGLE_OAUTH_ID=xxx
GOOGLE_OAUTH_SECRET=xxx
```

### Staging

**AWS Secrets Manager** 또는 **.env.staging** (파일은 git ignored):
```
DATABASE_URL=postgresql://...@staging-rds.amazonaws.com:5432/devsecops
LOG_LEVEL=info
JWT_SECRET=staging-secret-key
GOOGLE_OAUTH_ID=xxx
GOOGLE_OAUTH_SECRET=xxx
```

### Production

**AWS Secrets Manager** (필수):
```
Database password
Database URL
JWT secret
API keys
SSL certificates (IAM)
```

---

## 모니터링 및 알림

### CloudWatch Metrics (ECS)

- **CPU Usage**: 목표 < 70%
- **Memory Usage**: 목표 < 80%
- **Task Count**: 목표 = desired count
- **Network In/Out**: 이상치 감지

### CloudWatch Alarms

- **High Error Rate**: errors/min > 10 → PagerDuty 알림
- **High Latency**: p99 > 1000ms → Slack 알림
- **Database Connection**: connection_count > 20 → 관리자 알림
- **Disk Space**: used% > 80% → 관리자 알림

### Slack Integration (향후 구현)

```yaml
Deployment Started
├─ Staging: Deploying v1.2.3...
├─ Deploy Complete
├─ Smoke Test: ✅ PASS
├─ Metrics: CPU 45%, Memory 60%
└─ Status: Ready for Production
```

---

## 성능 및 보안 최적화

### 배포 최적화

- **Docker 멀티스테이지 빌드**: 이미지 크기 감소
- **이미지 캐싱**: ECR 레이어 캐싱으로 빌드 시간 단축
- **Parallel Builds**: API + Web 동시 빌드
- **Blue/Green**: 무중단 배포

### 보안 최적화

- **Secret Rotation**: AWS Secrets Manager 자동 로테이션
- **WAF**: CloudFront 앞단에 AWS WAF 적용
- **VPC 격리**: 퍼블릭/프라이빗 서브넷 분리
- **IAM 최소 권한**: ECS Task Role은 필요한 권한만 허가
- **ECR 스캔**: 푸시 시 Trivy로 취약점 스캔
- **Signed Images**: 서명된 Docker 이미지만 배포 가능

---

## 트러블슈팅

### 배포 실패

| 증상 | 원인 | 해결방법 |
|------|------|---------|
| Task 시작 실패 | Health check 실패 | 로그 확인 → 애플리케이션 수정 |
| 메모리 부족 | 이미지 크기/메모리 설정 | Task memory 증가 또는 이미지 최적화 |
| 데이터베이스 연결 실패 | RDS 네트워크/보안그룹 | VPC/보안그룹 규칙 확인 |
| 시크릿 로드 실패 | IAM 권한 부족 | ECS Task Role 권한 확인 |

### 성능 저하

| 증상 | 원인 | 해결방법 |
|------|------|---------|
| 응답 지연 | DB 쿼리 느림 | 인덱스 추가/쿼리 최적화 |
| 높은 CPU | CPU 바운드 작업 | 코드 프로파일링 → 최적화 |
| 메모리 누수 | Node.js 메모리 누수 | 힙 덤프 분석 → 버그 수정 |

---

## 향후 개선사항

- [ ] GitOps (ArgoCD): Kubernetes 배포 자동화
- [ ] Canary 배포: 트래픽 기반 자동 롤아웃
- [ ] 자동 성능 테스트: 배포 전 성능 검증
- [ ] 자동 보안 패치: 의존성 업데이트 및 배포
- [ ] 분산 트레이싱: Jaeger/Datadog로 요청 추적
- [ ] 자동 스케일링: 시간대별/부하 기반 스케일링
- [ ] 멀티리전 배포: 고가용성 및 재해 복구

---

## 참고 문서

- [`infra/README.md`](../infra/README.md): 인프라 개요
- [`infra/docker/docker-compose.staging.yml`](../infra/docker/docker-compose.staging.yml): Staging 환경 설정
- [`infra/terraform/`](../infra/terraform/): Terraform IaC
- [`.github/workflows/`](../../.github/workflows/): GitHub Actions 워크플로우
