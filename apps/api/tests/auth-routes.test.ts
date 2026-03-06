import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importJWK, jwtVerify, type JWTPayload } from "jose";
import { buildApp } from "../src/app.js";
import * as googleOidc from "../src/auth/google-oidc.js";
import {
  clearOrganizationStore,
  createMembership,
  createOrganization,
} from "../src/tenants/store.js";
import { DEFAULT_TENANT_ID } from "../src/tenants/types.js";

type MockFetchResponse = {
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
};

const ORIGINAL_ENV = {
  OIDC_GOOGLE_CLIENT_ID: process.env.OIDC_GOOGLE_CLIENT_ID,
  OIDC_GOOGLE_CLIENT_SECRET: process.env.OIDC_GOOGLE_CLIENT_SECRET,
  OIDC_GOOGLE_REDIRECT_URI: process.env.OIDC_GOOGLE_REDIRECT_URI,
  PLATFORM_JWT_AUDIENCE: process.env.PLATFORM_JWT_AUDIENCE,
  PLATFORM_JWT_ISSUER: process.env.PLATFORM_JWT_ISSUER,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

describe("auth routes", () => {
  const app = buildApp();
  const originalFetch = global.fetch;

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    process.env.OIDC_GOOGLE_CLIENT_ID = "google-client-id";
    process.env.OIDC_GOOGLE_CLIENT_SECRET = "google-client-secret";
    process.env.OIDC_GOOGLE_REDIRECT_URI = "http://localhost:3001/api/v1/auth/google/callback";
    process.env.PLATFORM_JWT_ISSUER = "https://previo.example.com";
    process.env.PLATFORM_JWT_AUDIENCE = "previo-api";

    clearOrganizationStore();
    vi.restoreAllMocks();
    global.fetch = vi.fn(async () => {
      const response: MockFetchResponse = {
        json: async () => ({ id_token: "google-id-token" }),
        ok: true,
        status: 200,
      };
      return response as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;

    restoreEnv("OIDC_GOOGLE_CLIENT_ID", ORIGINAL_ENV.OIDC_GOOGLE_CLIENT_ID);
    restoreEnv("OIDC_GOOGLE_CLIENT_SECRET", ORIGINAL_ENV.OIDC_GOOGLE_CLIENT_SECRET);
    restoreEnv("OIDC_GOOGLE_REDIRECT_URI", ORIGINAL_ENV.OIDC_GOOGLE_REDIRECT_URI);
    restoreEnv("PLATFORM_JWT_ISSUER", ORIGINAL_ENV.PLATFORM_JWT_ISSUER);
    restoreEnv("PLATFORM_JWT_AUDIENCE", ORIGINAL_ENV.PLATFORM_JWT_AUDIENCE);
  });

  it("GET /api/v1/auth/jwks는 active public key를 반환해야 한다", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/jwks",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      keys: [
        expect.objectContaining({
          alg: "RS256",
          kid: expect.any(String),
          kty: "RSA",
          use: "sig",
        }),
      ],
    });
  });

  it("google callback은 state가 유효하지 않으면 400을 반환해야 한다", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/callback?code=test-code&state=invalid-state",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "유효한 state가 아닙니다",
      code: "AUTH_INVALID_STATE",
    });
  });

  it("google callback은 membership이 없으면 403을 반환해야 한다", async () => {
    const verifySpy = vi
      .spyOn(googleOidc, "verifyGoogleIdToken")
      .mockResolvedValue({ sub: "google-user-no-membership" });

    const startResponse = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const state = startResponse.json().state as string;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(callbackResponse.statusCode).toBe(403);
    expect(callbackResponse.json()).toEqual({
      error: "사용자 멤버십을 찾을 수 없습니다",
      code: "AUTH_MEMBERSHIP_NOT_FOUND",
    });
  });

  it("google callback은 복수 membership일 때 tenantId가 없으면 400을 반환해야 한다", async () => {
    const organizationA = createOrganization({ name: "Org A", slug: "org-a" });
    const organizationB = createOrganization({ name: "Org B", slug: "org-b" });
    createMembership({
      organizationId: organizationA.id,
      role: "member",
      userId: "google-user-multi",
    });
    createMembership({
      organizationId: organizationB.id,
      role: "admin",
      userId: "google-user-multi",
    });

    const verifySpy = vi
      .spyOn(googleOidc, "verifyGoogleIdToken")
      .mockResolvedValue({ sub: "google-user-multi" });

    const startResponse = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const state = startResponse.json().state as string;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(callbackResponse.statusCode).toBe(400);
    expect(callbackResponse.json()).toEqual({
      error: "복수 멤버십 사용자는 tenantId query가 필요합니다",
      code: "AUTH_TENANT_ID_REQUIRED",
    });
  });

  it("google callback 성공 시 required claims가 포함된 platform JWT를 발급해야 한다", async () => {
    createMembership({
      organizationId: DEFAULT_TENANT_ID,
      role: "admin",
      userId: "google-user-success",
    });

    const verifySpy = vi
      .spyOn(googleOidc, "verifyGoogleIdToken")
      .mockResolvedValue({ email: "fallback@example.com", sub: "google-user-success" });

    const startResponse = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const state = startResponse.json().state as string;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
    });

    expect(callbackResponse.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledTimes(1);

    const callbackBody = callbackResponse.json();
    expect(callbackBody).toEqual({
      accessToken: expect.any(String),
      expiresIn: expect.any(Number),
      tokenType: "Bearer",
    });

    const jwksResponse = await app.inject({
      method: "GET",
      url: "/api/v1/auth/jwks",
    });
    const jwks = jwksResponse.json() as { keys: [Record<string, unknown>] };
    const verificationKey = await importJWK(jwks.keys[0], "RS256");

    const verified = await jwtVerify(callbackBody.accessToken as string, verificationKey, {
      algorithms: ["RS256"],
      audience: "previo-api",
      issuer: "https://previo.example.com",
    });

    const payload = verified.payload as JWTPayload & {
      role?: string;
      tenant_id?: string;
    };
    expect(payload.tenant_id).toBe(DEFAULT_TENANT_ID);
    expect(payload.sub).toBe("google-user-success");
    expect(payload.role).toBe("admin");
    expect(typeof payload.exp).toBe("number");
  });
});

