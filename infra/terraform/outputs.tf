output "resource_creation_enabled" {
  description = "실제 리소스 생성 시도 여부"
  value       = var.allow_resource_creation
}

output "module_enablement" {
  description = "현재 실행 시점의 모듈 활성화 결과"
  value = {
    vpc = var.allow_resource_creation && var.enable_vpc
    rds = var.allow_resource_creation && var.enable_rds
    ecs = var.allow_resource_creation && var.enable_ecs
    s3  = var.allow_resource_creation && var.enable_s3
  }
}

output "vpc_id" {
  description = "생성된 VPC ID (비활성 시 null)"
  value       = module.vpc.vpc_id
}

output "public_subnet_ids" {
  description = "생성된 public subnet IDs"
  value       = module.vpc.public_subnet_ids
}

output "private_subnet_ids" {
  description = "생성된 private subnet IDs"
  value       = module.vpc.private_subnet_ids
}

output "rds_endpoint" {
  description = "RDS endpoint (비활성 시 null)"
  value       = module.rds.db_endpoint
}

output "ecs_cluster_arn" {
  description = "ECS cluster ARN (비활성 시 null)"
  value       = module.ecs.cluster_arn
}

output "s3_artifacts_bucket" {
  description = "S3 artifacts bucket 이름 (비활성 시 null)"
  value       = module.s3.artifacts_bucket_name
}

output "s3_logs_bucket" {
  description = "S3 logs bucket 이름 (비활성 시 null)"
  value       = module.s3.logs_bucket_name
}
