import { afterEach, describe, expect, it } from "vitest";
import { getAuthMode, getJwtAuthConfig, getTenantAuthMode } from "../src/tenants/auth.js";

const ORIGINAL_TENANT_AUTH_MODE = process.env.TENANT_AUTH_MODE;
const ORIGINAL_AUTH_MODE = process.env.AUTH_MODE;
const ORIGINAL_JWT_ISSUER = process.env.JWT_ISSUER;
const ORIGINAL_JWT_AUDIENCE = process.env.JWT_AUDIENCE;
const ORIGINAL_JWT_JWKS_URL = process.env.JWT_JWKS_URL;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

afterEach(() => {
  restoreEnv("TENANT_AUTH_MODE", ORIGINAL_TENANT_AUTH_MODE);
  restoreEnv("AUTH_MODE", ORIGINAL_AUTH_MODE);
  restoreEnv("JWT_ISSUER", ORIGINAL_JWT_ISSUER);
  restoreEnv("JWT_AUDIENCE", ORIGINAL_JWT_AUDIENCE);
  restoreEnv("JWT_JWKS_URL", ORIGINAL_JWT_JWKS_URL);
});

describe("tenant auth config", () => {
  it("AUTH_MODE가 없으면 header 모드를 기본값으로 사용해야 한다", () => {
    delete process.env.AUTH_MODE;

    expect(getAuthMode()).toBe("header");
  });

  it("AUTH_MODE=jwt이면 jwt 모드를 사용해야 한다", () => {
    process.env.AUTH_MODE = "jwt";

    expect(getAuthMode()).toBe("jwt");
  });

  it("AUTH_MODE가 알 수 없는 값이면 header 모드로 fallback 해야 한다", () => {
    process.env.AUTH_MODE = "invalid-mode";

    expect(getAuthMode()).toBe("header");
  });

  it("TENANT_AUTH_MODE는 기존 규약(disabled|required)을 그대로 유지해야 한다", () => {
    delete process.env.TENANT_AUTH_MODE;
    expect(getTenantAuthMode()).toBe("disabled");

    process.env.TENANT_AUTH_MODE = "required";
    expect(getTenantAuthMode()).toBe("required");

    process.env.TENANT_AUTH_MODE = "unexpected";
    expect(getTenantAuthMode()).toBe("disabled");
  });

  it("JWT 설정값은 trim된 형태로 노출되어야 한다", () => {
    process.env.JWT_ISSUER = "  https://issuer.example.com  ";
    process.env.JWT_AUDIENCE = "  devsecops-api  ";
    process.env.JWT_JWKS_URL = "  https://issuer.example.com/.well-known/jwks.json  ";

    expect(getJwtAuthConfig()).toEqual({
      issuer: "https://issuer.example.com",
      audience: "devsecops-api",
      jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
    });
  });
});
