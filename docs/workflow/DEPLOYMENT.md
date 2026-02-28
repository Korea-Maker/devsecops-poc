# 배포 파이프라인 (Deployment Pipeline)

## 개요

DevSecOps PoC의 배포 전략 및 파이프라인 설계. 현재 상태는 초안이며, 실제 구현은 Phase 5 이후 진행됩니다.

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
6. **Notification**: Slack/이메일 알림

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

## CI/CD 워크플로우 (향후 구현)

### 현재 상태

- `ci.yml`: 기본 lint, test (구현됨)
- `security-scan.yml`: Semgrep, Trivy, Gitleaks (구현됨)

### 향후 구현 (Phase 5)

#### `.github/workflows/deploy-staging.yml`

```yaml
name: Deploy to Staging

on:
  push:
    branches:
      - main

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build and push to ECR
        run: |
          docker build -t devsecops-api:staging-latest apps/api/
          docker build -t devsecops-web:staging-latest apps/web/
          # ECR push (aws cli)

      - name: Deploy to ECS
        run: |
          aws ecs update-service --cluster staging --service api

      - name: Smoke Test
        run: |
          curl -f http://staging-api.example.com/health

      - name: Notify Slack
        if: always()
```

#### `.github/workflows/deploy-production.yml`

```yaml
name: Deploy to Production

on:
  push:
    tags:
      - 'v*'

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4

      - name: Pre-deployment Checks
        run: |
          # DB migration validation
          # Secrets validation
          # Security scan

      - name: Blue/Green Deployment
        run: |
          # Create new Task Definition (green)
          # Route 10% traffic (canary)
          # Monitor metrics
          # Full traffic switch on success

      - name: Notify on Slack
```

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
