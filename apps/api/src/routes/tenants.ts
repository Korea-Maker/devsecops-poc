import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  createMembership,
  createOrganization,
  getOrganization,
  listMemberships,
  listOrganizations,
  updateMembershipRole,
} from "../tenants/store.js";
import {
  getTenantAuthMode,
  requireMinimumRole,
  tenantAuthOnRequest,
} from "../tenants/auth.js";
import type { UserRole } from "../tenants/types.js";

const VALID_USER_ROLES = ["owner", "admin", "member", "viewer"] as const;
const VALID_USER_ROLE_SET: ReadonlySet<string> = new Set(VALID_USER_ROLES);

interface TenantRouteErrorBody {
  error: string;
  code?: string;
}

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
  app.get("/api/v1/organizations", async (request, reply) => {
    if (getTenantAuthMode() === "required") {
      const organization = getOrganization(request.tenantContext.tenantId);
      return reply.status(200).send(organization ? [organization] : []);
    }

    return reply.status(200).send(listOrganizations());
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

    if (getTenantAuthMode() === "required" && request.tenantContext.userId) {
      createMembership({
        organizationId: organization.id,
        userId: request.tenantContext.userId,
        role: "owner",
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

      const organization = getOrganization(request.params.id);
      if (!organization) {
        return sendError(reply, 404, "조직을 찾을 수 없습니다", "TENANT_ORG_NOT_FOUND");
      }

      return reply.status(200).send(organization);
    }
  );

  /** GET /api/v1/organizations/:id/memberships — 조직 멤버십 조회 */
  app.get<{ Params: { id: string } }>(
    "/api/v1/organizations/:id/memberships",
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

      return reply.status(200).send(listMemberships(request.params.id));
    }
  );

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

    return reply.status(200).send({ membership });
  });
};
