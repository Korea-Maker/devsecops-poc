variable "enabled" {
  description = "모듈 활성화 여부"
  type        = bool
  default     = false
}

variable "name_prefix" {
  description = "리소스 이름 prefix"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
  default     = ""
}

variable "private_subnet_ids" {
  description = "RDS 배치용 private subnet IDs"
  type        = list(string)
  default     = []
}

variable "db_name" {
  description = "초기 DB 이름"
  type        = string
}

variable "instance_class" {
  description = "RDS instance class"
  type        = string
}

variable "allocated_storage" {
  description = "기본 스토리지(GB)"
  type        = number
}

variable "max_allocated_storage" {
  description = "최대 스토리지(GB)"
  type        = number
}

variable "backup_retention_days" {
  description = "백업 보존 일수"
  type        = number
}

variable "multi_az" {
  description = "Multi-AZ 여부"
  type        = bool
}

variable "deletion_protection" {
  description = "삭제 보호 여부"
  type        = bool
}

variable "skip_final_snapshot" {
  description = "삭제 시 final snapshot 생략 여부"
  type        = bool
}

variable "final_snapshot_identifier" {
  description = "삭제 시 final snapshot identifier"
  type        = string
  default     = ""
}

variable "master_username" {
  description = "마스터 사용자명"
  type        = string
}

variable "master_password" {
  description = "마스터 비밀번호(null이면 AWS managed password)"
  type        = string
  default     = null
  sensitive   = true
}

variable "engine_version" {
  description = "PostgreSQL 엔진 버전"
  type        = string
}

variable "tags" {
  description = "공통 태그"
  type        = map(string)
  default     = {}
}
