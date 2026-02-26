import type { FastifyPluginAsync } from "fastify";

export const scanRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/v1/scans", async (_request, reply) => {
    reply.status(501).send({
      ok: false,
      message: "스캔 API는 Phase 2에서 구현 예정입니다.",
      todo: "TODO: SAST/SCA/Secret 스캔 엔진 연동 및 결과 저장 구현",
    });
  });
};
