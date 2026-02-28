import { randomUUID } from "crypto";
import {
  DEFAULT_TENANT_ID,
  type Organization,
  type OrganizationMembership,
  type UserRole,
} from "./types.js";

interface TenantStoreError extends Error {
  code: string;
  statusCode: number;
}

const DEFAULT_ORG_NAME = "Default Organization";
const DEFAULT_ORG_SLUG = "default";

/** 인메모리 조직 저장소 */
const orgStore = new Map<string, Organization>();
/** 인메모리 멤버십 저장소 (key: orgId:userId) */
const membershipStore = new Map<string, OrganizationMembership>();

const VALID_USER_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "member",
  "viewer",
]);

function createTenantStoreError(
  statusCode: number,
  message: string,
  code: string
): TenantStoreError {
  const error = new Error(message) as TenantStoreError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length > 0) {
    return normalized;
  }

  throw createTenantStoreError(
    400,
    `${field}은(는) 비어 있을 수 없습니다`,
    `TENANT_INVALID_${field.toUpperCase()}`
  );
}

function normalizeSlug(slug: string): string {
  return normalizeRequiredText(slug, "slug").toLowerCase();
}

function normalizeUserRole(role: UserRole): UserRole {
  if (VALID_USER_ROLES.has(role)) {
    return role;
  }

  throw createTenantStoreError(
    400,
    "role은 owner, admin, member, viewer 중 하나여야 합니다",
    "TENANT_INVALID_ROLE"
  );
}

function membershipKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

function hasOrganizationBySlug(slug: string): boolean {
  for (const organization of orgStore.values()) {
    if (organization.slug === slug) {
      return true;
    }
  }
  return false;
}

function assertOrganizationExists(organizationId: string): Organization {
  const organization = orgStore.get(organizationId);
  if (!organization) {
    throw createTenantStoreError(404, "조직을 찾을 수 없습니다", "TENANT_ORG_NOT_FOUND");
  }
  return organization;
}

function bootstrapDefaultOrganization(): void {
  if (orgStore.has(DEFAULT_TENANT_ID)) {
    return;
  }

  const defaultOrg: Organization = {
    id: DEFAULT_TENANT_ID,
    name: DEFAULT_ORG_NAME,
    slug: DEFAULT_ORG_SLUG,
    createdAt: new Date().toISOString(),
  };

  orgStore.set(DEFAULT_TENANT_ID, defaultOrg);
}

/**
 * 새로운 조직(테넌트)을 생성하고 저장소에 저장합니다.
 */
export function createOrganization(params: {
  name: string;
  slug: string;
}): Organization {
  const name = normalizeRequiredText(params.name, "name");
  const slug = normalizeSlug(params.slug);

  if (hasOrganizationBySlug(slug)) {
    throw createTenantStoreError(
      409,
      "이미 존재하는 조직 slug입니다",
      "TENANT_DUPLICATE_SLUG"
    );
  }

  const organization: Organization = {
    id: randomUUID(),
    name,
    slug,
    createdAt: new Date().toISOString(),
  };

  orgStore.set(organization.id, organization);
  return organization;
}

/**
 * ID로 단일 조직을 조회합니다. 없으면 undefined를 반환합니다.
 */
export function getOrganization(id: string): Organization | undefined {
  return orgStore.get(id);
}

/**
 * 전체 조직 목록을 반환합니다.
 */
export function listOrganizations(): Organization[] {
  return Array.from(orgStore.values());
}

/**
 * 조직에 멤버를 추가합니다.
 */
export function createMembership(params: {
  organizationId: string;
  userId: string;
  role: UserRole;
}): OrganizationMembership {
  const organizationId = normalizeRequiredText(params.organizationId, "organizationId");
  const userId = normalizeRequiredText(params.userId, "userId");
  const role = normalizeUserRole(params.role);

  assertOrganizationExists(organizationId);

  const key = membershipKey(organizationId, userId);
  if (membershipStore.has(key)) {
    throw createTenantStoreError(
      409,
      "이미 존재하는 조직 멤버십입니다",
      "TENANT_MEMBERSHIP_EXISTS"
    );
  }

  const now = new Date().toISOString();
  const membership: OrganizationMembership = {
    organizationId,
    userId,
    role,
    createdAt: now,
    updatedAt: now,
  };

  membershipStore.set(key, membership);
  return membership;
}

/**
 * 조직 멤버십을 조회합니다.
 */
export function getMembership(
  organizationId: string,
  userId: string
): OrganizationMembership | undefined {
  return membershipStore.get(membershipKey(organizationId, userId));
}

/**
 * 조직의 전체 멤버십을 반환합니다.
 */
export function listMemberships(organizationId: string): OrganizationMembership[] {
  assertOrganizationExists(organizationId);

  const memberships: OrganizationMembership[] = [];
  for (const membership of membershipStore.values()) {
    if (membership.organizationId === organizationId) {
      memberships.push({ ...membership });
    }
  }

  return memberships;
}

/**
 * 사용자의 전체 멤버십을 반환합니다.
 */
export function listUserMemberships(userId: string): OrganizationMembership[] {
  const normalizedUserId = normalizeRequiredText(userId, "userId");

  const memberships: OrganizationMembership[] = [];
  for (const membership of membershipStore.values()) {
    if (membership.userId === normalizedUserId) {
      memberships.push({ ...membership });
    }
  }

  return memberships;
}

/**
 * 조직 멤버 여부를 반환합니다.
 */
export function isOrganizationMember(organizationId: string, userId: string): boolean {
  return membershipStore.has(membershipKey(organizationId, userId));
}

function countOwnerMemberships(organizationId: string): number {
  let ownerCount = 0;
  for (const membership of membershipStore.values()) {
    if (membership.organizationId === organizationId && membership.role === "owner") {
      ownerCount += 1;
    }
  }
  return ownerCount;
}

/**
 * 조직 멤버를 제거합니다.
 * - 마지막 owner 제거는 허용하지 않습니다.
 */
export function removeMembership(params: {
  organizationId: string;
  userId: string;
}): OrganizationMembership {
  const organizationId = normalizeRequiredText(params.organizationId, "organizationId");
  const userId = normalizeRequiredText(params.userId, "userId");

  assertOrganizationExists(organizationId);

  const key = membershipKey(organizationId, userId);
  const existingMembership = membershipStore.get(key);
  if (!existingMembership) {
    throw createTenantStoreError(
      404,
      "조직 멤버십을 찾을 수 없습니다",
      "TENANT_MEMBERSHIP_NOT_FOUND"
    );
  }

  if (
    existingMembership.role === "owner" &&
    countOwnerMemberships(organizationId) <= 1
  ) {
    throw createTenantStoreError(
      409,
      "조직에는 최소 1명의 owner가 필요합니다",
      "TENANT_OWNER_MIN_REQUIRED"
    );
  }

  membershipStore.delete(key);
  return { ...existingMembership };
}

/**
 * 조직 멤버의 역할을 수정합니다.
 */
export function updateMembershipRole(params: {
  organizationId: string;
  userId: string;
  role: UserRole;
}): OrganizationMembership {
  const organizationId = normalizeRequiredText(params.organizationId, "organizationId");
  const userId = normalizeRequiredText(params.userId, "userId");
  const role = normalizeUserRole(params.role);

  assertOrganizationExists(organizationId);

  const key = membershipKey(organizationId, userId);
  const existingMembership = membershipStore.get(key);
  if (!existingMembership) {
    throw createTenantStoreError(
      404,
      "조직 멤버십을 찾을 수 없습니다",
      "TENANT_MEMBERSHIP_NOT_FOUND"
    );
  }

  if (
    existingMembership.role === "owner" &&
    role !== "owner" &&
    countOwnerMemberships(organizationId) <= 1
  ) {
    throw createTenantStoreError(
      409,
      "조직에는 최소 1명의 owner가 필요합니다",
      "TENANT_OWNER_MIN_REQUIRED"
    );
  }

  const nextMembership: OrganizationMembership = {
    ...existingMembership,
    role,
    updatedAt: new Date().toISOString(),
  };
  membershipStore.set(key, nextMembership);
  return nextMembership;
}

/**
 * 저장소를 초기화합니다. 테스트 전 상태 리셋 용도로만 사용합니다.
 * - 기본 조직은 항상 재부팅합니다.
 */
export function clearOrganizationStore(): void {
  orgStore.clear();
  membershipStore.clear();
  bootstrapDefaultOrganization();
}

// 모듈 로드 시 기본 조직 자동 생성
bootstrapDefaultOrganization();
