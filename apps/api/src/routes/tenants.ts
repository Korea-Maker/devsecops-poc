import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  acceptOrganizationInviteToken,
  createMembership,
  createOrganization,
  createOrganizationInviteToken,
  disableOrganization,
  getOrganization,
  getOrganizationForTenantReadPath,
  listOrganizationsForTenantReadPath,
  listMemberships,
  listMembershipsForTenantReadPath,
  listOrganizations,
  removeMembership,
  updateMembershipRole,
} from "../tenants/store.js";
import {
  createTenantAuditLog,
  isTenantAuditAction,
  listTenantAuditLogs,
  listTenantAuditLogsForTenantReadPath,
} from "../tenants/audit-log.js";
import type { TenantAuditAction } from "../tenants/audit-log.js";
import {
  getTenantAuthMode,
  requireMinimumRole,
  tenantAuthOnRequest,
} from "../tenants/auth.js";
import type { UserRole } from "../tenants/types.js";

const VALID_USER_ROLES = ["owner", "admin", "member", "viewer"] as const;
const VALID_USER_ROLE_SET: ReadonlySet<string> = new Set(VALID_USER_ROLES);

const DEFAULT_PAGINATION_PAGE = 1;
const DEFAULT_PAGINATION_LIMIT = 20;
const MAX_PAGINATION_LIMIT = 100;
const DEFAULT_INVITE_EXPIRES_MINUTES = 60;
const MIN_INVITE_EXPIRES_MINUTES = 5;
const MAX_INVITE_EXPIRES_MINUTES = 60 * 24 * 7;

interface TenantRouteErrorBody {
  error: string;
  code?: string;
}

interface ListQueryOptions {
  search?: string;
  page?: number;
  limit?: number;
}

interface ParsedListQuerySuccess {
  ok: true;
  options: ListQueryOptions;
}

interface ParsedListQueryFailure {
  ok: false;
  error: string;
  code: string;
}

type ParsedListQueryResult = ParsedListQuerySuccess | ParsedListQueryFailure;

interface ParsedOptionalTextSuccess {
  ok: true;
  value?: string;
}

interface ParsedOptionalTextFailure {
  ok: false;
  error: string;
  code: string;
}

type ParsedOptionalTextResult = ParsedOptionalTextSuccess | ParsedOptionalTextFailure;

interface AuditLogQueryOptions {
  limit: number;
  action?: TenantAuditAction;
  userId?: string;
  since?: string;
  until?: string;
}

interface ParsedAuditLogQuerySuccess {
  ok: true;
  options: AuditLogQueryOptions;
}

interface ParsedAuditLogQueryFailure {
  ok: false;
  error: string;
  code: string;
}

type ParsedAuditLogQueryResult = ParsedAuditLogQuerySuccess | ParsedAuditLogQueryFailure;

function sendError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  code?: string
) {
  const body: TenantRouteErrorBody = { error };
  if (code) {
    body.code = code;
  }
  return reply.status(statusCode).send(body);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && VALID_USER_ROLE_SET.has(value);
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toClientErrorStatusCode(error: unknown): number | null {
  const errorRecord = toObjectRecord(error);
  if (!errorRecord || typeof errorRecord.statusCode !== "number") {
    return null;
  }

  if (errorRecord.statusCode < 400 || errorRecord.statusCode > 499) {
    return null;
  }

  return errorRecord.statusCode;
}

function toErrorCode(error: unknown): string | undefined {
  const errorRecord = toObjectRecord(error);
  if (!errorRecord || typeof errorRecord.code !== "string") {
    return undefined;
  }
  return errorRecord.code;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  const errorRecord = toObjectRecord(error);
  if (errorRecord && typeof errorRecord.message === "string") {
    return errorRecord.message;
  }

  return "요청 처리 중 오류가 발생했습니다";
}

function ensureTenantScope(
  reply: FastifyReply,
  requestTenantId: string,
  targetOrganizationId: string
): boolean {
  if (getTenantAuthMode() !== "required") {
    return true;
  }

  if (requestTenantId === targetOrganizationId) {
    return true;
  }

  void sendError(reply, 404, "조직을 찾을 수 없습니다", "TENANT_ORG_NOT_FOUND");
  return false;
}

function ensureOrganizationWritable(reply: FastifyReply, organizationId: string): boolean {
  const organization = getOrganization(organizationId);
  if (!organization) {
    void sendError(reply, 404, "조직을 찾을 수 없습니다", "TENANT_ORG_NOT_FOUND");
    return false;
  }

  if (!organization.active) {
    void sendError(
      reply,
      409,
      "비활성화된 조직에는 변경 작업을 수행할 수 없습니다",
      "TENANT_ORG_DISABLED"
    );
    return false;
  }

  return true;
}

function parseAuditLimit(rawLimit: unknown): number | null {
  if (rawLimit === undefined) {
    return 50;
  }

  if (typeof rawLimit !== "string") {
    return null;
  }

  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    return null;
  }

  return parsed;
}

function parseOptionalAuditTimestamp(rawValue: unknown): string | null | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  if (typeof rawValue !== "string") {
    return null;
  }

  const normalized = rawValue.trim();
  if (normalized.length === 0) {
    return null;
  }

  const parsedMs = Date.parse(normalized);
  if (Number.isNaN(parsedMs)) {
    return null;
  }

  return new Date(parsedMs).toISOString();
}

function parseAuditLogQuery(query: {
  limit?: unknown;
  action?: unknown;
  userId?: unknown;
  since?: unknown;
  until?: unknown;
}): ParsedAuditLogQueryResult {
  const limit = parseAuditLimit(query.limit);
  if (limit === null) {
    return {
      ok: false,
      error: "limit은 1~100 범위의 정수여야 합니다",
      code: "TENANT_INVALID_LIMIT",
    };
  }

  let action: TenantAuditAction | undefined;
  if (query.action !== undefined) {
    if (typeof query.action !== "string") {
      return {
        ok: false,
        error: "action은 문자열이어야 합니다",
        code: "TENANT_INVALID_AUDIT_ACTION",
      };
    }

    const normalizedAction = query.action.trim();
    if (!isTenantAuditAction(normalizedAction)) {
      return {
        ok: false,
        error: "지원하지 않는 action입니다",
        code: "TENANT_INVALID_AUDIT_ACTION",
      };
    }

    action = normalizedAction;
  }

  let userId: string | undefined;
  if (query.userId !== undefined) {
    if (typeof query.userId !== "string") {
      return {
        ok: false,
        error: "userId는 문자열이어야 합니다",
        code: "TENANT_INVALID_AUDIT_USER_ID",
      };
    }

    const normalizedUserId = query.userId.trim();
    if (normalizedUserId.length === 0) {
      return {
        ok: false,
        error: "userId는 비어 있을 수 없습니다",
        code: "TENANT_INVALID_AUDIT_USER_ID",
      };
    }

    userId = normalizedUserId;
  }

  const since = parseOptionalAuditTimestamp(query.since);
  if (since === null) {
    return {
      ok: false,
      error: "since는 유효한 날짜/시간 문자열이어야 합니다",
      code: "TENANT_INVALID_AUDIT_TIME",
    };
  }

  const until = parseOptionalAuditTimestamp(query.until);
  if (until === null) {
    return {
      ok: false,
      error: "until은 유효한 날짜/시간 문자열이어야 합니다",
      code: "TENANT_INVALID_AUDIT_TIME",
    };
  }

  if (since && until && Date.parse(since) > Date.parse(until)) {
    return {
      ok: false,
      error: "since는 until보다 클 수 없습니다",
      code: "TENANT_INVALID_AUDIT_TIME_RANGE",
    };
  }

  return {
    ok: true,
    options: {
      limit,
      action,
      userId,
      since,
      until,
    },
  };
}

function parseIntegerQuery(
  value: unknown,
  options: {
    defaultValue: number;
    min: number;
    max: number;
  }
): number | null {
  if (value === undefined) {
    return options.defaultValue;
  }

  let parsed: number | null = null;

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) {
      return null;
    }
    parsed = Number.parseInt(normalized, 10);
  } else if (typeof value === "number" && Number.isInteger(value)) {
    parsed = value;
  }

  if (parsed === null) {
    return null;
  }

  if (parsed < options.min || parsed > options.max) {
    return null;
  }

  return parsed;
}

function parseListQuery(query: {
  page?: unknown;
  limit?: unknown;
  search?: unknown;
}): ParsedListQueryResult {
  let search: string | undefined;
  if (query.search !== undefined) {
    if (typeof query.search !== "string") {
      return {
        ok: false,
        error: "search는 문자열이어야 합니다",
        code: "TENANT_INVALID_SEARCH",
      };
    }

    const normalizedSearch = query.search.trim();
    search = normalizedSearch.length > 0 ? normalizedSearch : undefined;
  }

  const hasPaginationQuery = query.page !== undefined || query.limit !== undefined;
  if (!hasPaginationQuery) {
    return {
      ok: true,
      options: { search },
    };
  }

  const page = parseIntegerQuery(query.page, {
    defaultValue: DEFAULT_PAGINATION_PAGE,
    min: 1,
    max: 100_000,
  });
  const limit = parseIntegerQuery(query.limit, {
    defaultValue: DEFAULT_PAGINATION_LIMIT,
    min: 1,
    max: MAX_PAGINATION_LIMIT,
  });

  if (page === null || limit === null) {
    return {
      ok: false,
      error: `page는 1 이상의 정수, limit은 1~${MAX_PAGINATION_LIMIT} 정수여야 합니다`,
      code: "TENANT_INVALID_PAGINATION",
    };
  }

  return {
    ok: true,
    options: {
      search,
      page,
      limit,
    },
  };
}

function parseOptionalNonEmptyText(
  value: unknown,
  fieldName: string,
  code: string
): ParsedOptionalTextResult {
  if (value === undefined) {
    return { ok: true };
  }

  if (typeof value !== "string") {
    return {
      ok: false,
      error: `${fieldName}는 문자열이어야 합니다`,
      code,
    };
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return {
      ok: false,
      error: `${fieldName}는 비어 있을 수 없습니다`,
      code,
    };
  }

  return {
    ok: true,
    value: normalized,
  };
}

function parseInviteExpiryMinutes(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_INVITE_EXPIRES_MINUTES;
  }

  const parsed = parseIntegerQuery(value, {
    defaultValue: DEFAULT_INVITE_EXPIRES_MINUTES,
    min: MIN_INVITE_EXPIRES_MINUTES,
    max: MAX_INVITE_EXPIRES_MINUTES,
  });

  return parsed;
}

export const tenantRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", tenantAuthOnRequest);

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    if (reply.sent) {
      return;
    }

    const clientErrorStatusCode = toClientErrorStatusCode(error);
    if (clientErrorStatusCode !== null) {
      void sendError(
        reply,
        clientErrorStatusCode,
        toErrorMessage(error),
        toErrorCode(error)
      );
      return;
    }

    void sendError(
      reply,
      500,
      "테넌트 API 처리 중 오류가 발생했습니다",
      "TENANT_ROUTE_INTERNAL_ERROR"
    );
  });

  /** GET /api/v1/organizations — 조직 목록 조회 */
  app.get<{
    Querystring: { page?: string; limit?: string; search?: string };
  }>("/api/v1/organizations", async (request, reply) => {
    const listQuery = parseListQuery(request.query);
    if (!listQuery.ok) {
      return sendError(reply, 400, listQuery.error, listQuery.code);
    }

    if (getTenantAuthMode() === "required") {
      const organizations = await listOrganizationsForTenantReadPath({
        tenantId: request.tenantContext.tenantId,
        search: listQuery.options.search,
        page: listQuery.options.page,
        limit: listQuery.options.limit,
        userId: request.tenantContext.userId,
        userRole: request.tenantContext.role,
      });

      return reply.status(200).send(organizations);
    }

    return reply.status(200).send(listOrganizations(listQuery.options));
  });

  /** POST /api/v1/organizations — 조직 생성 */
  app.post<{
    Body: { name?: unknown; slug?: unknown };
  }>("/api/v1/organizations", async (request, reply) => {
    if (!requireMinimumRole(request, reply, "admin")) {
      return;
    }

    const { name, slug } = request.body;
    if (!isNonEmptyString(name)) {
      return sendError(
        reply,
        400,
        "name은 비어 있을 수 없습니다",
        "TENANT_INVALID_NAME"
      );
    }

    if (!isNonEmptyString(slug)) {
      return sendError(
        reply,
        400,
        "slug는 비어 있을 수 없습니다",
        "TENANT_INVALID_SLUG"
      );
    }

    const organization = createOrganization({ name, slug });

    createTenantAuditLog({
      organizationId: organization.id,
      actorUserId: request.tenantContext.userId,
      action: "organization.created",
      details: {
        name: organization.name,
        slug: organization.slug,
      },
    });

    if (getTenantAuthMode() === "required" && request.tenantContext.userId) {
      createMembership({
        organizationId: organization.id,
        userId: request.tenantContext.userId,
        role: "owner",
      });

      createTenantAuditLog({
        organizationId: organization.id,
        actorUserId: request.tenantContext.userId,
        action: "membership.created",
        targetUserId: request.tenantContext.userId,
        details: { role: "owner" },
      });
    }

    return reply.status(201).send({ organization });
  });

  /** GET /api/v1/organizations/:id — 단일 조직 조회 */
  app.get<{ Params: { id: string } }>(
    "/api/v1/organizations/:id",
    async (request, reply) => {
      if (
        !ensureTenantScope(
          reply,
          request.tenantContext.tenantId,
          request.params.id
        )
      ) {
        return;
      }

      const organization =
        getTenantAuthMode() === "required"
          ? await getOrganizationForTenantReadPath({
              id: request.params.id,
              tenantId: request.tenantContext.tenantId,
              userId: request.tenantContext.userId,
              userRole: request.tenantContext.role,
            })
          : getOrganization(request.params.id);
      if (!organization) {
        return sendError(reply, 404, "조직을 찾을 수 없습니다", "TENANT_ORG_NOT_FOUND");
      }

      return reply.status(200).send(organization);
    }
  );

  /** POST /api/v1/organizations/:id/disable — 조직 비활성화 */
  app.post<{ Params: { id: string } }>(
    "/api/v1/organizations/:id/disable",
    async (request, reply) => {
      if (!requireMinimumRole(request, reply, "admin")) {
        return;
      }

      if (
        !ensureTenantScope(
          reply,
          request.tenantContext.tenantId,
          request.params.id
        )
      ) {
        return;
      }

      const organization = disableOrganization(request.params.id);
      return reply.status(200).send({ organization });
    }
  );

  /** GET /api/v1/organizations/:id/memberships — 조직 멤버십 조회 */
  app.get<{
    Params: { id: string };
    Querystring: { page?: string; limit?: string; search?: string };
  }>("/api/v1/organizations/:id/memberships", async (request, reply) => {
    if (!requireMinimumRole(request, reply, "admin")) {
      return;
    }

    if (
      !ensureTenantScope(
        reply,
        request.tenantContext.tenantId,
        request.params.id
      )
    ) {
      return;
    }

    const listQuery = parseListQuery(request.query);
    if (!listQuery.ok) {
      return sendError(reply, 400, listQuery.error, listQuery.code);
    }

    if (getTenantAuthMode() === "required") {
      const memberships = await listMembershipsForTenantReadPath({
        organizationId: request.params.id,
        tenantId: request.tenantContext.tenantId,
        search: listQuery.options.search,
        page: listQuery.options.page,
        limit: listQuery.options.limit,
        userId: request.tenantContext.userId,
        userRole: request.tenantContext.role,
      });
      return reply.status(200).send(memberships);
    }

    return reply.status(200).send(listMemberships(request.params.id, listQuery.options));
  });

  /** POST /api/v1/organizations/:id/memberships — 조직 멤버 추가 */
  app.post<{
    Params: { id: string };
    Body: { userId?: unknown; role?: unknown };
  }>("/api/v1/organizations/:id/memberships", async (request, reply) => {
    if (!requireMinimumRole(request, reply, "admin")) {
      return;
    }

    if (
      !ensureTenantScope(
        reply,
        request.tenantContext.tenantId,
        request.params.id
      )
    ) {
      return;
    }

    if (!ensureOrganizationWritable(reply, request.params.id)) {
      return;
    }

    const { userId, role } = request.body;
    if (!isNonEmptyString(userId)) {
      return sendError(
        reply,
        400,
        "userId는 비어 있을 수 없습니다",
        "TENANT_INVALID_USERID"
      );
    }

    if (!isUserRole(role)) {
      return sendError(
        reply,
        400,
        `role은 ${VALID_USER_ROLES.join(", ")} 중 하나여야 합니다`,
        "TENANT_INVALID_ROLE"
      );
    }

    const membership = createMembership({
      organizationId: request.params.id,
      userId,
      role,
    });

    createTenantAuditLog({
      organizationId: request.params.id,
      actorUserId: request.tenantContext.userId,
      action: "membership.created",
      targetUserId: membership.userId,
      details: {
        role: membership.role,
      },
    });

    return reply.status(201).send({ membership });
  });

  /** PATCH /api/v1/organizations/:id/memberships/:userId — 조직 멤버 역할 수정 */
  app.patch<{
    Params: { id: string; userId: string };
    Body: { role?: unknown };
  }>("/api/v1/organizations/:id/memberships/:userId", async (request, reply) => {
    if (!requireMinimumRole(request, reply, "admin")) {
      return;
    }

    if (
      !ensureTenantScope(
        reply,
        request.tenantContext.tenantId,
        request.params.id
      )
    ) {
      return;
    }

    if (!ensureOrganizationWritable(reply, request.params.id)) {
      return;
    }

    if (!isUserRole(request.body.role)) {
      return sendError(
        reply,
        400,
        `role은 ${VALID_USER_ROLES.join(", ")} 중 하나여야 합니다`,
        "TENANT_INVALID_ROLE"
      );
    }

    const membership = updateMembershipRole({
      organizationId: request.params.id,
      userId: request.params.userId,
      role: request.body.role,
    });

    createTenantAuditLog({
      organizationId: request.params.id,
      actorUserId: request.tenantContext.userId,
      action: "membership.role_updated",
      targetUserId: membership.userId,
      details: {
        role: membership.role,
      },
    });

    return reply.status(200).send({ membership });
  });

  /** DELETE /api/v1/organizations/:id/memberships/:userId — 조직 멤버 제거 */
  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/v1/organizations/:id/memberships/:userId",
    async (request, reply) => {
      if (!requireMinimumRole(request, reply, "admin")) {
        return;
      }

      if (
        !ensureTenantScope(
          reply,
          request.tenantContext.tenantId,
          request.params.id
        )
      ) {
        return;
      }

      if (!ensureOrganizationWritable(reply, request.params.id)) {
        return;
      }

      const membership = removeMembership({
        organizationId: request.params.id,
        userId: request.params.userId,
      });

      createTenantAuditLog({
        organizationId: request.params.id,
        actorUserId: request.tenantContext.userId,
        action: "membership.deleted",
        targetUserId: membership.userId,
        details: {
          role: membership.role,
        },
      });

      return reply.status(200).send({ membership });
    }
  );

  /** POST /api/v1/organizations/:id/invite-tokens — 조직 멤버 초대 토큰 생성 */
  app.post<{
    Params: { id: string };
    Body: { role?: unknown; email?: unknown; expiresInMinutes?: unknown };
  }>("/api/v1/organizations/:id/invite-tokens", async (request, reply) => {
    if (!requireMinimumRole(request, reply, "admin")) {
      return;
    }

    if (
      !ensureTenantScope(
        reply,
        request.tenantContext.tenantId,
        request.params.id
      )
    ) {
      return;
    }

    if (!ensureOrganizationWritable(reply, request.params.id)) {
      return;
    }

    if (!isUserRole(request.body.role)) {
      return sendError(
        reply,
        400,
        `role은 ${VALID_USER_ROLES.join(", ")} 중 하나여야 합니다`,
        "TENANT_INVALID_ROLE"
      );
    }

    const parsedEmail = parseOptionalNonEmptyText(
      request.body.email,
      "email",
      "TENANT_INVALID_EMAIL"
    );
    if (!parsedEmail.ok) {
      return sendError(reply, 400, parsedEmail.error, parsedEmail.code);
    }

    const expiresInMinutes = parseInviteExpiryMinutes(request.body.expiresInMinutes);
    if (expiresInMinutes === null) {
      return sendError(
        reply,
        400,
        `expiresInMinutes는 ${MIN_INVITE_EXPIRES_MINUTES}~${MAX_INVITE_EXPIRES_MINUTES} 범위의 정수여야 합니다`,
        "TENANT_INVALID_EXPIRES_IN_MINUTES"
      );
    }

    const inviteToken = createOrganizationInviteToken({
      organizationId: request.params.id,
      role: request.body.role,
      email: parsedEmail.value,
      createdByUserId: request.tenantContext.userId,
      expiresAt: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
    });

    return reply.status(201).send({ inviteToken });
  });

  /** POST /api/v1/organizations/invite-tokens/accept — 조직 멤버 초대 토큰 수락 */
  app.post<{
    Body: { token?: unknown; userId?: unknown; email?: unknown };
  }>("/api/v1/organizations/invite-tokens/accept", async (request, reply) => {
    if (!requireMinimumRole(request, reply, "viewer")) {
      return;
    }

    if (!isNonEmptyString(request.body.token)) {
      return sendError(
        reply,
        400,
        "token은 비어 있을 수 없습니다",
        "TENANT_INVALID_TOKEN"
      );
    }

    const parsedEmail = parseOptionalNonEmptyText(
      request.body.email,
      "email",
      "TENANT_INVALID_EMAIL"
    );
    if (!parsedEmail.ok) {
      return sendError(reply, 400, parsedEmail.error, parsedEmail.code);
    }

    const fallbackUserId = parseOptionalNonEmptyText(
      request.body.userId,
      "userId",
      "TENANT_INVALID_USERID"
    );
    if (!fallbackUserId.ok) {
      return sendError(reply, 400, fallbackUserId.error, fallbackUserId.code);
    }

    const userId = request.tenantContext.userId ?? fallbackUserId.value;
    if (!userId) {
      return sendError(
        reply,
        400,
        "userId는 비어 있을 수 없습니다",
        "TENANT_INVITE_USER_ID_REQUIRED"
      );
    }

    const expectedOrganizationId =
      getTenantAuthMode() === "required" ? request.tenantContext.tenantId : undefined;

    const accepted = acceptOrganizationInviteToken({
      token: request.body.token,
      userId,
      email: parsedEmail.value,
      expectedOrganizationId,
    });

    createTenantAuditLog({
      organizationId: accepted.membership.organizationId,
      actorUserId: request.tenantContext.userId,
      action: "membership.created",
      targetUserId: accepted.membership.userId,
      details: {
        role: accepted.membership.role,
        source: "invite_token",
      },
    });

    return reply.status(201).send({ membership: accepted.membership });
  });

  /** GET /api/v1/organizations/:id/audit-logs — 조직 감사 로그 조회 */
  app.get<{
    Params: { id: string };
    Querystring: {
      limit?: string;
      action?: string;
      userId?: string;
      since?: string;
      until?: string;
    };
  }>("/api/v1/organizations/:id/audit-logs", async (request, reply) => {
    if (!requireMinimumRole(request, reply, "admin")) {
      return;
    }

    if (
      !ensureTenantScope(
        reply,
        request.tenantContext.tenantId,
        request.params.id
      )
    ) {
      return;
    }

    const parsedAuditQuery = parseAuditLogQuery(request.query);
    if (!parsedAuditQuery.ok) {
      return sendError(reply, 400, parsedAuditQuery.error, parsedAuditQuery.code);
    }

    const logs =
      getTenantAuthMode() === "required"
        ? await listTenantAuditLogsForTenantReadPath({
            organizationId: request.params.id,
            tenantId: request.tenantContext.tenantId,
            tenantUserId: request.tenantContext.userId,
            userRole: request.tenantContext.role,
            ...parsedAuditQuery.options,
          })
        : listTenantAuditLogs({
            organizationId: request.params.id,
            ...parsedAuditQuery.options,
          });
    return reply.status(200).send(logs);
  });
};
