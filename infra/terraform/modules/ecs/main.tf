# ECS skeleton module
# NOTE: enabled=false(default)이면 어떤 리소스도 생성되지 않는다.

check "network_inputs_when_enabled" {
  assert {
    condition     = !var.enabled || (trimspace(var.vpc_id) != "" && length(var.private_subnet_ids) >= 2)
    error_message = "ECS 활성화 시 vpc_id와 private_subnet_ids(최소 2개)가 필요합니다."
  }
}

check "alb_requires_public_subnets" {
  assert {
    condition     = !(var.enabled && var.enable_load_balancer) || length(var.public_subnet_ids) >= 2
    error_message = "ALB 활성화 시 public_subnet_ids(최소 2개)가 필요합니다."
  }
}

resource "aws_ecs_cluster" "this" {
  count = var.enabled ? 1 : 0

  name = "${var.name_prefix}-ecs"

  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-ecs"
    Component = "compute"
  })
}

resource "aws_cloudwatch_log_group" "ecs" {
  count = var.enabled ? 1 : 0

  name              = "/ecs/${var.name_prefix}"
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, {
    Name      = "/ecs/${var.name_prefix}"
    Component = "observability"
  })
}

resource "aws_security_group" "service" {
  count = var.enabled ? 1 : 0

  name_prefix = "${var.name_prefix}-ecs-svc-"
  description = "ECS service security group skeleton"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-ecs-svc-sg"
    Component = "compute"
  })
}

resource "aws_security_group" "alb" {
  count = var.enabled && var.enable_load_balancer ? 1 : 0

  name_prefix = "${var.name_prefix}-alb-"
  description = "ALB security group skeleton"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-alb-sg"
    Component = "compute"
  })
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  count = var.enabled && var.enable_load_balancer ? 1 : 0

  security_group_id            = aws_security_group.service[0].id
  referenced_security_group_id = aws_security_group.alb[0].id
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001

  description = "ALB -> ECS service"
}

resource "aws_lb" "this" {
  count = var.enabled && var.enable_load_balancer ? 1 : 0

  name               = substr(replace("${var.name_prefix}-alb", "_", "-"), 0, 32)
  internal           = false
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb[0].id]

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-alb"
    Component = "compute"
  })
}

resource "aws_lb_target_group" "api" {
  count = var.enabled && var.enable_load_balancer ? 1 : 0

  name        = substr(replace("${var.name_prefix}-api", "_", "-"), 0, 32)
  port        = 3001
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 30
    timeout             = 5
    path                = "/health"
    matcher             = "200-399"
  }

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-api-tg"
    Component = "compute"
  })
}

resource "aws_lb_listener" "http" {
  count = var.enabled && var.enable_load_balancer ? 1 : 0

  load_balancer_arn = aws_lb.this[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[0].arn
  }
}

# TODO(ops-phase-next): ECS task definition/service + autoscaling + ECR 이미지 rollout 연동
