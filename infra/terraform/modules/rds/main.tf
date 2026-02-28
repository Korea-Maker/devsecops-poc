# RDS skeleton module
# NOTE: enabled=false(default)이면 어떤 리소스도 생성되지 않는다.

check "network_inputs_when_enabled" {
  assert {
    condition     = !var.enabled || (trimspace(var.vpc_id) != "" && length(var.private_subnet_ids) >= 2)
    error_message = "RDS 활성화 시 vpc_id와 private_subnet_ids(최소 2개)가 필요합니다."
  }
}

check "max_storage_greater_or_equal_allocated" {
  assert {
    condition     = var.max_allocated_storage >= var.allocated_storage
    error_message = "max_allocated_storage는 allocated_storage 이상이어야 합니다."
  }
}

check "final_snapshot_identifier_when_required" {
  assert {
    condition     = var.skip_final_snapshot || trimspace(var.final_snapshot_identifier) != ""
    error_message = "skip_final_snapshot=false 인 경우 final_snapshot_identifier가 필요합니다."
  }
}

resource "aws_db_subnet_group" "this" {
  count = var.enabled ? 1 : 0

  name       = "${var.name_prefix}-db-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-db-subnet-group"
    Component = "database"
  })
}

resource "aws_security_group" "db" {
  count = var.enabled ? 1 : 0

  name_prefix = "${var.name_prefix}-db-sg-"
  description = "RDS security group skeleton"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-db-sg"
    Component = "database"
  })
}

resource "aws_db_instance" "this" {
  count = var.enabled ? 1 : 0

  identifier             = "${var.name_prefix}-postgres"
  engine                 = "postgres"
  engine_version         = var.engine_version
  instance_class         = var.instance_class
  allocated_storage      = var.allocated_storage
  max_allocated_storage  = var.max_allocated_storage
  storage_encrypted      = true
  db_name                = var.db_name
  username               = var.master_username
  manage_master_user_password = var.master_password == null
  password               = var.master_password

  db_subnet_group_name   = aws_db_subnet_group.this[0].name
  vpc_security_group_ids = [aws_security_group.db[0].id]

  backup_retention_period = var.backup_retention_days
  multi_az                = var.multi_az
  publicly_accessible     = false

  deletion_protection      = var.deletion_protection
  skip_final_snapshot      = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : var.final_snapshot_identifier

  # TODO(ops-phase-next): parameter/option group, monitoring role, enhanced monitoring, alarm 연동

  apply_immediately          = false
  auto_minor_version_upgrade = true

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-postgres"
    Component = "database"
  })
}
