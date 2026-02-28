output "vpc_id" {
  description = "VPC ID"
  value       = try(aws_vpc.this[0].id, null)
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = aws_subnet.private[*].id
}

output "nat_gateway_id" {
  description = "NAT Gateway ID"
  value       = try(aws_nat_gateway.this[0].id, null)
}
