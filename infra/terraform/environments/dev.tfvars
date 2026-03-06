# Development environment example

environment  = "dev"
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
vpc_cidr             = "10.20.0.0/16"
availability_zones   = ["ap-northeast-2a", "ap-northeast-2c"]
public_subnet_cidrs  = ["10.20.0.0/24", "10.20.1.0/24"]
private_subnet_cidrs = ["10.20.10.0/24", "10.20.11.0/24"]
enable_nat_gateway   = false

# RDS
db_name                      = "previo"
db_instance_class            = "db.t4g.micro"
db_allocated_storage         = 20
db_max_allocated_storage     = 100
db_backup_retention_days     = 3
db_multi_az                  = false
db_deletion_protection       = false
db_skip_final_snapshot       = true
db_final_snapshot_identifier = ""
db_master_username           = "app_admin"
db_master_password           = null
db_engine_version            = "15.5"

# ECS
ecs_desired_count             = 1
ecs_enable_container_insights = false
ecs_enable_alb                = false
ecs_alb_ingress_cidrs         = ["0.0.0.0/0"]
ecs_log_retention_days        = 7

# S3
s3_artifacts_bucket_name      = ""
s3_logs_bucket_name           = ""
s3_force_destroy              = false
s3_enable_versioning          = true
s3_noncurrent_expiration_days = 14

tags = {
  Team        = "DevSecOps"
  Environment = "dev"
}

# NOTE:
# 실제 리소스를 만들려면 아래 2가지를 모두 충족해야 함
# 1) allow_resource_creation=true
# 2) 필요한 module toggle(enable_vpc 등)=true
