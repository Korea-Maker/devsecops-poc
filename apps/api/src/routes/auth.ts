import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCodeForTokens,
  verifyGoogleIdToken,
} from "../auth/google-oidc.js";
import { consumeOAuthState, createOAuthState } from "../auth/oauth-state.js";
import {
  configurePlatformJwtLogger,
  getPlatformJwks,
  issuePlatformAccessToken,
} from "../auth/platform-jwt.js";
import { listUserMemberships } from "../tenants/store.js";
import type { OrganizationMembership } from "../tenants/types.js";

interface AuthRouteErrorBody {
  error: string;
  code?: string;
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  code?: string
) {
  const body: AuthRouteErrorBody = { error };
  if (code) {
    body.code = code;
  }
  return reply.status(statusCode).send(body);
}

function readNonEmptyQueryString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
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

  if (errorRecord.statusCode < 400 || errorRecord.statusCode > 599) {
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

  return "인증 처리 중 오류가 발생했습니다";
}

function resolveMembershipCandidates(params: {
  email?: string;
  subject: string;
}): OrganizationMembership[] {
  const bySubject = listUserMemberships(params.subject);
  if (bySubject.length > 0) {
    return bySubject;
  }

  if (!params.email) {
    return [];
  }

  return listUserMemberships(params.email);
}

function selectMembership(params: {
  memberships: OrganizationMembership[];
  tenantId?: string;
}): OrganizationMembership | undefined {
  if (params.memberships.length === 1) {
    return params.memberships[0];
  }

  if (params.memberships.length === 0 || !params.tenantId) {
    return undefined;
  }

  return params.memberships.find(
    (membership) => membership.organizationId === params.tenantId
  );
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  configurePlatformJwtLogger(app.log);

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

    void sendError(reply, 500, "인증 API 처리 중 오류가 발생했습니다", "AUTH_ROUTE_INTERNAL_ERROR");
  });

  app.get("/api/v1/auth/jwks", async (_request, reply) => {
    const jwks = await getPlatformJwks();
    return reply.status(200).send(jwks);
  });

  app.get("/api/v1/auth/google/start", async (_request, reply) => {
    const { nonce, state } = createOAuthState();
    const authorizationUrl = buildGoogleAuthorizationUrl({ nonce, state });

    return reply.status(200).send({
      authorizationUrl,
      state,
    });
  });

  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      tenantId?: string;
    };
  }>("/api/v1/auth/google/callback", async (request, reply) => {
    const code = readNonEmptyQueryString(request.query.code);
    if (!code) {
      return sendError(reply, 400, "code query가 필요합니다", "AUTH_CODE_REQUIRED");
    }

    const state = readNonEmptyQueryString(request.query.state);
    if (!state) {
      return sendError(reply, 400, "state query가 필요합니다", "AUTH_STATE_REQUIRED");
    }

    const stateContext = consumeOAuthState(state);
    if (!stateContext) {
      return sendError(reply, 400, "유효한 state가 아닙니다", "AUTH_INVALID_STATE");
    }

    const tenantId = readNonEmptyQueryString(request.query.tenantId);
    const tokenResponse = await exchangeGoogleCodeForTokens({ code });
    const identity = await verifyGoogleIdToken({
      idToken: tokenResponse.idToken,
      nonce: stateContext.nonce,
    });

    const memberships = resolveMembershipCandidates({
      email: identity.email,
      subject: identity.sub,
    });
    if (memberships.length === 0) {
      return sendError(
        reply,
        403,
        "사용자 멤버십을 찾을 수 없습니다",
        "AUTH_MEMBERSHIP_NOT_FOUND"
      );
    }

    if (memberships.length > 1 && !tenantId) {
      return sendError(
        reply,
        400,
        "복수 멤버십 사용자는 tenantId query가 필요합니다",
        "AUTH_TENANT_ID_REQUIRED"
      );
    }

    const membership = selectMembership({
      memberships,
      tenantId,
    });
    if (!membership) {
      return sendError(
        reply,
        403,
        "요청 tenantId에 해당하는 멤버십이 없습니다",
        "AUTH_TENANT_MEMBERSHIP_NOT_FOUND"
      );
    }

    const issuedToken = await issuePlatformAccessToken({
      role: membership.role,
      tenantId: membership.organizationId,
      userId: membership.userId,
    });

    return reply.status(200).send({
      accessToken: issuedToken.accessToken,
      expiresIn: issuedToken.expiresIn,
      tokenType: "Bearer",
    });
  });
};

