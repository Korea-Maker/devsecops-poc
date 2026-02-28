import { afterEach, describe, expect, it } from "vitest";
import {
  clearOrganizationStore,
  createMembership,
  createOrganization,
  listMemberships,
  listOrganizations,
  removeMembership,
  updateMembershipRole,
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

  it("마지막 owner를 member로 강등하면 409(TENANT_OWNER_MIN_REQUIRED)를 던져야 한다", () => {
    const organization = createOrganization({ name: "Owner Guard Org", slug: "owner-guard-org" });
    createMembership({ organizationId: organization.id, userId: "owner-user", role: "owner" });

    let capturedError: unknown;
    try {
      updateMembershipRole({
        organizationId: organization.id,
        userId: "owner-user",
        role: "member",
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toMatchObject({
      statusCode: 409,
      code: "TENANT_OWNER_MIN_REQUIRED",
    });
  });

  it("마지막 owner를 제거하면 409(TENANT_OWNER_MIN_REQUIRED)를 던져야 한다", () => {
    const organization = createOrganization({ name: "Delete Guard Org", slug: "delete-guard-org" });
    createMembership({ organizationId: organization.id, userId: "owner-user", role: "owner" });

    let capturedError: unknown;
    try {
      removeMembership({
        organizationId: organization.id,
        userId: "owner-user",
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toMatchObject({
      statusCode: 409,
      code: "TENANT_OWNER_MIN_REQUIRED",
    });
  });

  it("owner가 2명 이상이면 owner 제거가 가능해야 한다", () => {
    const organization = createOrganization({
      name: "Delete Owner Org",
      slug: "delete-owner-org",
    });
    createMembership({ organizationId: organization.id, userId: "owner-1", role: "owner" });
    createMembership({ organizationId: organization.id, userId: "owner-2", role: "owner" });

    const removedMembership = removeMembership({
      organizationId: organization.id,
      userId: "owner-2",
    });

    expect(removedMembership).toMatchObject({
      organizationId: organization.id,
      userId: "owner-2",
      role: "owner",
    });

    const memberships = listMemberships(organization.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.userId).toBe("owner-1");
  });
});
