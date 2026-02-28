output "db_instance_identifier" {
  description = "DB instance identifier"
  value       = try(aws_db_instance.this[0].id, null)
}

output "db_endpoint" {
  description = "DB endpoint"
  value       = try(aws_db_instance.this[0].endpoint, null)
}

output "db_address" {
  description = "DB hostname"
  value       = try(aws_db_instance.this[0].address, null)
}

output "db_port" {
  description = "DB port"
  value       = try(aws_db_instance.this[0].port, null)
}

output "security_group_id" {
  description = "DB security group ID"
  value       = try(aws_security_group.db[0].id, null)
}
