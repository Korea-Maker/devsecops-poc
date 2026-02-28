import { createHash, randomUUID } from "crypto";
import {
  exportJWK,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  SignJWT,
  type JWK,
} from "jose";
import type { UserRole } from "../tenants/types.js";

interface LoggerLike {
  warn(message: string): void;
}

interface PlatformJwtSignerState {
  audience: string;
  expiresInSeconds: number;
  issuer: string;
  jwk: JWK;
  kid: string;
  privateKey: Awaited<ReturnType<typeof importPKCS8>>;
}

const DEFAULT_PLATFORM_JWT_ISSUER = "https://devsecops.local";
const DEFAULT_PLATFORM_JWT_AUDIENCE = "devsecops-api";
const DEFAULT_PLATFORM_JWT_EXPIRES_IN_SECONDS = 3600;

let logger: LoggerLike = console;
let signerStatePromise: Promise<PlatformJwtSignerState> | null = null;

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function createKidFromPublicKeyPem(publicKeyPem: string): string {
  return createHash("sha256")
    .update(publicKeyPem)
    .digest("base64url")
    .slice(0, 24);
}

async function createEphemeralSignerState(): Promise<PlatformJwtSignerState> {
  logger.warn(
    "[auth] PLATFORM_JWT_PRIVATE_KEY_PEM/PLATFORM_JWT_PUBLIC_KEY_PEM 미설정: 부팅 중 임시 RS256 키를 생성합니다(재시작 시 토큰 무효화됨)."
  );

  const keyPair = await generateKeyPair("RS256");
  const jwk = await exportJWK(keyPair.publicKey);
  const kid = readTrimmedEnv("PLATFORM_JWT_KID") ?? randomUUID();
  const issuer = readTrimmedEnv("PLATFORM_JWT_ISSUER") ?? DEFAULT_PLATFORM_JWT_ISSUER;
  const audience =
    readTrimmedEnv("PLATFORM_JWT_AUDIENCE") ?? DEFAULT_PLATFORM_JWT_AUDIENCE;
  const expiresInSeconds = toPositiveInteger(
    readTrimmedEnv("PLATFORM_JWT_ACCESS_TTL_SEC"),
    DEFAULT_PLATFORM_JWT_EXPIRES_IN_SECONDS
  );

  jwk.alg = "RS256";
  jwk.use = "sig";
  jwk.kid = kid;

  return {
    audience,
    expiresInSeconds,
    issuer,
    jwk,
    kid,
    privateKey: keyPair.privateKey,
  };
}

async function createSignerStateFromEnv(): Promise<PlatformJwtSignerState> {
  const privateKeyPem = readTrimmedEnv("PLATFORM_JWT_PRIVATE_KEY_PEM");
  const publicKeyPem = readTrimmedEnv("PLATFORM_JWT_PUBLIC_KEY_PEM");

  if (!privateKeyPem && !publicKeyPem) {
    return createEphemeralSignerState();
  }

  if (!privateKeyPem || !publicKeyPem) {
    logger.warn(
      "[auth] PLATFORM_JWT key material이 불완전합니다(공개키/개인키 필요). 임시 RS256 키로 대체합니다."
    );
    return createEphemeralSignerState();
  }

  try {
    const [privateKey, publicKey] = await Promise.all([
      importPKCS8(privateKeyPem, "RS256"),
      importSPKI(publicKeyPem, "RS256"),
    ]);
    const jwk = await exportJWK(publicKey);
    const kid =
      readTrimmedEnv("PLATFORM_JWT_KID") ?? createKidFromPublicKeyPem(publicKeyPem);
    const issuer =
      readTrimmedEnv("PLATFORM_JWT_ISSUER") ?? DEFAULT_PLATFORM_JWT_ISSUER;
    const audience =
      readTrimmedEnv("PLATFORM_JWT_AUDIENCE") ?? DEFAULT_PLATFORM_JWT_AUDIENCE;
    const expiresInSeconds = toPositiveInteger(
      readTrimmedEnv("PLATFORM_JWT_ACCESS_TTL_SEC"),
      DEFAULT_PLATFORM_JWT_EXPIRES_IN_SECONDS
    );

    jwk.alg = "RS256";
    jwk.use = "sig";
    jwk.kid = kid;

    return {
      audience,
      expiresInSeconds,
      issuer,
      jwk,
      kid,
      privateKey,
    };
  } catch {
    logger.warn(
      "[auth] PLATFORM_JWT key material 파싱에 실패했습니다. 임시 RS256 키로 대체합니다."
    );
    return createEphemeralSignerState();
  }
}

async function getSignerState(): Promise<PlatformJwtSignerState> {
  if (!signerStatePromise) {
    signerStatePromise = createSignerStateFromEnv();
  }
  return signerStatePromise;
}

export function configurePlatformJwtLogger(nextLogger: LoggerLike): void {
  logger = nextLogger;
}

export async function getPlatformJwks(): Promise<{ keys: JWK[] }> {
  const state = await getSignerState();
  return { keys: [state.jwk] };
}

export async function issuePlatformAccessToken(params: {
  role: UserRole;
  tenantId: string;
  userId: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const state = await getSignerState();
  const accessToken = await new SignJWT({
    role: params.role,
    tenant_id: params.tenantId,
  })
    .setProtectedHeader({ alg: "RS256", kid: state.kid, typ: "JWT" })
    .setSubject(params.userId)
    .setIssuer(state.issuer)
    .setAudience(state.audience)
    .setIssuedAt()
    .setExpirationTime(`${state.expiresInSeconds}s`)
    .sign(state.privateKey);

  return {
    accessToken,
    expiresIn: state.expiresInSeconds,
  };
}
