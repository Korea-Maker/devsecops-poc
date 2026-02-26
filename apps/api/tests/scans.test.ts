import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";

describe("Scans API", () => {
  const app = buildApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /api/v1/scans", () => {
    it("유효한 요청 시 202와 scanId를 반환해야 한다", async () => {
      const response = await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "semgrep", repoUrl: "https://github.com/test/repo", branch: "main" });

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty("scanId");
      expect(response.body.status).toBe("queued");
    });

    it("scanId가 UUID 형식이어야 한다", async () => {
      const response = await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "trivy", repoUrl: "https://github.com/test/repo" });

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(response.body.scanId)).toBe(true);
    });
  });

  describe("GET /api/v1/scans/:id", () => {
    it("POST로 생성한 스캔을 GET으로 조회하면 200을 반환해야 한다", async () => {
      // POST로 스캔 생성
      const createRes = await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "trivy", repoUrl: "https://github.com/test/repo", branch: "main" });

      const { scanId } = createRes.body;

      // 생성된 스캔 조회
      const getRes = await request(app.server).get(`/api/v1/scans/${scanId}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(scanId);
      expect(getRes.body.status).toBe("queued");
    });

    it("존재하지 않는 스캔을 조회하면 404를 반환해야 한다", async () => {
      const response = await request(app.server).get("/api/v1/scans/nonexistent-id");

      expect(response.status).toBe(404);
    });
  });
});
