# 운영 인프라 (Infrastructure)

## 개요

DevSecOps PoC의 운영 환경 인프라 정의 및 배포 자동화.

- **클라우드 대상**: AWS (우선), GCP/Azure (차선)
- **IaC 도구**: Terraform (safe-by-default skeleton 적용)
- **컨테이너**: Docker, Docker Compose (개발/staging)
- **오케스트레이션**: ECS/EKS (프로덕션, 향후 구현)
- **환경 분리**: dev, staging, prod

---

## 아키텍처 개요

### 고수준 구조

```
┌─────────────────────────────────────────────────────────────┐
│                      Client / Browser                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
         ┌─────────────────┴──────────────────┐
         │                                    │
    ┌────▼────┐                        ┌─────▼─────┐
    │CloudFront│  (CDN)                │   ALB     │
    └────┬────┘                        └─────┬─────┘
         │                                    │
    ┌────▼──────────────┐          ┌──────────▼──────────┐
    │ S3 / Vercel       │          │ ECS / Kubernetes    │
    │ (Next.js static)  │          │ (Fastify API)       │
    └───────────────────┘          └──────────┬──────────┘
                                              │
                                    ┌─────────▼──────────┐
                                    │  RDS PostgreSQL    │
                                    │  (멀티테넌시 격리)   │
                                    └────────────────────┘
```

### 컴포넌트

| 컴포넌트 | 목적 | 상태 |
|---------|------|------|
| **CloudFront / ALB** | 로드 밸런싱 + 캐싱 | 향후 구현 |
| **ECS/EKS** | 컨테이너 오케스트레이션 (API) | 향후 구현 |
| **RDS PostgreSQL** | 데이터베이스 | 향후 구현 |
| **S3 + Vercel** | 정적 호스팅 (Web) | 향후 구현 |
| **Docker Compose** | 로컬/staging 개발 환경 | 준비 완료 |

---

## 필요 리소스 목록

### 컴퓨트

- **ECS Cluster**: Fargate 기반 컨테이너 실행
  - Task definition (API): `devsecops-api:latest`
  - Task definition (Web): `devsecops-web:latest`
  - Auto Scaling Group (원하는 작업 수: 2-5)

- **EC2 (선택)**: 자체 관리형 ECS 클러스터 (비용 최적화 시)

### 데이터베이스

- **RDS PostgreSQL 15**
  - Instance class: `db.t3.micro` (개발/staging), `db.t3.small` (production)
  - Multi-AZ: production만 활성화
  - 자동 백업: 7일 보존
  - 성능 인사이트: 기본 비활성화

### 네트워크

- **VPC**: 기본 VPC 또는 새로운 VPC
  - Subnets: 최소 2개 (public, private)
  - NAT Gateway: outbound 트래픽용
  - Security Groups:
    - ALB → ECS (80/443)
    - ECS → RDS (5432)
    - RDS (내부만, 외부 접근 불가)

### 저장소

- **S3 Buckets**:
  - `devsecops-artifacts` (빌드 아티팩트)
  - `devsecops-logs` (CloudWatch Logs)

### 시크릿 관리

- **AWS Secrets Manager**:
  - Database password
  - API keys (Google OAuth 등)
  - JWT signing key
  - Environment-specific secrets

### 모니터링 및 로깅

- **CloudWatch**:
  - Logs: ECS, RDS, Lambda
  - Metrics: CPU, Memory, Network I/O
  - Alarms: 에러율, 지연시간, DB 연결

- **SNS / Slack**: 알림 채널 (선택)

---

## 환경 분리

### Development (개발자 로컬)

- **Docker Compose**: `infra/docker/docker-compose.yml`
- API: `http://localhost:3001`
- Web: `http://localhost:3000`
- Database: 로컬 PostgreSQL (Docker 컨테이너)
- 데이터: 서버 재시작 시 초기화

### Staging (테스트 환경)

- **AWS ECS Cluster** (선택 시, 또는 로컬 Docker Compose)
- **docker-compose.staging.yml**: CI/CD에서 자동 배포
- RDS PostgreSQL (dev 인스턴스)
- 환경변수: `.env.staging` 참조
- 데이터: 지속성 유지

### Production (실제 운영)

- **AWS ECS Cluster** (Multi-AZ)
- RDS PostgreSQL (db.t3.small, Multi-AZ)
- CloudFront + ALB + WAF
- 자동 백업, 장애 조치 활성화
- 모니터링 및 알림 필수
- 환경변수: AWS Secrets Manager에서 주입

---

## IaC 전략

### Terraform 디렉터리 구조

```
infra/terraform/
├── main.tf                       # provider + module wiring + safety checks
├── variables.tf                  # 입력 변수 + validation
├── outputs.tf                    # 모듈 출력값
├── README.md                     # Terraform 실행 가이드
├── DRY_RUN_REHEARSAL_CHECKLIST.md
├── modules/
│   ├── vpc/                      # VPC/Subnet/RT/NAT skeleton
│   ├── rds/                      # PostgreSQL RDS skeleton
│   ├── ecs/                      # ECS Cluster/ALB skeleton
│   └── s3/                       # Artifacts/Logs bucket skeleton
├── environments/
│   ├── dev.tfvars                # dev 환경 변수
│   ├── staging.tfvars            # staging 환경 변수
│   ├── prod.tfvars               # prod 환경 변수
│   └── templates/                # 값 준비 템플릿 + 운영 노트
└── plans/                        # 로컬 plan 출력 경로 (git ignore)
```

### 현재 구현 범위 (Ops MVP Phase O + T)

- `vpc/rds/ecs/s3` 모듈 최소 리소스 skeleton 추가
- 모든 모듈은 `enabled=false` 기본값(비활성)
- 루트에서 `allow_resource_creation=false` 기본값(전역 생성 금지)
- `check` 블록 기반 선행조건 검증(모듈 의존성/스토리지 범위/스냅샷 설정)
- tfvars 샘플(dev/staging/prod) + 환경 템플릿(dev/staging/prod) 추가
- preflight validator(`infra/scripts/terraform-preflight-validate.sh`) 추가
- rehearsal artifact generator(`infra/scripts/terraform-rehearsal-artifacts.sh`) + 운영자 handoff 문서 추가
- apply pipeline wrapper(`infra/scripts/terraform-apply-pipeline.sh`) 추가
  - 기존 스크립트(`preflight`, `plan`, `apply`)를 조합해 `preflight -> plan -> optional apply` 수행
  - 단계별 로그/상태 요약 아티팩트 생성(`infra/apply-artifacts/...`)
- 수동 apply 워크플로우(`.github/workflows/terraform-manual-apply.yml`) 추가
  - `workflow_dispatch` only (push/PR 자동 apply 없음)
  - branch restriction(`main`), 환경 선택, 명시적 confirm, prod double confirm
  - credentials/secrets 미구성 시 명확한 사유로 즉시 중단

### Terraform 실행 플로우 (정확한 절차)

```bash
# 0) Terraform 구조 검증 (포맷+validate)
terraform -chdir=infra/terraform fmt -recursive
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate

# 1) dry-run rehearsal 아티팩트 번들 생성 (운영자 핸드오프용)
bash infra/scripts/terraform-rehearsal-artifacts.sh staging

# 2) 값/템플릿 preflight
bash infra/scripts/terraform-preflight-validate.sh staging

# 3) 안전 모드 plan (기본: 리소스 생성 없음)
bash infra/scripts/terraform-plan.sh staging

# 4) 운영자/CI 래퍼(plan-only)
bash infra/scripts/terraform-apply-pipeline.sh staging --allow-create

# 5) 생성 포함 apply (명시적 --apply)
bash infra/scripts/terraform-apply-pipeline.sh staging --allow-create --apply

# 6) prod apply (추가 보호장치)
bash infra/scripts/terraform-apply-pipeline.sh prod --allow-create --apply --allow-prod
```

GitHub에서 첫 실 프로비저닝을 수행할 때는 아래 순서를 권장:

1. `Terraform Manual Apply` 워크플로우를 `staging` + plan-only로 먼저 실행
2. 결과 아티팩트(`status-summary.md`, `status.json`, `logs/*`) 검토
3. `staging` apply 실행
4. 동일 절차를 `prod` plan-only → `prod` apply 순으로 진행

> 자동 경로(push/PR)에서는 apply를 절대 실행하지 않고, PR에서는 fmt/validate/plan(안전 모드)만 수행한다.

### GitHub 환경 보호/시크릿 체크리스트

- Environments: `dev`, `staging`, `prod`
- 보호 규칙:
  - `staging` required reviewer >= 1
  - `prod` required reviewer >= 2 (+ wait timer 권장)
  - deployment branch: `main`
- Terraform apply 인증 시크릿(택1):
  - `AWS_ROLE_TO_ASSUME`(OIDC)
  - 또는 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
- 선택: `AWS_SESSION_TOKEN`, `TERRAFORM_AWS_REGION`

### 아직 외부에서 필요한 선행조건

- 실제 AWS 계정/결제/조직 정책 준비
- Terraform 실행 IAM 권한 및 신뢰 정책 구성
- remote backend(S3 + DynamoDB lock) 실계정 리소스 준비
- GitHub 환경 승인 정책(리뷰어/승인 절차) 운영 확정


---

## 보안 고려사항

- **VPC 격리**: 퍼블릭 서브넷(ALB), 프라이빗 서브넷(ECS, RDS)
- **시크릿 관리**: AWS Secrets Manager 사용, git에 커밋하지 않음
- **IAM 역할**: ECS Task Role, 최소 권한 원칙
- **네트워크 ACL**: 불필요한 포트 차단
- **WAF (Web Application Firewall)**: production에서 활성화 예정
- **암호화**: RDS 암호화 (기본 활성화), S3 서버 측 암호화

---

## 배포 파이프라인

자세한 내용은 [`docs/workflow/DEPLOYMENT.md`](../docs/workflow/DEPLOYMENT.md) 참고.

- GitHub Actions → Docker Build → ECR Push → ECS Deploy
- 환경별 배포 체크리스트
- 롤백 전략
- 모니터링 및 알림

---

## 로컬 개발 시작

### 전제 조건

- Docker 설치
- Docker Compose 설치
- pnpm 설치

### 실행

```bash
# 1. 로컬 환경 파일 생성 (선택)
cp infra/docker/.env.staging.example infra/docker/.env.staging

# 2. Docker Compose 시작
cd infra/docker
docker-compose -f docker-compose.staging.yml up -d

# 3. 데이터베이스 마이그레이션
pnpm --filter @devsecops/api migrate

# 4. 애플리케이션 시작
pnpm install
pnpm --filter @devsecops/api dev
pnpm --filter @devsecops/web dev
```

API: http://localhost:3001
Web: http://localhost:3000
Database: postgres://localhost:5432/devsecops

---

## 참고 문서

- [`infra/terraform/`](./terraform/): Terraform 코드
- [`infra/terraform/OPERATOR_HANDOFF.md`](./terraform/OPERATOR_HANDOFF.md): dry-run 리허설 운영자 핸드오프
- [`infra/docker/`](./docker/): Docker Compose 정의
- [`docs/workflow/DEPLOYMENT.md`](../docs/workflow/DEPLOYMENT.md): 배포 파이프라인
