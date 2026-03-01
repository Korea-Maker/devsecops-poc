import { randomBytes, randomUUID } from "crypto";
import {
  DEFAULT_TENANT_ID,
  type Organization,
  type OrganizationInviteToken,
  type OrganizationMembership,
  type UserRole,
} from "./types.js";
import {
  clearPersistedOrganizationsAndMemberships,
  deletePersistedMembership,
  getActiveDataBackend,
  getPersistedOrganizationForTenant,
  listPersistedOrganizationsForTenant,
  listPersistedMembershipsForTenant,
  persistMembershipRecord,
  persistOrganizationInviteTokenRecord,
  persistOrganizationRecord,
} from "../storage/backend.js";

interface TenantStoreError extends Error {
  code: string;
  statusCode: number;
}

interface ListQueryOptions {
  search?: string;
  page?: number;
  limit?: number;
}

interface TenantScopedReadOptions {
  tenantId: string;
  userId?: string;
  userRole?: UserRole;
}

const DEFAULT_ORG_NAME = "Default Organization";
const DEFAULT_ORG_SLUG = "default";

/** 인메모리 조직 저장소 */
const orgStore = new Map<string, Organization>();
/** 인메모리 멤버십 저장소 (key: orgId:userId) */
const membershipStore = new Map<string, OrganizationMembership>();
/** 인메모리 조직 초대 토큰 저장소 (key: token) */
const inviteTokenStore = new Map<string, OrganizationInviteToken>();

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

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSlug(slug: string): string {
  return normalizeRequiredText(slug, "slug").toLowerCase();
}

function normalizeOptionalEmail(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(value);
  return normalized ? normalized.toLowerCase() : undefined;
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

function normalizeFutureIsoTimestamp(value: string): string {
  const normalized = normalizeRequiredText(value, "expiresAt");
  const timestamp = Date.parse(normalized);

  if (!Number.isFinite(timestamp)) {
    throw createTenantStoreError(
      400,
      "expiresAt은 유효한 ISO 날짜 문자열이어야 합니다",
      "TENANT_INVALID_EXPIRES_AT"
    );
  }

  if (timestamp <= Date.now()) {
    throw createTenantStoreError(
      400,
      "expiresAt은 현재 시각보다 미래여야 합니다",
      "TENANT_INVALID_EXPIRES_AT"
    );
  }

  return new Date(timestamp).toISOString();
}

function normalizeSearch(search: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(search);
  return normalized ? normalized.toLowerCase() : undefined;
}

function applyPagination<T>(items: T[], options: ListQueryOptions): T[] {
  if (options.page === undefined && options.limit === undefined) {
    return items;
  }

  const page =
    typeof options.page === "number" && Number.isInteger(options.page) && options.page > 0
      ? options.page
      : 1;
  const limit =
    typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit > 0
      ? options.limit
      : 20;

  const offset = (page - 1) * limit;
  return items.slice(offset, offset + limit);
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

function assertOrganizationWritable(organizationId: string): Organization {
  const organization = assertOrganizationExists(organizationId);

  if (!organization.active) {
    throw createTenantStoreError(
      409,
      "비활성화된 조직에는 변경 작업을 수행할 수 없습니다",
      "TENANT_ORG_DISABLED"
    );
  }

  return organization;
}

function cloneOrganization(organization: Organization): Organization {
  return { ...organization };
}

function cloneMembership(membership: OrganizationMembership): OrganizationMembership {
  return { ...membership };
}

function cloneInviteToken(inviteToken: OrganizationInviteToken): OrganizationInviteToken {
  return { ...inviteToken };
}

function generateInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

function bootstrapDefaultOrganization(options: { persist?: boolean } = {}): void {
  if (orgStore.has(DEFAULT_TENANT_ID)) {
    return;
  }

  const defaultOrg: Organization = {
    id: DEFAULT_TENANT_ID,
    name: DEFAULT_ORG_NAME,
    slug: DEFAULT_ORG_SLUG,
    active: true,
    createdAt: new Date().toISOString(),
  };

  orgStore.set(DEFAULT_TENANT_ID, defaultOrg);

  if (options.persist ?? true) {
    persistOrganizationRecord(defaultOrg);
  }
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
    active: true,
    createdAt: new Date().toISOString(),
  };

  orgStore.set(organization.id, organization);
  persistOrganizationRecord(organization);
  return cloneOrganization(organization);
}

/**
 * 조직을 비활성화(soft disable)합니다.
 */
export function disableOrganization(organizationId: string): Organization {
  const normalizedOrganizationId = normalizeRequiredText(organizationId, "organizationId");
  const organization = assertOrganizationExists(normalizedOrganizationId);

  if (!organization.active) {
    return cloneOrganization(organization);
  }

  const disabledOrganization: Organization = {
    ...organization,
    active: false,
    disabledAt: new Date().toISOString(),
  };

  orgStore.set(disabledOrganization.id, disabledOrganization);
  persistOrganizationRecord(disabledOrganization);
  return cloneOrganization(disabledOrganization);
}

/**
 * ID로 단일 조직을 조회합니다. 없으면 undefined를 반환합니다.
 */
export function getOrganization(id: string): Organization | undefined {
  const organization = orgStore.get(id);
  return organization ? cloneOrganization(organization) : undefined;
}

/**
 * 요청 경로 read 최적화(조직 단건):
 * - DATA_BACKEND=postgres일 때 tenant-scoped direct query를 우선 사용
 * - 그 외(memory 포함)는 기존 인메모리 스토어를 사용
 */
export async function getOrganizationForTenantReadPath(
  params: TenantScopedReadOptions & { id: string }
): Promise<Organization | undefined> {
  if (getActiveDataBackend() === "postgres") {
    const persistedOrganization = await getPersistedOrganizationForTenant({
      organizationId: params.id,
      tenantId: params.tenantId,
      userId: params.userId,
      userRole: params.userRole,
    });

    if (persistedOrganization !== null) {
      return persistedOrganization;
    }
  }

  const organization = getOrganization(params.id);
  if (!organization || organization.id !== params.tenantId) {
    return undefined;
  }

  return organization;
}

/**
 * 전체 조직 목록을 반환합니다.
 */
export function listOrganizations(options: ListQueryOptions = {}): Organization[] {
  const normalizedSearch = normalizeSearch(options.search);
  let organizations = Array.from(orgStore.values()).map(cloneOrganization);

  if (normalizedSearch) {
    organizations = organizations.filter((organization) => {
      return (
        organization.name.toLowerCase().includes(normalizedSearch) ||
        organization.slug.toLowerCase().includes(normalizedSearch)
      );
    });
  }

  return applyPagination(organizations, options);
}

/**
 * 요청 경로 read 최적화(조직 목록):
 * - DATA_BACKEND=postgres일 때 tenant-scoped direct query를 우선 사용
 * - 그 외(memory 포함)는 기존 인메모리 스토어를 사용
 */
export async function listOrganizationsForTenantReadPath(
  params: TenantScopedReadOptions & {
    search?: string;
    page?: number;
    limit?: number;
  }
): Promise<Organization[]> {
  if (getActiveDataBackend() === "postgres") {
    const persistedOrganizations = await listPersistedOrganizationsForTenant({
      tenantId: params.tenantId,
      search: params.search,
      page: params.page,
      limit: params.limit,
      userId: params.userId,
      userRole: params.userRole,
    });

    if (persistedOrganizations !== null) {
      return persistedOrganizations;
    }
  }

  const organization = getOrganization(params.tenantId);
  if (!organization) {
    return [];
  }

  const normalizedSearch = normalizeSearch(params.search);
  const scopedOrganizations = normalizedSearch
    ? [organization].filter((item) => {
        return (
          item.name.toLowerCase().includes(normalizedSearch) ||
          item.slug.toLowerCase().includes(normalizedSearch)
        );
      })
    : [organization];

  return applyPagination(scopedOrganizations, {
    page: params.page,
    limit: params.limit,
  });
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

  assertOrganizationWritable(organizationId);

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
  persistMembershipRecord(membership);
  return cloneMembership(membership);
}

/**
 * 조직 멤버십을 조회합니다.
 */
export function getMembership(
  organizationId: string,
  userId: string
): OrganizationMembership | undefined {
  const membership = membershipStore.get(membershipKey(organizationId, userId));
  return membership ? cloneMembership(membership) : undefined;
}

/**
 * 조직의 전체 멤버십을 반환합니다.
 */
export function listMemberships(
  organizationId: string,
  options: ListQueryOptions = {}
): OrganizationMembership[] {
  assertOrganizationExists(organizationId);

  const normalizedSearch = normalizeSearch(options.search);
  let memberships: OrganizationMembership[] = [];

  for (const membership of membershipStore.values()) {
    if (membership.organizationId !== organizationId) {
      continue;
    }

    if (
      normalizedSearch &&
      !membership.userId.toLowerCase().includes(normalizedSearch) &&
      !membership.role.toLowerCase().includes(normalizedSearch)
    ) {
      continue;
    }

    memberships.push(cloneMembership(membership));
  }

  memberships = applyPagination(memberships, options);
  return memberships;
}

/**
 * 요청 경로 read 최적화(조직 멤버십 목록):
 * - DATA_BACKEND=postgres일 때 tenant-scoped direct query를 우선 사용
 * - 그 외(memory 포함)는 기존 인메모리 스토어를 사용
 */
export async function listMembershipsForTenantReadPath(
  params: TenantScopedReadOptions & {
    organizationId: string;
    search?: string;
    page?: number;
    limit?: number;
  }
): Promise<OrganizationMembership[]> {
  if (getActiveDataBackend() === "postgres") {
    const persistedMemberships = await listPersistedMembershipsForTenant({
      organizationId: params.organizationId,
      tenantId: params.tenantId,
      search: params.search,
      page: params.page,
      limit: params.limit,
      userId: params.userId,
      userRole: params.userRole,
    });

    if (persistedMemberships !== null) {
      return persistedMemberships;
    }
  }

  if (params.organizationId !== params.tenantId) {
    return [];
  }

  return listMemberships(params.organizationId, {
    search: params.search,
    page: params.page,
    limit: params.limit,
  });
}

/**
 * 사용자의 전체 멤버십을 반환합니다.
 */
export function listUserMemberships(userId: string): OrganizationMembership[] {
  const normalizedUserId = normalizeRequiredText(userId, "userId");

  const memberships: OrganizationMembership[] = [];
  for (const membership of membershipStore.values()) {
    if (membership.userId === normalizedUserId) {
      memberships.push(cloneMembership(membership));
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

  assertOrganizationWritable(organizationId);

  const key = membershipKey(organizationId, userId);
  const existingMembership = membershipStore.get(key);
  if (!existingMembership) {
    throw createTenantStoreError(
      404,
      "조직 멤버십을 찾을 수 없습니다",
      "TENANT_MEMBERSHIP_NOT_FOUND"
    );
  }

  if (existingMembership.role === "owner" && countOwnerMemberships(organizationId) <= 1) {
    throw createTenantStoreError(
      409,
      "조직에는 최소 1명의 owner가 필요합니다",
      "TENANT_OWNER_MIN_REQUIRED"
    );
  }

  membershipStore.delete(key);
  deletePersistedMembership(organizationId, userId);
  return cloneMembership(existingMembership);
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

  assertOrganizationWritable(organizationId);

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
  persistMembershipRecord(nextMembership);
  return cloneMembership(nextMembership);
}

/**
 * 조직 초대 토큰을 발급합니다.
 */
export function createOrganizationInviteToken(params: {
  organizationId: string;
  role: UserRole;
  expiresAt: string;
  email?: string;
  createdByUserId?: string;
}): OrganizationInviteToken {
  const organizationId = normalizeRequiredText(params.organizationId, "organizationId");
  const role = normalizeUserRole(params.role);
  const expiresAt = normalizeFutureIsoTimestamp(params.expiresAt);
  const email = normalizeOptionalEmail(params.email);
  const createdByUserId = normalizeOptionalText(params.createdByUserId);

  assertOrganizationWritable(organizationId);

  let token = generateInviteToken();
  while (inviteTokenStore.has(token)) {
    token = generateInviteToken();
  }

  const inviteToken: OrganizationInviteToken = {
    token,
    organizationId,
    role,
    email,
    createdByUserId,
    createdAt: new Date().toISOString(),
    expiresAt,
  };

  inviteTokenStore.set(token, inviteToken);
  persistOrganizationInviteTokenRecord(inviteToken);
  return cloneInviteToken(inviteToken);
}

/**
 * 토큰 문자열로 조직 초대 토큰을 조회합니다.
 */
export function getOrganizationInviteToken(token: string): OrganizationInviteToken | undefined {
  const normalizedToken = normalizeOptionalText(token);
  if (!normalizedToken) {
    return undefined;
  }

  const inviteToken = inviteTokenStore.get(normalizedToken);
  return inviteToken ? cloneInviteToken(inviteToken) : undefined;
}

/**
 * 초대 토큰을 수락해 조직 멤버십을 생성합니다.
 */
export function acceptOrganizationInviteToken(params: {
  token: string;
  userId: string;
  email?: string;
  expectedOrganizationId?: string;
}): {
  membership: OrganizationMembership;
  inviteToken: OrganizationInviteToken;
} {
  const token = normalizeRequiredText(params.token, "token");
  const userId = normalizeRequiredText(params.userId, "userId");
  const expectedOrganizationId = normalizeOptionalText(params.expectedOrganizationId);
  const providedEmail = normalizeOptionalEmail(params.email);

  const inviteToken = inviteTokenStore.get(token);
  if (!inviteToken) {
    throw createTenantStoreError(404, "초대 토큰을 찾을 수 없습니다", "TENANT_INVITE_NOT_FOUND");
  }

  if (expectedOrganizationId && inviteToken.organizationId !== expectedOrganizationId) {
    throw createTenantStoreError(404, "초대 토큰을 찾을 수 없습니다", "TENANT_INVITE_NOT_FOUND");
  }

  if (inviteToken.consumedAt) {
    throw createTenantStoreError(
      409,
      "이미 사용된 초대 토큰입니다",
      "TENANT_INVITE_ALREADY_USED"
    );
  }

  if (Date.parse(inviteToken.expiresAt) <= Date.now()) {
    throw createTenantStoreError(
      410,
      "만료된 초대 토큰입니다",
      "TENANT_INVITE_EXPIRED"
    );
  }

  if (inviteToken.email) {
    if (!providedEmail) {
      throw createTenantStoreError(
        400,
        "이 초대 토큰은 email 입력이 필요합니다",
        "TENANT_INVITE_EMAIL_REQUIRED"
      );
    }

    if (inviteToken.email !== providedEmail) {
      throw createTenantStoreError(
        403,
        "초대 토큰 email이 일치하지 않습니다",
        "TENANT_INVITE_EMAIL_MISMATCH"
      );
    }
  }

  const membership = createMembership({
    organizationId: inviteToken.organizationId,
    userId,
    role: inviteToken.role,
  });

  const consumedInviteToken: OrganizationInviteToken = {
    ...inviteToken,
    consumedAt: new Date().toISOString(),
    consumedByUserId: userId,
  };

  inviteTokenStore.set(consumedInviteToken.token, consumedInviteToken);
  persistOrganizationInviteTokenRecord(consumedInviteToken);

  return {
    membership: cloneMembership(membership),
    inviteToken: cloneInviteToken(consumedInviteToken),
  };
}

/**
 * 앱 시작 시점에 외부 저장소에서 읽어온 조직/멤버십/초대토큰으로 인메모리 스토어를 채웁니다.
 */
export function hydrateOrganizationStore(params: {
  organizations: Organization[];
  memberships: OrganizationMembership[];
  inviteTokens?: OrganizationInviteToken[];
}): void {
  orgStore.clear();
  membershipStore.clear();
  inviteTokenStore.clear();

  for (const organization of params.organizations) {
    orgStore.set(organization.id, cloneOrganization(organization));
  }

  for (const membership of params.memberships) {
    if (!orgStore.has(membership.organizationId)) {
      continue;
    }

    membershipStore.set(
      membershipKey(membership.organizationId, membership.userId),
      cloneMembership(membership)
    );
  }

  for (const inviteToken of params.inviteTokens ?? []) {
    if (!orgStore.has(inviteToken.organizationId)) {
      continue;
    }

    inviteTokenStore.set(inviteToken.token, cloneInviteToken(inviteToken));
  }

  bootstrapDefaultOrganization();
}

/**
 * 저장소를 초기화합니다. 테스트 전 상태 리셋 용도로만 사용합니다.
 * - 기본 조직은 항상 재부팅합니다.
 */
export function clearOrganizationStore(): void {
  orgStore.clear();
  membershipStore.clear();
  inviteTokenStore.clear();
  clearPersistedOrganizationsAndMemberships();
  bootstrapDefaultOrganization();
}

// 모듈 로드 시 기본 조직 자동 생성
bootstrapDefaultOrganization();
