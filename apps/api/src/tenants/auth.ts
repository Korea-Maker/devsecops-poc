import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
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
const JWT_ALLOWED_ALGORITHMS = ["RS256", "ES256"] as const;

const remoteJwksCache = new Map<string, JWTVerifyGetKey>();

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

interface JwtVerificationSuccess {
  ok: true;
  payload: JWTPayload;
}

type JwtVerificationResult =
  | JwtVerificationSuccess
  | TenantAuthResolutionFailure;

interface JwtAuthConfigResolved {
  issuer: string;
  audience: string;
  jwksUrl: string;
  jwksResolver: JWTVerifyGetKey;
}

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

function getOrCreateRemoteJwks(jwksUrl: URL): JWTVerifyGetKey {
  const cacheKey = jwksUrl.toString();
  const cached = remoteJwksCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const jwksResolver = createRemoteJWKSet(jwksUrl);
  remoteJwksCache.set(cacheKey, jwksResolver);
  return jwksResolver;
}

function resolveJwtAuthConfig():
  | { ok: true; config: JwtAuthConfigResolved }
  | TenantAuthResolutionFailure {
  const jwtConfig = getJwtAuthConfig();
  const { issuer, audience, jwksUrl } = jwtConfig;

  if (!issuer || !audience || !jwksUrl) {
    const missingVars: string[] = [];
    if (!issuer) {
      missingVars.push("JWT_ISSUER");
    }
    if (!audience) {
      missingVars.push("JWT_AUDIENCE");
    }
    if (!jwksUrl) {
      missingVars.push("JWT_JWKS_URL");
    }

    return failAuth(
      503,
      `JWT 모드 구성값이 부족합니다(${missingVars.join(", ")} 필요)`,
      "TENANT_AUTH_JWT_CONFIG_INCOMPLETE"
    );
  }

  let parsedJwksUrl: URL;
  try {
    parsedJwksUrl = new URL(jwksUrl);
  } catch {
    return failAuth(
      503,
      "JWT_JWKS_URL은 http/https URL이어야 합니다",
      "TENANT_AUTH_JWT_CONFIG_INVALID"
    );
  }

  if (parsedJwksUrl.protocol !== "https:" && parsedJwksUrl.protocol !== "http:") {
    return failAuth(
      503,
      "JWT_JWKS_URL은 http/https URL이어야 합니다",
      "TENANT_AUTH_JWT_CONFIG_INVALID"
    );
  }

  return {
    ok: true,
    config: {
      issuer,
      audience,
      jwksUrl,
      jwksResolver: getOrCreateRemoteJwks(parsedJwksUrl),
    },
  };
}

function readStringClaim(payload: JWTPayload, claimName: string): string | undefined {
  const claimValue = payload[claimName];
  if (typeof claimValue !== "string") {
    return undefined;
  }

  const trimmed = claimValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readClaimWithFallback(
  payload: JWTPayload,
  claimNames: readonly string[]
): string | undefined {
  for (const claimName of claimNames) {
    const claimValue = readStringClaim(payload, claimName);
    if (claimValue) {
      return claimValue;
    }
  }

  return undefined;
}

function readRoleClaim(payload: JWTPayload): string | undefined {
  const directRole = readStringClaim(payload, "role");
  if (directRole) {
    return directRole;
  }

  const rolesClaim = payload.roles;
  if (!Array.isArray(rolesClaim)) {
    return undefined;
  }

  const firstRole = rolesClaim[0];
  if (typeof firstRole !== "string") {
    return undefined;
  }

  const trimmed = firstRole.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveTenantContextFromJwtPayload(
  payload: JWTPayload
): TenantAuthResolution {
  const tenantId = readClaimWithFallback(payload, ["tenant_id", "tid"]);
  if (!tenantId) {
    return failAuth(
      401,
      "JWT tenant_id 또는 tid 클레임이 필요합니다",
      "TENANT_AUTH_TENANT_ID_CLAIM_REQUIRED"
    );
  }

  const userId = readClaimWithFallback(payload, ["sub", "user_id"]);
  if (!userId) {
    return failAuth(
      401,
      "JWT sub 또는 user_id 클레임이 필요합니다",
      "TENANT_AUTH_USER_ID_CLAIM_REQUIRED"
    );
  }

  const roleClaim = readRoleClaim(payload);
  if (!roleClaim) {
    return failAuth(
      401,
      "JWT role 또는 roles[0] 클레임이 필요합니다",
      "TENANT_AUTH_USER_ROLE_CLAIM_REQUIRED"
    );
  }

  const normalizedRole = roleClaim.toLowerCase();
  if (!isUserRole(normalizedRole)) {
    return failAuth(
      401,
      `JWT role 클레임은 ${VALID_USER_ROLES.join(", ")} 중 하나여야 합니다`,
      "TENANT_AUTH_INVALID_USER_ROLE_CLAIM"
    );
  }

  return {
    ok: true,
    tenantContext: {
      tenantId,
      userId,
      role: normalizedRole,
    },
  };
}

function mapJwtVerificationError(error: unknown): TenantAuthResolutionFailure {
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === "iss") {
      return failAuth(
        401,
        "JWT issuer가 일치하지 않습니다",
        "TENANT_AUTH_JWT_ISSUER_MISMATCH"
      );
    }

    if (error.claim === "aud") {
      return failAuth(
        401,
        "JWT audience가 일치하지 않습니다",
        "TENANT_AUTH_JWT_AUDIENCE_MISMATCH"
      );
    }

    return failAuth(
      401,
      "JWT 클레임 검증에 실패했습니다",
      "TENANT_AUTH_INVALID_BEARER_TOKEN"
    );
  }

  if (error instanceof joseErrors.JWTExpired) {
    return failAuth(401, "JWT 토큰이 만료되었습니다", "TENANT_AUTH_JWT_EXPIRED");
  }

  if (
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JWKSNoMatchingKey
  ) {
    return failAuth(
      401,
      "JWT 서명 검증에 실패했습니다",
      "TENANT_AUTH_INVALID_BEARER_TOKEN_SIGNATURE"
    );
  }

  if (error instanceof joseErrors.JWKSInvalid) {
    return failAuth(
      503,
      "JWKS 응답이 올바른 형식이 아닙니다",
      "TENANT_AUTH_JWKS_INVALID"
    );
  }

  if (error instanceof TypeError) {
    return failAuth(
      503,
      "JWKS 엔드포인트에 접근할 수 없습니다",
      "TENANT_AUTH_JWKS_UNREACHABLE"
    );
  }

  return failAuth(
    401,
    "유효한 JWT Bearer 토큰이 아닙니다",
    "TENANT_AUTH_INVALID_BEARER_TOKEN"
  );
}

async function verifyJwtToken(
  token: string,
  jwtConfig: JwtAuthConfigResolved
): Promise<JwtVerificationResult> {
  try {
    const { payload } = await jwtVerify(token, jwtConfig.jwksResolver, {
      issuer: jwtConfig.issuer,
      audience: jwtConfig.audience,
      algorithms: [...JWT_ALLOWED_ALGORITHMS],
    });

    return {
      ok: true,
      payload,
    };
  } catch (error) {
    return mapJwtVerificationError(error);
  }
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

async function resolveTenantContextFromJwtAuth(
  request: FastifyRequest
): Promise<TenantAuthResolution> {
  const tokenResolution = readBearerToken(request.headers);
  if (!tokenResolution.ok) {
    return tokenResolution;
  }

  const jwtConfigResolution = resolveJwtAuthConfig();
  if (!jwtConfigResolution.ok) {
    return jwtConfigResolution;
  }

  const verificationResult = await verifyJwtToken(
    tokenResolution.token,
    jwtConfigResolution.config
  );
  if (!verificationResult.ok) {
    return verificationResult;
  }

  return resolveTenantContextFromJwtPayload(verificationResult.payload);
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

  const authMode = getAuthMode();
  const authResolution =
    authMode === "jwt"
      ? await resolveTenantContextFromJwtAuth(request)
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
