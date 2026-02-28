# AWS Provider 설정
# 구현 예정 - 현재 placeholder

terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # 향후 구현: S3 backend + DynamoDB locking
  # backend "s3" {
  #   bucket         = "devsecops-terraform-state"
  #   key            = "prod/terraform.tfstate"
  #   region         = "ap-northeast-2"
  #   encrypt        = true
  #   dynamodb_table = "devsecops-terraform-lock"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Environment = var.environment
      Project     = var.project_name
      ManagedBy   = "Terraform"
      CreatedDate = timestamp()
    }
  }
}

# ============================================================================
# 향후 구현할 리소스 목록 (Placeholder)
# ============================================================================
#
# 1. VPC 모듈 (infra/terraform/modules/vpc/)
#    - VPC 생성 (CIDR: 10.0.0.0/16)
#    - Public Subnets (2개, AZ별)
#    - Private Subnets (2개, AZ별)
#    - NAT Gateway (public subnet에)
#    - Internet Gateway
#    - Route Tables
#
# 2. RDS 모듈 (infra/terraform/modules/rds/)
#    - RDS PostgreSQL 15 인스턴스
#    - DB Subnet Group (private subnet)
#    - DB Security Group
#    - Parameter Group (멀티테넌시 설정)
#    - Automated Backups (7일)
#    - Enhanced Monitoring (CloudWatch)
#
# 3. ECS 모듈 (infra/terraform/modules/ecs/)
#    - ECS Cluster (Fargate)
#    - Task Definitions (API, Web)
#    - ECS Services (API, Web)
#    - Application Load Balancer (ALB)
#    - Target Groups
#    - Auto Scaling (Target Tracking)
#    - CloudWatch Log Groups
#
# 4. S3 모듈 (infra/terraform/modules/s3/)
#    - S3 Bucket (artifacts)
#    - S3 Bucket (logs)
#    - Bucket Versioning
#    - Server-Side Encryption
#    - Lifecycle Policies
#
# 5. Secrets Manager
#    - RDS Master Password
#    - Database Connection String
#    - API Keys (Google OAuth, JWT 등)
#    - Environment-specific Secrets
#
# 6. CloudWatch + Monitoring
#    - Log Groups (ECS, RDS)
#    - Metrics (Custom metrics)
#    - Alarms (Error rate, Latency, DB connections)
#    - Dashboard
#
# 7. IAM Roles & Policies
#    - ECS Task Execution Role
#    - ECS Task Role (S3, Secrets Manager 접근)
#    - RDS Enhanced Monitoring Role
#

# ============================================================================
# 현재 Placeholder 선언
# ============================================================================
# 모듈 호출 예시 (향후 구현):
#
# module "vpc" {
#   source = "./modules/vpc"
#
#   project_name = var.project_name
#   environment  = var.environment
#   vpc_cidr     = var.vpc_cidr
#   # ... 기타 변수
# }
#
# module "rds" {
#   source = "./modules/rds"
#
#   project_name         = var.project_name
#   environment          = var.environment
#   instance_class       = var.db_instance_class
#   allocated_storage    = var.db_allocated_storage
#   vpc_id               = module.vpc.vpc_id
#   private_subnet_ids   = module.vpc.private_subnet_ids
#   # ... 기타 변수
# }
#
# module "ecs" {
#   source = "./modules/ecs"
#
#   project_name       = var.project_name
#   environment        = var.environment
#   vpc_id             = module.vpc.vpc_id
#   public_subnet_ids  = module.vpc.public_subnet_ids
#   private_subnet_ids = module.vpc.private_subnet_ids
#   # ... 기타 변수
# }
#
