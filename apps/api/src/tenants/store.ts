import { randomUUID } from "crypto";
import { DEFAULT_TENANT_ID, type Organization } from "./types.js";

interface TenantStoreError extends Error {
  code: string;
  statusCode: number;
}

const DEFAULT_ORG_NAME = "Default Organization";
const DEFAULT_ORG_SLUG = "default";

/** 인메모리 조직 저장소 */
const orgStore = new Map<string, Organization>();

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

function normalizeRequiredText(value: string, field: "name" | "slug"): string {
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

function hasOrganizationBySlug(slug: string): boolean {
  for (const organization of orgStore.values()) {
    if (organization.slug === slug) {
      return true;
    }
  }
  return false;
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
 * 저장소를 초기화합니다. 테스트 전 상태 리셋 용도로만 사용합니다.
 * - 기본 조직은 항상 재부팅합니다.
 */
export function clearOrganizationStore(): void {
  orgStore.clear();
  bootstrapDefaultOrganization();
}

// 모듈 로드 시 기본 조직 자동 생성
bootstrapDefaultOrganization();
