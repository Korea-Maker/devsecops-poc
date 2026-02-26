import type { FastifyPluginAsync } from "fastify";
import type { ScanEngineType, ScanStatus } from "../scanner/types.js";
import { createScan, getScan, listScans } from "../scanner/store.js";

/** 유효한 스캔 엔진 목록 */
const VALID_ENGINES: ScanEngineType[] = ["semgrep", "trivy", "gitleaks"];

/** 유효한 스캔 상태 목록 */
const VALID_STATUSES: ScanStatus[] = ["queued", "running", "completed", "failed"];

/**
 * URL 형식 문자열인지 검증합니다.
 */
function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export const scanRoutes: FastifyPluginAsync = async (app) => {
  /** POST /api/v1/scans — 새 스캔 요청 생성 */
  app.post<{
    Body: { engine?: unknown; repoUrl?: unknown; branch?: unknown };
  }>("/api/v1/scans", async (request, reply) => {
    const { engine, repoUrl, branch } = request.body;

    // engine 검증: 필수값이며 허용된 엔진 목록 중 하나여야 함
    if (!engine || !VALID_ENGINES.includes(engine as ScanEngineType)) {
      return reply.status(400).send({
        error: `engine은 ${VALID_ENGINES.join(", ")} 중 하나여야 합니다`,
      });
    }

    // repoUrl 검증: 필수값이며 유효한 URL 형식이어야 함
    if (!repoUrl || typeof repoUrl !== "string" || !isValidUrl(repoUrl)) {
      return reply.status(400).send({
        error: "repoUrl은 유효한 URL 형식이어야 합니다",
      });
    }

    const record = createScan({
      engine: engine as ScanEngineType,
      repoUrl,
      branch: typeof branch === "string" && branch.length > 0 ? branch : "main",
    });

    return reply.status(202).send({ scanId: record.id, status: record.status });
  });

  /** GET /api/v1/scans — 스캔 목록 조회 (status 쿼리 파라미터로 필터 가능) */
  app.get<{ Querystring: { status?: string } }>(
    "/api/v1/scans",
    async (request, reply) => {
      const { status } = request.query;

      // 유효하지 않은 status 값은 무시하고 전체 반환
      const validStatus = VALID_STATUSES.includes(status as ScanStatus)
        ? (status as ScanStatus)
        : undefined;

      const scans = listScans(validStatus ? { status: validStatus } : undefined);
      return reply.status(200).send(scans);
    }
  );

  /** GET /api/v1/scans/:id — 단일 스캔 조회 */
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
