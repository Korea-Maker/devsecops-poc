# Staging environment example

environment  = "staging"
aws_region   = "ap-northeast-2"
project_name = "devsecops-poc"

# Safety gate (default false)
allow_resource_creation = false

# Module toggles (default false)
enable_vpc = false
enable_rds = false
enable_ecs = false
enable_s3  = false

# Networking
vpc_cidr             = "10.30.0.0/16"
availability_zones   = ["ap-northeast-2a", "ap-northeast-2c"]
public_subnet_cidrs  = ["10.30.0.0/24", "10.30.1.0/24"]
private_subnet_cidrs = ["10.30.10.0/24", "10.30.11.0/24"]
enable_nat_gateway   = true

# RDS
db_name                      = "devsecops"
db_instance_class            = "db.t4g.micro"
db_allocated_storage         = 20
db_max_allocated_storage     = 200
db_backup_retention_days     = 7
db_multi_az                  = false
db_deletion_protection       = false
db_skip_final_snapshot       = true
db_final_snapshot_identifier = ""

# ECS
ecs_desired_count             = 2
ecs_enable_container_insights = false
ecs_enable_alb                = true
ecs_alb_ingress_cidrs         = ["0.0.0.0/0"]
ecs_log_retention_days        = 14

# S3
s3_artifacts_bucket_name      = ""
s3_logs_bucket_name           = ""
s3_force_destroy              = false
s3_enable_versioning          = true
s3_noncurrent_expiration_days = 30

tags = {
  Team        = "DevSecOps"
  Environment = "staging"
}

# NOTE:
# staging에서도 기본값은 안전 모드(no-create). 생성 시 명시적으로 스위치를 켜야 한다.
