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
const JWT_CLAIM_SELECTOR_PATTERN = /^([^\s\[\]]+)(?:\[(\d+)\])?$/;

const DEFAULT_JWT_CLAIM_MAPPING = {
  tenantIdClaim: "tenant_id",
  tenantIdFallbackClaims: ["tid"],
  userIdClaim: "sub",
  userIdFallbackClaims: ["user_id"],
  roleClaim: "role",
  roleFallbackClaims: ["roles[0]"],
} as const;

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
  claimMapping: JwtClaimMappingResolved;
}

export interface JwtAuthConfig {
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
}

export interface JwtClaimMappingConfig {
  tenantIdClaim: string;
  tenantIdFallbackClaims: string[];
  userIdClaim: string;
  userIdFallbackClaims: string[];
  roleClaim: string;
  roleFallbackClaims: string[];
}

interface JwtClaimSelector {
  raw: string;
  claimName: string;
  arrayIndex?: number;
}

interface JwtClaimFieldMappingResolved {
  selectors: readonly JwtClaimSelector[];
  displayName: string;
  primarySelectorRaw: string;
}

interface JwtClaimMappingResolved {
  tenantId: JwtClaimFieldMappingResolved;
  userId: JwtClaimFieldMappingResolved;
  role: JwtClaimFieldMappingResolved;
}

interface JwtClaimSelectorResolutionParams {
  primaryEnvName: string;
  fallbackEnvName: string;
  primaryClaim: string;
  fallbackClaims: readonly string[];
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

function readTrimmedEnvList(name: string): string[] | undefined {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string") {
    return undefined;
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readConfiguredClaim(name: string, defaultValue: string): string {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string") {
    return defaultValue;
  }

  return rawValue.trim();
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

function parseJwtClaimSelector(selectorRaw: string): JwtClaimSelector | null {
  const normalized = selectorRaw.trim();
  if (normalized.length === 0) {
    return null;
  }

  const match = JWT_CLAIM_SELECTOR_PATTERN.exec(normalized);
  if (!match) {
    return null;
  }

  const claimName = match[1];
  const arrayIndexText = match[2];
  if (!arrayIndexText) {
    return {
      raw: normalized,
      claimName,
    };
  }

  const arrayIndex = Number.parseInt(arrayIndexText, 10);
  if (!Number.isSafeInteger(arrayIndex) || arrayIndex < 0) {
    return null;
  }

  return {
    raw: normalized,
    claimName,
    arrayIndex,
  };
}

function dedupeClaimSelectors(claimSelectors: readonly string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const selector of claimSelectors) {
    const normalized = selector.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function formatClaimSelectorList(selectors: readonly JwtClaimSelector[]): string {
  return selectors.map((selector) => selector.raw).join(" 또는 ");
}

function resolveClaimSelectors(
  params: JwtClaimSelectorResolutionParams
):
  | { ok: true; fieldMapping: JwtClaimFieldMappingResolved }
  | TenantAuthResolutionFailure {
  const primarySelectorRaw = params.primaryClaim.trim();
  if (primarySelectorRaw.length === 0) {
    return failAuth(
      503,
      `${params.primaryEnvName}는 비어 있을 수 없습니다`,
      "TENANT_AUTH_JWT_CLAIM_MAPPING_INVALID"
    );
  }

  const selectorCandidates = dedupeClaimSelectors([
    primarySelectorRaw,
    ...params.fallbackClaims,
  ]);

  const selectors: JwtClaimSelector[] = [];
  for (let index = 0; index < selectorCandidates.length; index += 1) {
    const selectorCandidate = selectorCandidates[index];
    const parsedSelector = parseJwtClaimSelector(selectorCandidate);
    if (!parsedSelector) {
      const sourceEnvName = index === 0 ? params.primaryEnvName : params.fallbackEnvName;
      return failAuth(
        503,
        `${sourceEnvName} 값(${selectorCandidate})은 '<claim>' 또는 '<claim>[n]' 형식이어야 합니다`,
        "TENANT_AUTH_JWT_CLAIM_MAPPING_INVALID"
      );
    }

    selectors.push(parsedSelector);
  }

  return {
    ok: true,
    fieldMapping: {
      selectors,
      displayName: formatClaimSelectorList(selectors),
      primarySelectorRaw,
    },
  };
}

function resolveJwtClaimMappingConfig():
  | { ok: true; claimMapping: JwtClaimMappingResolved }
  | TenantAuthResolutionFailure {
  const claimMappingConfig = getJwtClaimMappingConfig();

  const tenantSelectorResolution = resolveClaimSelectors({
    primaryEnvName: "JWT_TENANT_ID_CLAIM",
    fallbackEnvName: "JWT_TENANT_ID_FALLBACK_CLAIMS",
    primaryClaim: claimMappingConfig.tenantIdClaim,
    fallbackClaims: claimMappingConfig.tenantIdFallbackClaims,
  });
  if (!tenantSelectorResolution.ok) {
    return tenantSelectorResolution;
  }

  const userSelectorResolution = resolveClaimSelectors({
    primaryEnvName: "JWT_USER_ID_CLAIM",
    fallbackEnvName: "JWT_USER_ID_FALLBACK_CLAIMS",
    primaryClaim: claimMappingConfig.userIdClaim,
    fallbackClaims: claimMappingConfig.userIdFallbackClaims,
  });
  if (!userSelectorResolution.ok) {
    return userSelectorResolution;
  }

  const roleSelectorResolution = resolveClaimSelectors({
    primaryEnvName: "JWT_ROLE_CLAIM",
    fallbackEnvName: "JWT_ROLE_FALLBACK_CLAIMS",
    primaryClaim: claimMappingConfig.roleClaim,
    fallbackClaims: claimMappingConfig.roleFallbackClaims,
  });
  if (!roleSelectorResolution.ok) {
    return roleSelectorResolution;
  }

  return {
    ok: true,
    claimMapping: {
      tenantId: tenantSelectorResolution.fieldMapping,
      userId: userSelectorResolution.fieldMapping,
      role: roleSelectorResolution.fieldMapping,
    },
  };
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

  const claimMappingResolution = resolveJwtClaimMappingConfig();
  if (!claimMappingResolution.ok) {
    return claimMappingResolution;
  }

  return {
    ok: true,
    config: {
      issuer,
      audience,
      jwksUrl,
      jwksResolver: getOrCreateRemoteJwks(parsedJwksUrl),
      claimMapping: claimMappingResolution.claimMapping,
    },
  };
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readClaimBySelector(
  payload: JWTPayload,
  selector: JwtClaimSelector
): string | undefined {
  const claimValue = payload[selector.claimName];
  if (selector.arrayIndex === undefined) {
    return readStringValue(claimValue);
  }

  if (!Array.isArray(claimValue)) {
    return undefined;
  }

  return readStringValue(claimValue[selector.arrayIndex]);
}

function readClaimWithMapping(
  payload: JWTPayload,
  selectors: readonly JwtClaimSelector[]
): string | undefined {
  for (const selector of selectors) {
    const claimValue = readClaimBySelector(payload, selector);
    if (claimValue) {
      return claimValue;
    }
  }

  return undefined;
}

function resolveTenantContextFromJwtPayload(
  payload: JWTPayload,
  claimMapping: JwtClaimMappingResolved
): TenantAuthResolution {
  const tenantId = readClaimWithMapping(payload, claimMapping.tenantId.selectors);
  if (!tenantId) {
    return failAuth(
      401,
      `JWT ${claimMapping.tenantId.displayName} 클레임이 필요합니다`,
      "TENANT_AUTH_TENANT_ID_CLAIM_REQUIRED"
    );
  }

  const userId = readClaimWithMapping(payload, claimMapping.userId.selectors);
  if (!userId) {
    return failAuth(
      401,
      `JWT ${claimMapping.userId.displayName} 클레임이 필요합니다`,
      "TENANT_AUTH_USER_ID_CLAIM_REQUIRED"
    );
  }

  const roleClaim = readClaimWithMapping(payload, claimMapping.role.selectors);
  if (!roleClaim) {
    return failAuth(
      401,
      `JWT ${claimMapping.role.displayName} 클레임이 필요합니다`,
      "TENANT_AUTH_USER_ROLE_CLAIM_REQUIRED"
    );
  }

  const normalizedRole = roleClaim.toLowerCase();
  if (!isUserRole(normalizedRole)) {
    return failAuth(
      401,
      `JWT ${claimMapping.role.primarySelectorRaw} 클레임은 ${VALID_USER_ROLES.join(", ")} 중 하나여야 합니다`,
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

  return resolveTenantContextFromJwtPayload(
    verificationResult.payload,
    jwtConfigResolution.config.claimMapping
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

export function getJwtClaimMappingConfig(): JwtClaimMappingConfig {
  const tenantIdFallbackClaims = readTrimmedEnvList("JWT_TENANT_ID_FALLBACK_CLAIMS");
  const userIdFallbackClaims = readTrimmedEnvList("JWT_USER_ID_FALLBACK_CLAIMS");
  const roleFallbackClaims = readTrimmedEnvList("JWT_ROLE_FALLBACK_CLAIMS");

  return {
    tenantIdClaim: readConfiguredClaim(
      "JWT_TENANT_ID_CLAIM",
      DEFAULT_JWT_CLAIM_MAPPING.tenantIdClaim
    ),
    tenantIdFallbackClaims:
      tenantIdFallbackClaims ?? [...DEFAULT_JWT_CLAIM_MAPPING.tenantIdFallbackClaims],
    userIdClaim: readConfiguredClaim("JWT_USER_ID_CLAIM", DEFAULT_JWT_CLAIM_MAPPING.userIdClaim),
    userIdFallbackClaims:
      userIdFallbackClaims ?? [...DEFAULT_JWT_CLAIM_MAPPING.userIdFallbackClaims],
    roleClaim: readConfiguredClaim("JWT_ROLE_CLAIM", DEFAULT_JWT_CLAIM_MAPPING.roleClaim),
    roleFallbackClaims:
      roleFallbackClaims ?? [...DEFAULT_JWT_CLAIM_MAPPING.roleFallbackClaims],
  };
}

export function validateTenantAuthConfiguration():
  | { ok: true }
  | TenantAuthResolutionFailure {
  if (getTenantAuthMode() !== "required") {
    return { ok: true };
  }

  if (getAuthMode() !== "jwt") {
    return { ok: true };
  }

  const jwtConfigResolution = resolveJwtAuthConfig();
  if (!jwtConfigResolution.ok) {
    return jwtConfigResolution;
  }

  return { ok: true };
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
