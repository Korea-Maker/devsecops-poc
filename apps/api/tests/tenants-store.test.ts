import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptOrganizationInviteToken,
  clearOrganizationStore,
  createMembership,
  createOrganization,
  createOrganizationInviteToken,
  disableOrganization,
  listMemberships,
  listOrganizations,
  removeMembership,
  updateMembershipRole,
} from "../src/tenants/store.js";
import { DEFAULT_TENANT_ID } from "../src/tenants/types.js";

describe("Tenant Organization Store", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    expect(organizations[0]?.active).toBe(true);
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

  it("조직 목록은 search/page/limit 옵션을 지원해야 한다", () => {
    createOrganization({ name: "Team Alpha", slug: "team-alpha" });
    createOrganization({ name: "Team Beta", slug: "team-beta" });
    createOrganization({ name: "Team Gamma", slug: "team-gamma" });

    const searched = listOrganizations({ search: "team" });
    expect(searched).toHaveLength(3);

    const page1 = listOrganizations({ search: "team", page: 1, limit: 2 });
    expect(page1).toHaveLength(2);
    expect(page1.map((organization) => organization.slug)).toEqual([
      "team-alpha",
      "team-beta",
    ]);

    const page2 = listOrganizations({ search: "team", page: 2, limit: 2 });
    expect(page2).toHaveLength(1);
    expect(page2[0]?.slug).toBe("team-gamma");
  });

  it("조직 비활성화 후 멤버십 쓰기 작업은 409(TENANT_ORG_DISABLED)여야 한다", () => {
    const organization = createOrganization({
      name: "Disabled Org",
      slug: "disabled-org",
    });

    const disabled = disableOrganization(organization.id);
    expect(disabled.active).toBe(false);
    expect(disabled.disabledAt).toBeDefined();

    let capturedError: unknown;
    try {
      createMembership({
        organizationId: organization.id,
        userId: "member-user",
        role: "member",
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toMatchObject({
      statusCode: 409,
      code: "TENANT_ORG_DISABLED",
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

  it("멤버십 목록은 search/page/limit 옵션을 지원해야 한다", () => {
    const organization = createOrganization({
      name: "Membership Filter Org",
      slug: "membership-filter-org",
    });

    createMembership({ organizationId: organization.id, userId: "member-a", role: "member" });
    createMembership({ organizationId: organization.id, userId: "member-b", role: "viewer" });
    createMembership({ organizationId: organization.id, userId: "member-c", role: "viewer" });

    const searched = listMemberships(organization.id, { search: "viewer" });
    expect(searched).toHaveLength(2);

    const page1 = listMemberships(organization.id, {
      search: "member-",
      page: 1,
      limit: 2,
    });
    expect(page1).toHaveLength(2);

    const page2 = listMemberships(organization.id, {
      search: "member-",
      page: 2,
      limit: 2,
    });
    expect(page2).toHaveLength(1);
    expect(page2[0]?.userId).toBe("member-c");
  });

  it("초대 토큰은 1회만 사용 가능해야 하고 email 바인딩을 검증해야 한다", () => {
    const organization = createOrganization({
      name: "Invite Org",
      slug: "invite-org",
    });

    const inviteToken = createOrganizationInviteToken({
      organizationId: organization.id,
      role: "member",
      email: "invitee@example.com",
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdByUserId: "admin-user",
    });

    const accepted = acceptOrganizationInviteToken({
      token: inviteToken.token,
      userId: "invited-user",
      email: "invitee@example.com",
    });

    expect(accepted.membership).toMatchObject({
      organizationId: organization.id,
      userId: "invited-user",
      role: "member",
    });
    expect(accepted.inviteToken.consumedAt).toBeDefined();

    let replayError: unknown;
    try {
      acceptOrganizationInviteToken({
        token: inviteToken.token,
        userId: "invited-user-2",
        email: "invitee@example.com",
      });
    } catch (error) {
      replayError = error;
    }

    expect(replayError).toMatchObject({
      statusCode: 409,
      code: "TENANT_INVITE_ALREADY_USED",
    });

    const emailBoundInvite = createOrganizationInviteToken({
      organizationId: organization.id,
      role: "viewer",
      email: "bound@example.com",
      expiresAt: "2099-01-01T01:00:00.000Z",
    });

    let emailMismatchError: unknown;
    try {
      acceptOrganizationInviteToken({
        token: emailBoundInvite.token,
        userId: "another-user",
        email: "wrong@example.com",
      });
    } catch (error) {
      emailMismatchError = error;
    }

    expect(emailMismatchError).toMatchObject({
      statusCode: 403,
      code: "TENANT_INVITE_EMAIL_MISMATCH",
    });
  });

  it("만료된 초대 토큰 수락은 410(TENANT_INVITE_EXPIRED)이어야 한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));

    const organization = createOrganization({
      name: "Expired Invite Org",
      slug: "expired-invite-org",
    });

    const inviteToken = createOrganizationInviteToken({
      organizationId: organization.id,
      role: "member",
      expiresAt: "2026-03-01T00:05:00.000Z",
    });

    vi.setSystemTime(new Date("2026-03-01T00:05:01.000Z"));

    let capturedError: unknown;
    try {
      acceptOrganizationInviteToken({
        token: inviteToken.token,
        userId: "late-user",
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toMatchObject({
      statusCode: 410,
      code: "TENANT_INVITE_EXPIRED",
    });
  });
});
