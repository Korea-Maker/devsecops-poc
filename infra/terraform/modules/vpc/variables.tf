variable "enabled" {
  description = "모듈 활성화 여부"
  type        = bool
  default     = false
}

variable "name_prefix" {
  description = "리소스 이름 prefix"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR"
  type        = string

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr는 유효한 CIDR 형식이어야 합니다."
  }
}

variable "availability_zones" {
  description = "AZ 목록"
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "availability_zones는 최소 2개 이상이어야 합니다."
  }
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDR 목록"
  type        = list(string)

  validation {
    condition     = alltrue([for cidr in var.public_subnet_cidrs : can(cidrhost(cidr, 0))])
    error_message = "public_subnet_cidrs의 모든 값은 유효한 CIDR이어야 합니다."
  }
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDR 목록"
  type        = list(string)

  validation {
    condition     = alltrue([for cidr in var.private_subnet_cidrs : can(cidrhost(cidr, 0))])
    error_message = "private_subnet_cidrs의 모든 값은 유효한 CIDR이어야 합니다."
  }
}

variable "enable_nat_gateway" {
  description = "NAT Gateway 생성 여부"
  type        = bool
  default     = false
}

variable "tags" {
  description = "공통 태그"
  type        = map(string)
  default     = {}
}
