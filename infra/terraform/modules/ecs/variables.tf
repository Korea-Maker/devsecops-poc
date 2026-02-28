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
  description = "ECS private subnet IDs"
  type        = list(string)
  default     = []
}

variable "public_subnet_ids" {
  description = "ALB용 public subnet IDs"
  type        = list(string)
  default     = []
}

variable "service_desired_count" {
  description = "향후 ECS service desired count"
  type        = number
  default     = 2
}

variable "enable_container_insights" {
  description = "container insights 활성화"
  type        = bool
  default     = false
}

variable "enable_load_balancer" {
  description = "ALB skeleton 생성 여부"
  type        = bool
  default     = false
}

variable "alb_ingress_cidrs" {
  description = "ALB ingress CIDR"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "log_retention_days" {
  description = "CloudWatch log retention days"
  type        = number
  default     = 14
}

variable "tags" {
  description = "공통 태그"
  type        = map(string)
  default     = {}
}
