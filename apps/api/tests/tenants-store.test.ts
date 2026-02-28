import { afterEach, describe, expect, it } from "vitest";
import {
  clearOrganizationStore,
  createOrganization,
  listOrganizations,
} from "../src/tenants/store.js";
import { DEFAULT_TENANT_ID } from "../src/tenants/types.js";

describe("Tenant Organization Store", () => {
  afterEach(() => {
    clearOrganizationStore();
  });

  it("기본 조직(default tenant)은 항상 존재해야 한다", () => {
    const organizations = listOrganizations();
    expect(organizations.some((organization) => organization.id === DEFAULT_TENANT_ID)).toBe(
      true
    );
  });

  it("clearOrganizationStore 호출 후에도 기본 조직이 재부팅되어야 한다", () => {
    createOrganization({ name: "Acme", slug: "acme" });

    clearOrganizationStore();

    const organizations = listOrganizations();
    expect(organizations).toHaveLength(1);
    expect(organizations[0]?.id).toBe(DEFAULT_TENANT_ID);
    expect(organizations[0]?.slug).toBe("default");
  });

  it("중복 slug로 조직 생성 시 409(TENANT_DUPLICATE_SLUG)를 던져야 한다", () => {
    createOrganization({ name: "Acme", slug: "acme" });

    let capturedError: unknown;
    try {
      createOrganization({ name: "Acme 2", slug: "Acme" });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toMatchObject({
      statusCode: 409,
      code: "TENANT_DUPLICATE_SLUG",
    });
  });
});
