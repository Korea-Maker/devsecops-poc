# VPC skeleton module
# NOTE: enabled=false(default)이면 어떤 리소스도 생성되지 않는다.

check "subnet_length_matches_az" {
  assert {
    condition = length(var.public_subnet_cidrs) == length(var.availability_zones) && length(var.private_subnet_cidrs) == length(var.availability_zones)
    error_message = "public/private subnet CIDR 개수는 availability_zones 개수와 동일해야 합니다."
  }
}

resource "aws_vpc" "this" {
  count = var.enabled ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-vpc"
    Component = "network"
  })
}

resource "aws_internet_gateway" "this" {
  count = var.enabled ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-igw"
    Component = "network"
  })
}

resource "aws_subnet" "public" {
  count = var.enabled ? length(var.public_subnet_cidrs) : 0

  vpc_id                  = aws_vpc.this[0].id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-public-${count.index + 1}"
    Tier      = "public"
    Component = "network"
  })
}

resource "aws_subnet" "private" {
  count = var.enabled ? length(var.private_subnet_cidrs) : 0

  vpc_id            = aws_vpc.this[0].id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-private-${count.index + 1}"
    Tier      = "private"
    Component = "network"
  })
}

resource "aws_route_table" "public" {
  count = var.enabled ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-public-rt"
    Component = "network"
  })
}

resource "aws_route" "public_internet_gateway" {
  count = var.enabled ? 1 : 0

  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this[0].id
}

resource "aws_route_table_association" "public" {
  count = var.enabled ? length(var.public_subnet_cidrs) : 0

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_eip" "nat" {
  count = var.enabled && var.enable_nat_gateway ? 1 : 0

  domain = "vpc"

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-nat-eip"
    Component = "network"
  })
}

resource "aws_nat_gateway" "this" {
  count = var.enabled && var.enable_nat_gateway ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-nat"
    Component = "network"
  })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count = var.enabled ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = merge(var.tags, {
    Name      = "${var.name_prefix}-private-rt"
    Component = "network"
  })
}

resource "aws_route" "private_nat_gateway" {
  count = var.enabled && var.enable_nat_gateway ? 1 : 0

  route_table_id         = aws_route_table.private[0].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

resource "aws_route_table_association" "private" {
  count = var.enabled ? length(var.private_subnet_cidrs) : 0

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

# TODO(ops-phase-next): NACL, VPC endpoint, flow logs, IPv6 분리 설계 추가
