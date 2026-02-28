import type { FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_TENANT_ID, type TenantContext, type UserRole } from "./types.js";

export type TenantAuthMode = "disabled" | "required";
export type AuthMode = "header" | "jwt";

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

interface TenantAuthResolutionSuccess {
  ok: true;
  tenantContext: TenantContext;
}

interface TenantAuthResolutionFailure {
  ok: false;
  statusCode: number;
  error: string;
  code: string;
}

type TenantAuthResolution = TenantAuthResolutionSuccess | TenantAuthResolutionFailure;

interface BearerTokenResolutionSuccess {
  ok: true;
  token: string;
}

type BearerTokenResolution =
  | BearerTokenResolutionSuccess
  | TenantAuthResolutionFailure;

export interface JwtAuthConfig {
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
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

function readTrimmedEnv(name: string): string | undefined {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string") {
    return undefined;
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isUserRole(value: string): value is UserRole {
  return VALID_USER_ROLE_SET.has(value);
}

function failAuth(
  statusCode: number,
  error: string,
  code: string
): TenantAuthResolutionFailure {
  return {
    ok: false,
    statusCode,
    error,
    code,
  };
}

function decodeBase64Url(input: string): string | null {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  const padded = `${normalized}${"=".repeat(padLength)}`;

  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isStructurallyValidJwt(token: string): boolean {
  const segments = token.split(".");
  if (segments.length !== 3) {
    return false;
  }

  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (!headerSegment || !payloadSegment || !signatureSegment) {
    return false;
  }

  const decodedHeader = decodeBase64Url(headerSegment);
  const decodedPayload = decodeBase64Url(payloadSegment);

  if (!decodedHeader || !decodedPayload) {
    return false;
  }

  const headerRecord = parseJsonRecord(decodedHeader);
  const payloadRecord = parseJsonRecord(decodedPayload);

  if (!headerRecord || !payloadRecord) {
    return false;
  }

  return typeof payloadRecord.sub === "string" && payloadRecord.sub.trim().length > 0;
}

function resolveTenantContextFromHeaderAuth(
  request: FastifyRequest
): TenantAuthResolution {
  const userId = readTrimmedHeader(request.headers, "x-user-id");
  if (!userId) {
    return failAuth(
      401,
      "x-user-id 헤더가 필요합니다",
      "TENANT_AUTH_USER_ID_REQUIRED"
    );
  }

  const roleHeader = readTrimmedHeader(request.headers, "x-user-role");
  if (!roleHeader) {
    return failAuth(
      401,
      "x-user-role 헤더가 필요합니다",
      "TENANT_AUTH_USER_ROLE_REQUIRED"
    );
  }

  const normalizedRole = roleHeader.toLowerCase();
  if (!isUserRole(normalizedRole)) {
    return failAuth(
      400,
      `x-user-role은 ${VALID_USER_ROLES.join(", ")} 중 하나여야 합니다`,
      "TENANT_AUTH_INVALID_USER_ROLE"
    );
  }

  const tenantId =
    readTrimmedHeader(request.headers, "x-tenant-id") ?? DEFAULT_TENANT_ID;

  return {
    ok: true,
    tenantContext: {
      tenantId,
      userId,
      role: normalizedRole,
    },
  };
}

function readBearerToken(headers: FastifyRequest["headers"]): BearerTokenResolution {
  const authorizationHeader = readTrimmedHeader(headers, "authorization");
  if (!authorizationHeader) {
    return failAuth(
      401,
      "Authorization Bearer 토큰이 필요합니다",
      "TENANT_AUTH_BEARER_TOKEN_REQUIRED"
    );
  }

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  if (!bearerMatch) {
    return failAuth(
      401,
      "Authorization 헤더는 Bearer <token> 형식이어야 합니다",
      "TENANT_AUTH_INVALID_AUTHORIZATION_HEADER"
    );
  }

  const token = bearerMatch[1]?.trim();
  if (!token) {
    return failAuth(
      401,
      "Authorization 헤더는 Bearer <token> 형식이어야 합니다",
      "TENANT_AUTH_INVALID_AUTHORIZATION_HEADER"
    );
  }

  return {
    ok: true,
    token,
  };
}

function resolveTenantContextFromJwtAuth(
  request: FastifyRequest
): TenantAuthResolution {
  const tokenResolution = readBearerToken(request.headers);
  if (!tokenResolution.ok) {
    return tokenResolution;
  }

  if (!isStructurallyValidJwt(tokenResolution.token)) {
    return failAuth(
      401,
      "유효한 JWT Bearer 토큰이 아닙니다",
      "TENANT_AUTH_INVALID_BEARER_TOKEN"
    );
  }

  const jwtConfig = getJwtAuthConfig();
  if (!jwtConfig.issuer || !jwtConfig.audience || !jwtConfig.jwksUrl) {
    return failAuth(
      503,
      "JWT 모드 구성값이 부족합니다(JWT_ISSUER, JWT_AUDIENCE, JWT_JWKS_URL 필요)",
      "TENANT_AUTH_JWT_CONFIG_INCOMPLETE"
    );
  }

  // TODO(phase5-auth): JOSE/JWKS 서명 검증 + iss/aud/exp 검증을 구현한 뒤
  // tenant/user/role 클레임 매핑을 활성화한다.
  return failAuth(
    501,
    "JWT 인증 검증은 아직 준비 중입니다. 현재는 AUTH_MODE=header를 사용하세요",
    "TENANT_AUTH_JWT_NOT_IMPLEMENTED"
  );
}

export function getTenantAuthMode(): TenantAuthMode {
  return readTrimmedEnv("TENANT_AUTH_MODE")?.toLowerCase() === "required"
    ? "required"
    : "disabled";
}

export function getAuthMode(): AuthMode {
  return readTrimmedEnv("AUTH_MODE")?.toLowerCase() === "jwt" ? "jwt" : "header";
}

export function getJwtAuthConfig(): JwtAuthConfig {
  return {
    issuer: readTrimmedEnv("JWT_ISSUER"),
    audience: readTrimmedEnv("JWT_AUDIENCE"),
    jwksUrl: readTrimmedEnv("JWT_JWKS_URL"),
  };
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

  const authResolution =
    getAuthMode() === "jwt"
      ? resolveTenantContextFromJwtAuth(request)
      : resolveTenantContextFromHeaderAuth(request);

  if (!authResolution.ok) {
    void sendError(
      reply,
      authResolution.statusCode,
      authResolution.error,
      authResolution.code
    );
    return;
  }

  request.tenantContext = authResolution.tenantContext;
}
