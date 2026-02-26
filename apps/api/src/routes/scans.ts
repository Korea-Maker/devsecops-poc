import type { FastifyPluginAsync } from "fastify";
import type { ScanEngineType, ScanStatus } from "../scanner/types.js";

/** in-memory 스캔 레코드 타입 */
interface ScanRecord {
  id: string;
  engine: ScanEngineType;
  repoUrl: string;
  branch: string;
  status: ScanStatus;
  createdAt: string; // ISO 문자열
}

/** 모듈 레벨 in-memory 스토어 */
const scanStore = new Map<string, ScanRecord>();

export const scanRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/v1/scans — 새 스캔 요청 생성
  app.post<{
    Body: { engine: ScanEngineType; repoUrl: string; branch?: string };
  }>("/api/v1/scans", async (request, reply) => {
    const { engine, repoUrl, branch = "main" } = request.body;

    const scanId = crypto.randomUUID();
    const record: ScanRecord = {
      id: scanId,
      engine,
      repoUrl,
      branch,
      status: "queued",
      createdAt: new Date().toISOString(),
    };

    // in-memory 스토어에 저장
    scanStore.set(scanId, record);

    return reply.status(202).send({ scanId, status: "queued" });
  });

  // GET /api/v1/scans/:id — 스캔 상태 조회
  app.get<{ Params: { id: string } }>(
    "/api/v1/scans/:id",
    async (request, reply) => {
      const scan = scanStore.get(request.params.id);

      if (!scan) {
        return reply
          .status(404)
          .send({ error: "스캔을 찾을 수 없습니다" });
      }

      return reply.status(200).send(scan);
    }
  );
};
