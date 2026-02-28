import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { classifyRepoUrlInput, normalizeRepoUrlInput } from "../scanner/source-prep.js";
import {
  enqueueScan,
  getQueueStatus,
  listDeadLetters,
  processNextScanJob,
  redriveDeadLetter,
} from "../scanner/queue.js";
import { createScan, getScan, listScans } from "../scanner/store.js";
import type { ScanEngineType, ScanStatus } from "../scanner/types.js";
import {
  getTenantAuthMode,
  requireMinimumRole,
  tenantAuthOnRequest,
} from "../tenants/auth.js";

/** 유효한 스캔 엔진 목록 */
const VALID_ENGINES = ["semgrep", "trivy", "gitleaks"] as const;
const VALID_ENGINE_SET: ReadonlySet<string> = new Set(VALID_ENGINES);

/** 유효한 스캔 상태 목록 */
const VALID_STATUSES = ["queued", "running", "completed", "failed"] as const;
const VALID_STATUS_SET: ReadonlySet<string> = new Set(VALID_STATUSES);

interface ScanRouteErrorBody {
  error: string;
  code?: string;
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  code?: string
) {
  const body: ScanRouteErrorBody = { error };
  if (code) {
    body.code = code;
  }
  return reply.status(statusCode).send(body);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isScanEngineType(value: unknown): value is ScanEngineType {
  return typeof value === "string" && VALID_ENGINE_SET.has(value);
}

function isScanStatus(value: unknown): value is ScanStatus {
  return typeof value === "string" && VALID_STATUS_SET.has(value);
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

function getOptionalTenantFilter(
  request: FastifyRequest
): { tenantId: string } | undefined {
  if (getTenantAuthMode() !== "required") {
    return undefined;
  }

  return { tenantId: request.tenantContext.tenantId };
}

export const scanRoutes: FastifyPluginAsync = async (app) => {
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
      "스캔 API 처리 중 오류가 발생했습니다",
      "SCAN_ROUTE_INTERNAL_ERROR"
    );
  });

  /** POST /api/v1/scans — 새 스캔 요청 생성 */
  app.post<{
    Body: { engine?: unknown; repoUrl?: unknown; branch?: unknown };
  }>("/api/v1/scans", async (request, reply) => {
    const { engine, repoUrl, branch } = request.body;

    // engine 검증: 필수값이며 허용된 엔진 목록 중 하나여야 함
    if (!isScanEngineType(engine)) {
      return sendError(
        reply,
        400,
        `engine은 ${VALID_ENGINES.join(", ")} 중 하나여야 합니다`,
        "SCAN_INVALID_ENGINE"
      );
    }

    // repoUrl 검증: source-prep과 동일 계약 사용
    if (!isNonEmptyString(repoUrl) || (await classifyRepoUrlInput(repoUrl)) === "unsupported") {
      return sendError(
        reply,
        400,
        "repoUrl은 로컬 디렉터리 경로 또는 http/https/ssh/file://, git@... 형식이어야 합니다",
        "SCAN_INVALID_REPO_URL"
      );
    }

    const record = createScan({
      tenantId: request.tenantContext.tenantId,
      engine,
      repoUrl: normalizeRepoUrlInput(repoUrl),
      branch: isNonEmptyString(branch) ? branch.trim() : "main",
    });
    enqueueScan(record.id);

    return reply.status(202).send({ scanId: record.id, status: record.status });
  });

  /** GET /api/v1/scans — 스캔 목록 조회 (status 쿼리 파라미터로 필터 가능) */
  app.get<{ Querystring: { status?: string } }>(
    "/api/v1/scans",
    async (request, reply) => {
      const { status } = request.query;

      // 유효하지 않은 status 값은 무시하고 전체 반환
      const validStatus = isScanStatus(status) ? status : undefined;

      const scans = listScans({
        tenantId: request.tenantContext.tenantId,
        status: validStatus,
      });
      return reply.status(200).send(scans);
    }
  );

  /** GET /api/v1/scans/queue/status — 큐 운영 상태 요약 조회 */
  app.get("/api/v1/scans/queue/status", async (request, reply) => {
    if (!requireMinimumRole(request, reply, "admin")) {
      return;
    }

    return reply.status(200).send(getQueueStatus(getOptionalTenantFilter(request)));
  });

  /** POST /api/v1/scans/queue/process-next — 즉시 다음 작업 1건 처리 트리거 */
  app.post("/api/v1/scans/queue/process-next", async (request, reply) => {
    if (!requireMinimumRole(request, reply, "admin")) {
      return;
    }

    try {
      const processResult = await processNextScanJob(getOptionalTenantFilter(request));
      return reply.status(200).send(processResult);
    } catch (error) {
      app.log.error(error, "[scans] queue/process-next 처리 실패");
      return sendError(
        reply,
        500,
        "큐 작업 수동 처리 중 오류가 발생했습니다",
        "SCAN_QUEUE_PROCESS_NEXT_FAILED"
      );
    }
  });

  /** GET /api/v1/scans/dead-letters — dead-letter 목록 조회 */
  app.get("/api/v1/scans/dead-letters", async (request, reply) => {
    if (!requireMinimumRole(request, reply, "admin")) {
      return;
    }

    return reply.status(200).send(listDeadLetters(getOptionalTenantFilter(request)));
  });

  /** POST /api/v1/scans/:id/redrive — dead-letter 재처리 요청 */
  app.post<{ Params: { id: string } }>(
    "/api/v1/scans/:id/redrive",
    async (request, reply) => {
      if (!requireMinimumRole(request, reply, "admin")) {
        return;
      }

      const scanId = request.params.id;
      const redriveResult = redriveDeadLetter(scanId, getOptionalTenantFilter(request));

      if (redriveResult === "accepted") {
        return reply.status(202).send({ scanId, status: "queued" });
      }

      if (redriveResult === "not_found") {
        return sendError(
          reply,
          404,
          "dead-letter 항목을 찾을 수 없습니다",
          "DEAD_LETTER_NOT_FOUND"
        );
      }

      return sendError(
        reply,
        409,
        "dead-letter 항목은 존재하지만 scan 레코드가 없어 재처리할 수 없습니다(orphaned_scan)",
        "DEAD_LETTER_ORPHANED_SCAN"
      );
    }
  );

  /** GET /api/v1/scans/:id — 단일 스캔 조회 (완료 상태면 findings 요약 포함) */
  app.get<{ Params: { id: string } }>(
    "/api/v1/scans/:id",
    async (request, reply) => {
      const scan = getScan(request.params.id);
      if (!scan || scan.tenantId !== request.tenantContext.tenantId) {
        return sendError(reply, 404, "스캔을 찾을 수 없습니다", "SCAN_NOT_FOUND");
      }
      return reply.status(200).send(scan);
    }
  );
};
