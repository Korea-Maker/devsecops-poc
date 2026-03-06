# Production environment example

environment  = "prod"
aws_region   = "ap-northeast-2"
project_name = "previo"

# Safety gate (default false)
allow_resource_creation = false

# Module toggles (default false)
enable_vpc = false
enable_rds = false
enable_ecs = false
enable_s3  = false

# Networking
vpc_cidr             = "10.40.0.0/16"
availability_zones   = ["ap-northeast-2a", "ap-northeast-2c"]
public_subnet_cidrs  = ["10.40.0.0/24", "10.40.1.0/24"]
private_subnet_cidrs = ["10.40.10.0/24", "10.40.11.0/24"]
enable_nat_gateway   = true

# RDS
db_name                      = "previo"
db_instance_class            = "db.t4g.small"
db_allocated_storage         = 50
db_max_allocated_storage     = 500
db_backup_retention_days     = 14
db_multi_az                  = true
db_deletion_protection       = true
db_skip_final_snapshot       = false
db_final_snapshot_identifier = "previo-prod-final"
db_master_username           = "app_admin"
db_master_password           = null
db_engine_version            = "15.5"

# ECS
ecs_desired_count             = 3
ecs_enable_container_insights = true
ecs_enable_alb                = true
ecs_alb_ingress_cidrs         = ["0.0.0.0/0"]
ecs_log_retention_days        = 30

# S3
s3_artifacts_bucket_name      = ""
s3_logs_bucket_name           = ""
s3_force_destroy              = false
s3_enable_versioning          = true
s3_noncurrent_expiration_days = 90

tags = {
  Team        = "DevSecOps"
  Environment = "prod"
  Criticality = "high"
}

# NOTE:
# production apply는 terraform-apply.sh에서 --allow-prod 없이는 거부된다.
