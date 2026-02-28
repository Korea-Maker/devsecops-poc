output "artifacts_bucket_name" {
  description = "Artifacts bucket name"
  value       = try(aws_s3_bucket.artifacts[0].bucket, null)
}

output "artifacts_bucket_arn" {
  description = "Artifacts bucket ARN"
  value       = try(aws_s3_bucket.artifacts[0].arn, null)
}

output "logs_bucket_name" {
  description = "Logs bucket name"
  value       = try(aws_s3_bucket.logs[0].bucket, null)
}

output "logs_bucket_arn" {
  description = "Logs bucket ARN"
  value       = try(aws_s3_bucket.logs[0].arn, null)
}
