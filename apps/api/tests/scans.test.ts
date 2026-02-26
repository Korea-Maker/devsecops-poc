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

    it("branch 미지정 시 기본값 'main'이 적용되어야 한다", async () => {
      const createRes = await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "semgrep", repoUrl: "https://github.com/test/repo" });

      const { scanId } = createRes.body;
      const getRes = await request(app.server).get(`/api/v1/scans/${scanId}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.branch).toBe("main");
    });

    it("유효하지 않은 engine이면 400을 반환해야 한다", async () => {
      const response = await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "invalid", repoUrl: "https://github.com/test/repo" });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error");
    });

    it("engine이 누락되면 400을 반환해야 한다", async () => {
      const response = await request(app.server)
        .post("/api/v1/scans")
        .send({ repoUrl: "https://github.com/test/repo" });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error");
    });

    it("유효하지 않은 repoUrl이면 400을 반환해야 한다", async () => {
      const response = await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "semgrep", repoUrl: "not-a-url" });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error");
    });

    it("repoUrl이 누락되면 400을 반환해야 한다", async () => {
      const response = await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "semgrep" });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error");
    });
  });

  describe("GET /api/v1/scans/:id", () => {
    it("POST로 생성한 스캔을 GET으로 조회하면 200을 반환해야 한다", async () => {
      const createRes = await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "trivy", repoUrl: "https://github.com/test/repo", branch: "main" });

      const { scanId } = createRes.body;
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

  describe("GET /api/v1/scans", () => {
    it("스캔 목록을 배열로 반환해야 한다", async () => {
      // 스캔 2개 생성
      await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "semgrep", repoUrl: "https://github.com/test/repo-a" });
      await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "trivy", repoUrl: "https://github.com/test/repo-b" });

      const response = await request(app.server).get("/api/v1/scans");

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(2);
    });

    it("status 쿼리 파라미터로 필터링할 수 있어야 한다", async () => {
      // 새 스캔 생성 (queued 상태)
      await request(app.server)
        .post("/api/v1/scans")
        .send({ engine: "gitleaks", repoUrl: "https://github.com/test/repo-c" });

      const response = await request(app.server).get("/api/v1/scans?status=queued");

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(1);
      for (const scan of response.body) {
        expect(scan.status).toBe("queued");
      }
    });
  });
});
