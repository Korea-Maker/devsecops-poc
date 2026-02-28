variable "enabled" {
  description = "모듈 활성화 여부"
  type        = bool
  default     = false
}

variable "artifacts_bucket_name" {
  description = "Artifacts bucket 이름"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.artifacts_bucket_name))
    error_message = "artifacts_bucket_name 형식이 올바르지 않습니다."
  }
}

variable "logs_bucket_name" {
  description = "Logs bucket 이름"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.logs_bucket_name))
    error_message = "logs_bucket_name 형식이 올바르지 않습니다."
  }
}

variable "force_destroy" {
  description = "Bucket force destroy"
  type        = bool
  default     = false
}

variable "enable_versioning" {
  description = "Versioning 활성화"
  type        = bool
  default     = true
}

variable "noncurrent_expiration_days" {
  description = "noncurrent object 만료일"
  type        = number
  default     = 30

  validation {
    condition     = var.noncurrent_expiration_days >= 0
    error_message = "noncurrent_expiration_days는 0 이상이어야 합니다."
  }
}

variable "tags" {
  description = "공통 태그"
  type        = map(string)
  default     = {}
}
