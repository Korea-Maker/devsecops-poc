import { randomBytes } from "crypto";

interface OAuthStateContext {
  expiresAt: number;
  nonce: string;
}

const DEFAULT_STATE_TTL_SECONDS = 300;
const stateStore = new Map<string, OAuthStateContext>();

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getStateTtlMs(): number {
  const rawTtlSeconds = readTrimmedEnv("OIDC_STATE_TTL_SEC");
  if (!rawTtlSeconds) {
    return DEFAULT_STATE_TTL_SECONDS * 1000;
  }

  const parsed = Number.parseInt(rawTtlSeconds, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_STATE_TTL_SECONDS * 1000;
  }

  return parsed * 1000;
}

function removeExpiredStates(now: number): void {
  for (const [state, context] of stateStore.entries()) {
    if (context.expiresAt <= now) {
      stateStore.delete(state);
    }
  }
}

export function createOAuthState(): { nonce: string; state: string } {
  const now = Date.now();
  removeExpiredStates(now);

  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  stateStore.set(state, {
    expiresAt: now + getStateTtlMs(),
    nonce,
  });

  return { nonce, state };
}

export function consumeOAuthState(state: string): OAuthStateContext | undefined {
  const now = Date.now();
  removeExpiredStates(now);

  const context = stateStore.get(state);
  if (!context) {
    return undefined;
  }

  stateStore.delete(state);
  if (context.expiresAt <= now) {
    return undefined;
  }

  return context;
}

