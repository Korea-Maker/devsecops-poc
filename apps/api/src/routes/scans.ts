import type { FastifyPluginAsync } from "fastify";
import { classifyRepoUrlInput, normalizeRepoUrlInput } from "../scanner/source-prep.js";
import { enqueueScan, listDeadLetters, redriveDeadLetter } from "../scanner/queue.js";
import { createScan, getScan, listScans } from "../scanner/store.js";
import type { ScanEngineType, ScanStatus } from "../scanner/types.js";

/** 유효한 스캔 엔진 목록 */
const VALID_ENGINES = ["semgrep", "trivy", "gitleaks"] as const;
const VALID_ENGINE_SET: ReadonlySet<string> = new Set(VALID_ENGINES);

/** 유효한 스캔 상태 목록 */
const VALID_STATUSES = ["queued", "running", "completed", "failed"] as const;
const VALID_STATUS_SET: ReadonlySet<string> = new Set(VALID_STATUSES);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isScanEngineType(value: unknown): value is ScanEngineType {
  return typeof value === "string" && VALID_ENGINE_SET.has(value);
}

function isScanStatus(value: unknown): value is ScanStatus {
  return typeof value === "string" && VALID_STATUS_SET.has(value);
}

export const scanRoutes: FastifyPluginAsync = async (app) => {
  /** POST /api/v1/scans — 새 스캔 요청 생성 */
  app.post<{
    Body: { engine?: unknown; repoUrl?: unknown; branch?: unknown };
  }>("/api/v1/scans", async (request, reply) => {
    const { engine, repoUrl, branch } = request.body;

    // engine 검증: 필수값이며 허용된 엔진 목록 중 하나여야 함
    if (!isScanEngineType(engine)) {
      return reply.status(400).send({
        error: `engine은 ${VALID_ENGINES.join(", ")} 중 하나여야 합니다`,
      });
    }

    // repoUrl 검증: source-prep과 동일 계약 사용
    if (!isNonEmptyString(repoUrl) || (await classifyRepoUrlInput(repoUrl)) === "unsupported") {
      return reply.status(400).send({
        error:
          "repoUrl은 로컬 디렉터리 경로 또는 http/https/ssh/file://, git@... 형식이어야 합니다",
      });
    }

    const record = createScan({
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

      const scans = listScans(validStatus ? { status: validStatus } : undefined);
      return reply.status(200).send(scans);
    }
  );

  /** GET /api/v1/scans/dead-letters — dead-letter 목록 조회 */
  app.get("/api/v1/scans/dead-letters", async (_request, reply) => {
    return reply.status(200).send(listDeadLetters());
  });

  /** POST /api/v1/scans/:id/redrive — dead-letter 재처리 요청 */
  app.post<{ Params: { id: string } }>(
    "/api/v1/scans/:id/redrive",
    async (request, reply) => {
      const scanId = request.params.id;
      const redriveResult = redriveDeadLetter(scanId);

      if (redriveResult === "accepted") {
        return reply.status(202).send({ scanId, status: "queued" });
      }

      if (redriveResult === "not_found") {
        return reply.status(404).send({ error: "dead-letter 항목을 찾을 수 없습니다" });
      }

      return reply.status(409).send({
        error:
          "dead-letter 항목은 존재하지만 scan 레코드가 없어 재처리할 수 없습니다(orphaned_scan)",
      });
    }
  );

  /** GET /api/v1/scans/:id — 단일 스캔 조회 (완료 상태면 findings 요약 포함) */
  app.get<{ Params: { id: string } }>(
    "/api/v1/scans/:id",
    async (request, reply) => {
      const scan = getScan(request.params.id);
      if (!scan) {
        return reply.status(404).send({ error: "스캔을 찾을 수 없습니다" });
      }
      return reply.status(200).send(scan);
    }
  );
};
