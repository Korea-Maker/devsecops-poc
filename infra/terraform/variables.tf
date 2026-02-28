# Terraform 입력 변수

variable "environment" {
  description = "배포 환경 (development, staging, production)"
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "environment는 development, staging, production 중 하나여야 합니다."
  }
}

variable "aws_region" {
  description = "AWS 리전"
  type        = string
  default     = "ap-northeast-2"
}

variable "project_name" {
  description = "프로젝트 이름"
  type        = string
  default     = "devsecops-poc"
}

# ============================================================================
# 향후 구현할 변수 정의 (Placeholder)
# ============================================================================

variable "vpc_cidr" {
  description = "VPC CIDR 블록"
  type        = string
  default     = "10.0.0.0/16"
}

variable "db_instance_class" {
  description = "RDS 인스턴스 타입"
  type        = string
  default     = "db.t3.micro"
}

variable "db_allocated_storage" {
  description = "RDS 할당된 스토리지 (GB)"
  type        = number
  default     = 20
}

variable "db_backup_retention_days" {
  description = "자동 백업 보존 기간 (일)"
  type        = number
  default     = 7
}

variable "ecs_desired_count" {
  description = "ECS Task 원하는 개수"
  type        = number
  default     = 2
}

variable "ecs_min_capacity" {
  description = "ECS Auto Scaling 최소 개수"
  type        = number
  default     = 2
}

variable "ecs_max_capacity" {
  description = "ECS Auto Scaling 최대 개수"
  type        = number
  default     = 5
}

variable "enable_https" {
  description = "HTTPS 활성화 여부"
  type        = bool
  default     = false
}

variable "ssl_certificate_arn" {
  description = "SSL 인증서 ARN (HTTPS 사용 시)"
  type        = string
  default     = ""
}

variable "cloudwatch_log_retention_days" {
  description = "CloudWatch Logs 보존 기간 (일)"
  type        = number
  default     = 7
}

variable "enable_enhanced_monitoring" {
  description = "RDS Enhanced Monitoring 활성화"
  type        = bool
  default     = false
}

variable "tags" {
  description = "모든 리소스에 적용할 공통 태그"
  type        = map(string)
  default = {
    Team    = "DevSecOps"
    ManagedBy = "Terraform"
  }
}
