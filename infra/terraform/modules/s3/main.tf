# S3 skeleton module
# NOTE: enabled=false(default)이면 어떤 리소스도 생성되지 않는다.

check "bucket_names_are_different" {
  assert {
    condition     = var.artifacts_bucket_name != var.logs_bucket_name
    error_message = "artifacts_bucket_name과 logs_bucket_name은 서로 달라야 합니다."
  }
}

resource "aws_s3_bucket" "artifacts" {
  count = var.enabled ? 1 : 0

  bucket        = var.artifacts_bucket_name
  force_destroy = var.force_destroy

  tags = merge(var.tags, {
    Name      = var.artifacts_bucket_name
    Component = "storage"
    Purpose   = "artifacts"
  })
}

resource "aws_s3_bucket" "logs" {
  count = var.enabled ? 1 : 0

  bucket        = var.logs_bucket_name
  force_destroy = var.force_destroy

  tags = merge(var.tags, {
    Name      = var.logs_bucket_name
    Component = "storage"
    Purpose   = "logs"
  })
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  count = var.enabled ? 1 : 0

  bucket                  = aws_s3_bucket.artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "logs" {
  count = var.enabled ? 1 : 0

  bucket                  = aws_s3_bucket.logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  count = var.enabled ? 1 : 0

  bucket = aws_s3_bucket.artifacts[0].id

  versioning_configuration {
    status = var.enable_versioning ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_versioning" "logs" {
  count = var.enabled ? 1 : 0

  bucket = aws_s3_bucket.logs[0].id

  versioning_configuration {
    status = var.enable_versioning ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  count = var.enabled ? 1 : 0

  bucket = aws_s3_bucket.artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  count = var.enabled ? 1 : 0

  bucket = aws_s3_bucket.logs[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  count = var.enabled && var.enable_versioning && var.noncurrent_expiration_days > 0 ? 1 : 0

  bucket = aws_s3_bucket.artifacts[0].id

  rule {
    id     = "cleanup-noncurrent"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_expiration_days
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  count = var.enabled && var.enable_versioning && var.noncurrent_expiration_days > 0 ? 1 : 0

  bucket = aws_s3_bucket.logs[0].id

  rule {
    id     = "cleanup-noncurrent"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_expiration_days
    }
  }
}

# TODO(ops-phase-next): access log bucket 분리, bucket policy least-privilege, KMS key 연동
