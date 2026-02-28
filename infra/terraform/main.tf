terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # TODO(ops-phase-next): 원격 상태(S3 + DynamoDB lock)로 전환
  # backend "s3" {
  #   bucket         = "devsecops-terraform-state"
  #   key            = "staging/terraform.tfstate"
  #   region         = "ap-northeast-2"
  #   encrypt        = true
  #   dynamodb_table = "devsecops-terraform-lock"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  # 기본은 create 금지(false). apply 시에도 명시적으로 true를 넘겨야 리소스가 생성된다.
  creation_enabled = var.allow_resource_creation

  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
      Stack       = "devsecops-poc"
    },
    var.tags
  )

  artifacts_bucket_name = trimspace(var.s3_artifacts_bucket_name) != "" ? var.s3_artifacts_bucket_name : "${var.project_name}-${var.environment}-artifacts"
  logs_bucket_name      = trimspace(var.s3_logs_bucket_name) != "" ? var.s3_logs_bucket_name : "${var.project_name}-${var.environment}-logs"
}

# ─────────────────────────────────────────────────────────────────────────────
# Global safety / dependency checks
# ─────────────────────────────────────────────────────────────────────────────

check "explicit_module_selection_when_creation_enabled" {
  assert {
    condition     = !var.allow_resource_creation || var.enable_vpc || var.enable_rds || var.enable_ecs || var.enable_s3
    error_message = "allow_resource_creation=true 일 때는 enable_vpc/enable_rds/enable_ecs/enable_s3 중 최소 하나를 true로 설정해야 합니다."
  }
}

check "subnet_az_lengths_match" {
  assert {
    condition = length(var.public_subnet_cidrs) == length(var.availability_zones) && length(var.private_subnet_cidrs) == length(var.availability_zones)
    error_message = "public/private subnet CIDR 개수는 availability_zones 개수와 같아야 합니다."
  }
}

check "db_storage_bounds" {
  assert {
    condition     = var.db_max_allocated_storage >= var.db_allocated_storage
    error_message = "db_max_allocated_storage는 db_allocated_storage 이상이어야 합니다."
  }
}

check "db_snapshot_identifier_required_when_snapshot_enabled" {
  assert {
    condition     = var.db_skip_final_snapshot || trimspace(var.db_final_snapshot_identifier) != ""
    error_message = "db_skip_final_snapshot=false 인 경우 db_final_snapshot_identifier를 반드시 지정해야 합니다."
  }
}

check "rds_requires_vpc" {
  assert {
    condition     = !(var.allow_resource_creation && var.enable_rds) || var.enable_vpc
    error_message = "RDS 생성은 VPC가 선행되어야 합니다. allow_resource_creation=true + enable_rds=true 시 enable_vpc=true로 설정하세요."
  }
}

check "ecs_requires_vpc" {
  assert {
    condition     = !(var.allow_resource_creation && var.enable_ecs) || var.enable_vpc
    error_message = "ECS 생성은 VPC가 선행되어야 합니다. allow_resource_creation=true + enable_ecs=true 시 enable_vpc=true로 설정하세요."
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Module calls (safe-by-default)
# ─────────────────────────────────────────────────────────────────────────────

module "vpc" {
  source = "./modules/vpc"

  enabled              = local.creation_enabled && var.enable_vpc
  name_prefix          = local.name_prefix
  vpc_cidr             = var.vpc_cidr
  availability_zones   = var.availability_zones
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  enable_nat_gateway   = var.enable_nat_gateway
  tags                 = local.common_tags
}

module "rds" {
  source = "./modules/rds"

  enabled                   = local.creation_enabled && var.enable_rds
  name_prefix               = local.name_prefix
  vpc_id                    = coalesce(module.vpc.vpc_id, "")
  private_subnet_ids        = module.vpc.private_subnet_ids
  db_name                   = var.db_name
  instance_class            = var.db_instance_class
  allocated_storage         = var.db_allocated_storage
  max_allocated_storage     = var.db_max_allocated_storage
  backup_retention_days     = var.db_backup_retention_days
  multi_az                  = var.db_multi_az
  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = var.db_skip_final_snapshot
  final_snapshot_identifier = var.db_final_snapshot_identifier
  master_username           = var.db_master_username
  master_password           = var.db_master_password
  engine_version            = var.db_engine_version
  tags                      = local.common_tags

  # TODO(ops-phase-next): parameter group / option group / alarm 연동 고도화
}

module "ecs" {
  source = "./modules/ecs"

  enabled                   = local.creation_enabled && var.enable_ecs
  name_prefix               = local.name_prefix
  vpc_id                    = coalesce(module.vpc.vpc_id, "")
  private_subnet_ids        = module.vpc.private_subnet_ids
  public_subnet_ids         = module.vpc.public_subnet_ids
  service_desired_count     = var.ecs_desired_count
  enable_container_insights = var.ecs_enable_container_insights
  enable_load_balancer      = var.ecs_enable_alb
  alb_ingress_cidrs         = var.ecs_alb_ingress_cidrs
  log_retention_days        = var.ecs_log_retention_days
  tags                      = local.common_tags

  # TODO(ops-phase-next): TaskDefinition/Service/ECR 배포 파이프라인 실연동
}

module "s3" {
  source = "./modules/s3"

  enabled                    = local.creation_enabled && var.enable_s3
  artifacts_bucket_name      = local.artifacts_bucket_name
  logs_bucket_name           = local.logs_bucket_name
  force_destroy              = var.s3_force_destroy
  enable_versioning          = var.s3_enable_versioning
  noncurrent_expiration_days = var.s3_noncurrent_expiration_days
  tags                       = local.common_tags

  # TODO(ops-phase-next): bucket policy + access logging + replication 고도화
}
