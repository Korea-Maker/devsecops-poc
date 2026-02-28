# 운영 인프라 (Infrastructure)

## 개요

DevSecOps PoC의 운영 환경 인프라 정의 및 배포 자동화.

- **클라우드 대상**: AWS (우선), GCP/Azure (차선)
- **IaC 도구**: Terraform (구현 예정)
- **컨테이너**: Docker, Docker Compose (개발/staging)
- **오케스트레이션**: ECS/EKS (프로덕션, 향후 구현)
- **환경 분리**: development, staging, production

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
├── main.tf              # AWS provider + 리소스 정의
├── variables.tf         # 입력 변수 (environment, region 등)
├── outputs.tf           # 출력값 (ALB DNS, RDS endpoint 등)
├── terraform.tfvars     # 변수값 파일 (실제 값은 .gitignore)
├── modules/
│   ├── vpc/             # VPC 모듈
│   ├── rds/             # RDS 모듈
│   ├── ecs/             # ECS 모듈
│   └── s3/              # S3 모듈
└── environments/
    ├── dev.tfvars       # 개발 환경 변수
    ├── staging.tfvars   # staging 환경 변수
    └── prod.tfvars      # 프로덕션 환경 변수
```

### 향후 구현 (Placeholder)

현재 `main.tf`와 `variables.tf`는 골격만 정의되어 있으며, 실제 리소스 구현은 Phase 5 이후 진행됩니다.

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
- [`infra/docker/`](./docker/): Docker Compose 정의
- [`docs/workflow/DEPLOYMENT.md`](../docs/workflow/DEPLOYMENT.md): 배포 파이프라인
