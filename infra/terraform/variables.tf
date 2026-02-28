# Terraform root input variables

variable "environment" {
  description = "배포 환경(dev, staging, prod)"
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment는 dev, staging, prod 중 하나여야 합니다."
  }
}

variable "aws_region" {
  description = "AWS 리전"
  type        = string
  default     = "ap-northeast-2"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.aws_region))
    error_message = "aws_region 형식이 올바르지 않습니다. 예: ap-northeast-2"
  }
}

variable "project_name" {
  description = "프로젝트 이름(prefix)"
  type        = string
  default     = "devsecops-poc"

  validation {
    condition     = can(regex("^[a-z0-9-]{3,30}$", var.project_name))
    error_message = "project_name은 3~30자, 소문자/숫자/하이픈만 허용됩니다."
  }
}

variable "allow_resource_creation" {
  description = "안전 스위치. true일 때만 실제 리소스 생성 시도"
  type        = bool
  default     = false
}

variable "enable_vpc" {
  description = "VPC 모듈 활성화"
  type        = bool
  default     = false
}

variable "enable_rds" {
  description = "RDS 모듈 활성화"
  type        = bool
  default     = false
}

variable "enable_ecs" {
  description = "ECS 모듈 활성화"
  type        = bool
  default     = false
}

variable "enable_s3" {
  description = "S3 모듈 활성화"
  type        = bool
  default     = false
}

# ─────────────────────────────────────────────────────────────────────────────
# VPC
# ─────────────────────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "VPC CIDR 블록"
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr는 유효한 CIDR 형식이어야 합니다."
  }
}

variable "availability_zones" {
  description = "서브넷 생성 대상 AZ 목록"
  type        = list(string)
  default     = ["ap-northeast-2a", "ap-northeast-2c"]

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "availability_zones는 최소 2개 이상이어야 합니다."
  }
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDR 목록(AZ 순서와 대응)"
  type        = list(string)
  default     = ["10.20.0.0/24", "10.20.1.0/24"]

  validation {
    condition     = alltrue([for cidr in var.public_subnet_cidrs : can(cidrhost(cidr, 0))])
    error_message = "public_subnet_cidrs의 모든 값은 유효한 CIDR이어야 합니다."
  }
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDR 목록(AZ 순서와 대응)"
  type        = list(string)
  default     = ["10.20.10.0/24", "10.20.11.0/24"]

  validation {
    condition     = alltrue([for cidr in var.private_subnet_cidrs : can(cidrhost(cidr, 0))])
    error_message = "private_subnet_cidrs의 모든 값은 유효한 CIDR이어야 합니다."
  }
}

variable "enable_nat_gateway" {
  description = "VPC 모듈에서 NAT Gateway 생성 여부"
  type        = bool
  default     = false
}

# ─────────────────────────────────────────────────────────────────────────────
# RDS
# ─────────────────────────────────────────────────────────────────────────────

variable "db_name" {
  description = "RDS 초기 DB 이름"
  type        = string
  default     = "devsecops"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.db_name))
    error_message = "db_name은 소문자/숫자/언더스코어만 허용되며 문자로 시작해야 합니다."
  }
}

variable "db_instance_class" {
  description = "RDS 인스턴스 클래스"
  type        = string
  default     = "db.t4g.micro"

  validation {
    condition     = can(regex("^db\\.[a-z0-9]+\\.[a-z0-9]+$", var.db_instance_class))
    error_message = "db_instance_class 형식이 올바르지 않습니다. 예: db.t4g.micro"
  }
}

variable "db_allocated_storage" {
  description = "RDS 기본 할당 스토리지(GB)"
  type        = number
  default     = 20

  validation {
    condition     = var.db_allocated_storage >= 20 && var.db_allocated_storage <= 65536
    error_message = "db_allocated_storage는 20~65536 범위여야 합니다."
  }
}

variable "db_max_allocated_storage" {
  description = "RDS autoscaling 최대 스토리지(GB)"
  type        = number
  default     = 100

  validation {
    condition     = var.db_max_allocated_storage >= 20 && var.db_max_allocated_storage <= 65536
    error_message = "db_max_allocated_storage는 20~65536 범위여야 합니다."
  }
}

variable "db_backup_retention_days" {
  description = "RDS 백업 보존일"
  type        = number
  default     = 7

  validation {
    condition     = var.db_backup_retention_days >= 0 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days는 0~35 범위여야 합니다."
  }
}

variable "db_multi_az" {
  description = "RDS Multi-AZ 활성화"
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "RDS 삭제 보호"
  type        = bool
  default     = false
}

variable "db_skip_final_snapshot" {
  description = "RDS 삭제 시 final snapshot 생략 여부"
  type        = bool
  default     = true
}

variable "db_final_snapshot_identifier" {
  description = "db_skip_final_snapshot=false일 때 사용할 final snapshot identifier"
  type        = string
  default     = ""

  validation {
    condition     = var.db_final_snapshot_identifier == "" || can(regex("^[a-z0-9-]{1,255}$", var.db_final_snapshot_identifier))
    error_message = "db_final_snapshot_identifier는 소문자/숫자/하이픈만 허용됩니다."
  }
}

variable "db_master_username" {
  description = "RDS 마스터 사용자명"
  type        = string
  default     = "app_admin"

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_]{0,15}$", var.db_master_username))
    error_message = "db_master_username은 영문자로 시작하는 1~16자 문자열이어야 합니다."
  }
}

variable "db_master_password" {
  description = "RDS 마스터 비밀번호(null이면 AWS managed password 사용)"
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = var.db_master_password == null || length(var.db_master_password) >= 8
    error_message = "db_master_password는 최소 8자 이상이어야 합니다."
  }
}

variable "db_engine_version" {
  description = "PostgreSQL 엔진 버전"
  type        = string
  default     = "15.5"
}

# ─────────────────────────────────────────────────────────────────────────────
# ECS
# ─────────────────────────────────────────────────────────────────────────────

variable "ecs_desired_count" {
  description = "ECS 서비스 desired count (향후 서비스 생성 시 사용)"
  type        = number
  default     = 2

  validation {
    condition     = var.ecs_desired_count >= 0 && var.ecs_desired_count <= 20
    error_message = "ecs_desired_count는 0~20 범위여야 합니다."
  }
}

variable "ecs_enable_container_insights" {
  description = "ECS cluster container insights 활성화"
  type        = bool
  default     = false
}

variable "ecs_enable_alb" {
  description = "ECS 모듈에서 ALB skeleton 생성 여부"
  type        = bool
  default     = false
}

variable "ecs_alb_ingress_cidrs" {
  description = "ALB ingress 허용 CIDR"
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = alltrue([for cidr in var.ecs_alb_ingress_cidrs : can(cidrhost(cidr, 0))])
    error_message = "ecs_alb_ingress_cidrs의 모든 값은 유효한 CIDR이어야 합니다."
  }
}

variable "ecs_log_retention_days" {
  description = "ECS 로그 보존일"
  type        = number
  default     = 14

  validation {
    condition     = var.ecs_log_retention_days >= 1 && var.ecs_log_retention_days <= 3653
    error_message = "ecs_log_retention_days는 1~3653 범위여야 합니다."
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# S3
# ─────────────────────────────────────────────────────────────────────────────

variable "s3_artifacts_bucket_name" {
  description = "S3 artifacts bucket 이름(비우면 project/environment 기반 자동 생성)"
  type        = string
  default     = ""

  validation {
    condition     = var.s3_artifacts_bucket_name == "" || can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.s3_artifacts_bucket_name))
    error_message = "s3_artifacts_bucket_name 형식이 올바르지 않습니다."
  }
}

variable "s3_logs_bucket_name" {
  description = "S3 logs bucket 이름(비우면 project/environment 기반 자동 생성)"
  type        = string
  default     = ""

  validation {
    condition     = var.s3_logs_bucket_name == "" || can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.s3_logs_bucket_name))
    error_message = "s3_logs_bucket_name 형식이 올바르지 않습니다."
  }
}

variable "s3_force_destroy" {
  description = "S3 bucket force_destroy 여부"
  type        = bool
  default     = false
}

variable "s3_enable_versioning" {
  description = "S3 bucket versioning 활성화"
  type        = bool
  default     = true
}

variable "s3_noncurrent_expiration_days" {
  description = "S3 noncurrent object 만료일"
  type        = number
  default     = 30

  validation {
    condition     = var.s3_noncurrent_expiration_days >= 0 && var.s3_noncurrent_expiration_days <= 3650
    error_message = "s3_noncurrent_expiration_days는 0~3650 범위여야 합니다."
  }
}

variable "tags" {
  description = "공통 태그"
  type        = map(string)
  default = {
    Team      = "DevSecOps"
    ManagedBy = "Terraform"
  }
}
