import { afterEach, describe, expect, it } from "vitest";
import {
  getAuthMode,
  getJwtAuthConfig,
  getJwtClaimMappingConfig,
  getTenantAuthMode,
  validateTenantAuthConfiguration,
} from "../src/tenants/auth.js";

const ORIGINAL_TENANT_AUTH_MODE = process.env.TENANT_AUTH_MODE;
const ORIGINAL_AUTH_MODE = process.env.AUTH_MODE;
const ORIGINAL_JWT_ISSUER = process.env.JWT_ISSUER;
const ORIGINAL_JWT_AUDIENCE = process.env.JWT_AUDIENCE;
const ORIGINAL_JWT_JWKS_URL = process.env.JWT_JWKS_URL;
const ORIGINAL_JWT_TENANT_ID_CLAIM = process.env.JWT_TENANT_ID_CLAIM;
const ORIGINAL_JWT_TENANT_ID_FALLBACK_CLAIMS = process.env.JWT_TENANT_ID_FALLBACK_CLAIMS;
const ORIGINAL_JWT_USER_ID_CLAIM = process.env.JWT_USER_ID_CLAIM;
const ORIGINAL_JWT_USER_ID_FALLBACK_CLAIMS = process.env.JWT_USER_ID_FALLBACK_CLAIMS;
const ORIGINAL_JWT_ROLE_CLAIM = process.env.JWT_ROLE_CLAIM;
const ORIGINAL_JWT_ROLE_FALLBACK_CLAIMS = process.env.JWT_ROLE_FALLBACK_CLAIMS;

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
  restoreEnv("JWT_TENANT_ID_CLAIM", ORIGINAL_JWT_TENANT_ID_CLAIM);
  restoreEnv(
    "JWT_TENANT_ID_FALLBACK_CLAIMS",
    ORIGINAL_JWT_TENANT_ID_FALLBACK_CLAIMS
  );
  restoreEnv("JWT_USER_ID_CLAIM", ORIGINAL_JWT_USER_ID_CLAIM);
  restoreEnv("JWT_USER_ID_FALLBACK_CLAIMS", ORIGINAL_JWT_USER_ID_FALLBACK_CLAIMS);
  restoreEnv("JWT_ROLE_CLAIM", ORIGINAL_JWT_ROLE_CLAIM);
  restoreEnv("JWT_ROLE_FALLBACK_CLAIMS", ORIGINAL_JWT_ROLE_FALLBACK_CLAIMS);
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
    process.env.JWT_AUDIENCE = "  previo-api  ";
    process.env.JWT_JWKS_URL = "  https://issuer.example.com/.well-known/jwks.json  ";

    expect(getJwtAuthConfig()).toEqual({
      issuer: "https://issuer.example.com",
      audience: "previo-api",
      jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
    });
  });

  it("JWT claim 매핑 기본값은 기존 계약(tenant_id/tid, sub/user_id, role/roles[0])을 유지해야 한다", () => {
    delete process.env.JWT_TENANT_ID_CLAIM;
    delete process.env.JWT_TENANT_ID_FALLBACK_CLAIMS;
    delete process.env.JWT_USER_ID_CLAIM;
    delete process.env.JWT_USER_ID_FALLBACK_CLAIMS;
    delete process.env.JWT_ROLE_CLAIM;
    delete process.env.JWT_ROLE_FALLBACK_CLAIMS;

    expect(getJwtClaimMappingConfig()).toEqual({
      tenantIdClaim: "tenant_id",
      tenantIdFallbackClaims: ["tid"],
      userIdClaim: "sub",
      userIdFallbackClaims: ["user_id"],
      roleClaim: "role",
      roleFallbackClaims: ["roles[0]"],
    });
  });

  it("JWT claim 매핑 환경변수는 trim/csv 파싱되어야 한다", () => {
    process.env.JWT_TENANT_ID_CLAIM = "  org_id ";
    process.env.JWT_TENANT_ID_FALLBACK_CLAIMS = " tenant_id, tid  ,  ";
    process.env.JWT_USER_ID_CLAIM = " uid ";
    process.env.JWT_USER_ID_FALLBACK_CLAIMS = " sub , user_id ";
    process.env.JWT_ROLE_CLAIM = " permissions[0] ";
    process.env.JWT_ROLE_FALLBACK_CLAIMS = " role , roles[0] ";

    expect(getJwtClaimMappingConfig()).toEqual({
      tenantIdClaim: "org_id",
      tenantIdFallbackClaims: ["tenant_id", "tid"],
      userIdClaim: "uid",
      userIdFallbackClaims: ["sub", "user_id"],
      roleClaim: "permissions[0]",
      roleFallbackClaims: ["role", "roles[0]"],
    });
  });

  it("fallback env를 빈 문자열로 설정하면 fallback 비활성화로 해석해야 한다", () => {
    process.env.JWT_ROLE_FALLBACK_CLAIMS = "  ";

    const mapping = getJwtClaimMappingConfig();
    expect(mapping.roleFallbackClaims).toEqual([]);
  });

  it("JWT claim 매핑 형식이 잘못되면 startup 검증에서 명확한 코드로 실패해야 한다", () => {
    process.env.TENANT_AUTH_MODE = "required";
    process.env.AUTH_MODE = "jwt";
    process.env.JWT_ISSUER = "https://issuer.example.com";
    process.env.JWT_AUDIENCE = "previo-api";
    process.env.JWT_JWKS_URL = "https://issuer.example.com/.well-known/jwks.json";
    process.env.JWT_ROLE_CLAIM = "roles[";

    const validation = validateTenantAuthConfiguration();

    expect(validation.ok).toBe(false);
    if (validation.ok) {
      return;
    }

    expect(validation.statusCode).toBe(503);
    expect(validation.code).toBe("TENANT_AUTH_JWT_CLAIM_MAPPING_INVALID");
  });
});
