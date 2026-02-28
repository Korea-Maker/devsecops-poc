output "cluster_arn" {
  description = "ECS cluster ARN"
  value       = try(aws_ecs_cluster.this[0].arn, null)
}

output "cluster_name" {
  description = "ECS cluster name"
  value       = try(aws_ecs_cluster.this[0].name, null)
}

output "service_security_group_id" {
  description = "ECS service security group"
  value       = try(aws_security_group.service[0].id, null)
}

output "alb_dns_name" {
  description = "ALB DNS 이름"
  value       = try(aws_lb.this[0].dns_name, null)
}

output "target_group_arn" {
  description = "ALB target group ARN"
  value       = try(aws_lb_target_group.api[0].arn, null)
}

output "log_group_name" {
  description = "CloudWatch log group"
  value       = try(aws_cloudwatch_log_group.ecs[0].name, null)
}
