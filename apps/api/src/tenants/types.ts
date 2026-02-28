/** 기본 테넌트 ID (인증 미설정 시 사용) */
export const DEFAULT_TENANT_ID = "default";

/** 사용자 역할 */
export type UserRole = "owner" | "admin" | "member" | "viewer";

/** 조직 (테넌트) 모델 */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  createdAt: string;
  disabledAt?: string;
}

/** 조직 멤버십 모델 */
export interface OrganizationMembership {
  organizationId: string;
  userId: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

/** 조직 초대 토큰 모델 */
export interface OrganizationInviteToken {
  token: string;
  organizationId: string;
  role: UserRole;
  email?: string;
  createdByUserId?: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  consumedByUserId?: string;
}

/** 요청별 테넌트 컨텍스트 */
export interface TenantContext {
  tenantId: string;
  userId?: string;
  role?: UserRole;
}
