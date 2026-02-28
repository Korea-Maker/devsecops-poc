import type { FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_TENANT_ID, type TenantContext, type UserRole } from "./types.js";

export type TenantAuthMode = "disabled" | "required";

const USER_ROLE_PRIORITY: Record<UserRole, number> = {
  viewer: 10,
  member: 20,
  admin: 30,
  owner: 40,
};

const VALID_USER_ROLES = Object.keys(USER_ROLE_PRIORITY) as UserRole[];
const VALID_USER_ROLE_SET: ReadonlySet<string> = new Set(VALID_USER_ROLES);

interface TenantAuthErrorBody {
  error: string;
  code?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantContext: TenantContext;
  }
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  code: string
) {
  const body: TenantAuthErrorBody = { error, code };
  return reply.status(statusCode).send(body);
}

function readTrimmedHeader(
  headers: FastifyRequest["headers"],
  headerName: string
): string | undefined {
  const rawHeader = headers[headerName];
  if (Array.isArray(rawHeader)) {
    const first = rawHeader[0];
    if (typeof first !== "string") {
      return undefined;
    }
    const trimmed = first.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof rawHeader !== "string") {
    return undefined;
  }

  const trimmed = rawHeader.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isUserRole(value: string): value is UserRole {
  return VALID_USER_ROLE_SET.has(value);
}

export function getTenantAuthMode(): TenantAuthMode {
  return process.env.TENANT_AUTH_MODE === "required" ? "required" : "disabled";
}

export function hasRoleAtLeast(
  currentRole: UserRole | undefined,
  minimumRole: UserRole
): boolean {
  if (!currentRole) {
    return false;
  }
  return USER_ROLE_PRIORITY[currentRole] >= USER_ROLE_PRIORITY[minimumRole];
}

export function requireMinimumRole(
  request: FastifyRequest,
  reply: FastifyReply,
  minimumRole: UserRole
): boolean {
  if (getTenantAuthMode() !== "required") {
    return true;
  }

  if (hasRoleAtLeast(request.tenantContext.role, minimumRole)) {
    return true;
  }

  void sendError(
    reply,
    403,
    `${minimumRole} 이상 권한이 필요합니다`,
    "TENANT_FORBIDDEN"
  );
  return false;
}

export async function tenantAuthOnRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (getTenantAuthMode() !== "required") {
    request.tenantContext = { tenantId: DEFAULT_TENANT_ID };
    return;
  }

  const userId = readTrimmedHeader(request.headers, "x-user-id");
  if (!userId) {
    void sendError(
      reply,
      401,
      "x-user-id 헤더가 필요합니다",
      "TENANT_AUTH_USER_ID_REQUIRED"
    );
    return;
  }

  const roleHeader = readTrimmedHeader(request.headers, "x-user-role");
  if (!roleHeader) {
    void sendError(
      reply,
      401,
      "x-user-role 헤더가 필요합니다",
      "TENANT_AUTH_USER_ROLE_REQUIRED"
    );
    return;
  }

  const normalizedRole = roleHeader.toLowerCase();
  if (!isUserRole(normalizedRole)) {
    void sendError(
      reply,
      400,
      `x-user-role은 ${VALID_USER_ROLES.join(", ")} 중 하나여야 합니다`,
      "TENANT_AUTH_INVALID_USER_ROLE"
    );
    return;
  }

  const tenantId =
    readTrimmedHeader(request.headers, "x-tenant-id") ?? DEFAULT_TENANT_ID;

  request.tenantContext = {
    tenantId,
    userId,
    role: normalizedRole,
  };
}
