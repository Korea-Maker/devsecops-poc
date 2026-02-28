import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface GoogleIdTokenClaims {
  email?: string;
  sub: string;
}

interface GoogleOidcConfig {
  authUrl: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  jwksUrl: string;
  redirectUri: string;
  scope: string;
  tokenUrl: string;
}

interface GoogleTokenResponse {
  id_token?: unknown;
}

const DEFAULT_GOOGLE_ISSUER = "https://accounts.google.com";
const DEFAULT_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const DEFAULT_GOOGLE_SCOPE = "openid email profile";

const jwksResolverCache = new Map<string, JWTVerifyGetKey>();

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toConfigError(message: string): Error & { code: string; statusCode: number } {
  const error = new Error(message) as Error & { code: string; statusCode: number };
  error.code = "AUTH_CONFIG_INVALID";
  error.statusCode = 503;
  return error;
}

function toUpstreamError(message: string): Error & { code: string; statusCode: number } {
  const error = new Error(message) as Error & { code: string; statusCode: number };
  error.code = "AUTH_OIDC_UPSTREAM_ERROR";
  error.statusCode = 502;
  return error;
}

function toInvalidIdTokenError(
  message: string
): Error & { code: string; statusCode: number } {
  const error = new Error(message) as Error & { code: string; statusCode: number };
  error.code = "AUTH_INVALID_GOOGLE_ID_TOKEN";
  error.statusCode = 401;
  return error;
}

function getGoogleOidcConfig(): GoogleOidcConfig {
  const clientId = readTrimmedEnv("OIDC_GOOGLE_CLIENT_ID");
  const clientSecret = readTrimmedEnv("OIDC_GOOGLE_CLIENT_SECRET");
  const redirectUri = readTrimmedEnv("OIDC_GOOGLE_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    throw toConfigError(
      "OIDC_GOOGLE_CLIENT_ID, OIDC_GOOGLE_CLIENT_SECRET, OIDC_GOOGLE_REDIRECT_URI가 필요합니다"
    );
  }

  return {
    authUrl: readTrimmedEnv("OIDC_GOOGLE_AUTH_URL") ?? DEFAULT_GOOGLE_AUTH_URL,
    clientId,
    clientSecret,
    issuer: readTrimmedEnv("OIDC_GOOGLE_ISSUER") ?? DEFAULT_GOOGLE_ISSUER,
    jwksUrl: readTrimmedEnv("OIDC_GOOGLE_JWKS_URL") ?? DEFAULT_GOOGLE_JWKS_URL,
    redirectUri,
    scope: readTrimmedEnv("OIDC_GOOGLE_SCOPES") ?? DEFAULT_GOOGLE_SCOPE,
    tokenUrl: readTrimmedEnv("OIDC_GOOGLE_TOKEN_URL") ?? DEFAULT_GOOGLE_TOKEN_URL,
  };
}

function getOrCreateGoogleJwksResolver(jwksUrl: string): JWTVerifyGetKey {
  const cached = jwksResolverCache.get(jwksUrl);
  if (cached) {
    return cached;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(jwksUrl);
  } catch {
    throw toConfigError("OIDC_GOOGLE_JWKS_URL 형식이 올바르지 않습니다");
  }

  const resolver = createRemoteJWKSet(parsedUrl);
  jwksResolverCache.set(jwksUrl, resolver);
  return resolver;
}

function readTrimmedStringClaim(
  payload: JWTPayload,
  claimName: string
): string | undefined {
  const value = payload[claimName];
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildGoogleAuthorizationUrl(params: {
  nonce: string;
  state: string;
}): string {
  const config = getGoogleOidcConfig();
  const url = new URL(config.authUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("prompt", "select_account");

  return url.toString();
}

export async function exchangeGoogleCodeForTokens(params: {
  code: string;
}): Promise<{ idToken: string }> {
  const config = getGoogleOidcConfig();
  const body = new URLSearchParams();
  body.set("code", params.code);
  body.set("client_id", config.clientId);
  body.set("client_secret", config.clientSecret);
  body.set("redirect_uri", config.redirectUri);
  body.set("grant_type", "authorization_code");

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      body: body.toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
  } catch {
    throw toUpstreamError("Google token endpoint 호출 중 네트워크 오류가 발생했습니다");
  }

  if (!response.ok) {
    throw toUpstreamError(`Google token endpoint 호출 실패(status=${response.status})`);
  }

  let tokenResponse: GoogleTokenResponse;
  try {
    tokenResponse = (await response.json()) as GoogleTokenResponse;
  } catch {
    throw toUpstreamError("Google token endpoint 응답 JSON 파싱에 실패했습니다");
  }

  if (typeof tokenResponse.id_token !== "string" || tokenResponse.id_token.length === 0) {
    throw toUpstreamError("Google token endpoint 응답에 id_token이 없습니다");
  }

  return { idToken: tokenResponse.id_token };
}

export async function verifyGoogleIdToken(params: {
  idToken: string;
  nonce: string;
}): Promise<GoogleIdTokenClaims> {
  const config = getGoogleOidcConfig();
  const resolver = getOrCreateGoogleJwksResolver(config.jwksUrl);
  let verificationResult: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    verificationResult = await jwtVerify(params.idToken, resolver, {
      algorithms: ["RS256"],
      audience: config.clientId,
      issuer: config.issuer,
    });
  } catch {
    throw toInvalidIdTokenError("Google id_token 검증에 실패했습니다");
  }

  const nonce = readTrimmedStringClaim(verificationResult.payload, "nonce");
  if (!nonce || nonce !== params.nonce) {
    throw toInvalidIdTokenError("Google id_token nonce 검증에 실패했습니다");
  }

  const subject = readTrimmedStringClaim(verificationResult.payload, "sub");
  if (!subject) {
    throw toInvalidIdTokenError("Google id_token에 sub 클레임이 없습니다");
  }

  return {
    email: readTrimmedStringClaim(verificationResult.payload, "email"),
    sub: subject,
  };
}

