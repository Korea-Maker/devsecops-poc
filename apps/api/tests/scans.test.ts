import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo", branch: "main" },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toHaveProperty("scanId");
      expect(response.json().status).toBe("queued");
    });

    it("scanId가 UUID 형식이어야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo" },
      });

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(response.json().scanId)).toBe(true);
    });

    it("branch 미지정 시 기본값 'main'이 적용되어야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo" },
      });

      const { scanId } = createRes.json();
      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().branch).toBe("main");
    });

    it("유효하지 않은 engine이면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "invalid", repoUrl: "https://github.com/test/repo" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    });

    it("engine이 누락되면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { repoUrl: "https://github.com/test/repo" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    });

    it("유효하지 않은 repoUrl이면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "not-a-url" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    });

    it("repoUrl이 누락되면 400을 반환해야 한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    });
  });

  describe("GET /api/v1/scans/:id", () => {
    it("POST로 생성한 스캔을 GET으로 조회하면 200을 반환해야 한다", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo", branch: "main" },
      });

      const { scanId } = createRes.json();
      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/scans/${scanId}`,
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().id).toBe(scanId);
      expect(getRes.json().status).toBe("queued");
    });

    it("존재하지 않는 스캔을 조회하면 404를 반환해야 한다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans/nonexistent-id",
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/v1/scans", () => {
    it("스캔 목록을 배열로 반환해야 한다", async () => {
      // 스캔 2개 생성
      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "semgrep", repoUrl: "https://github.com/test/repo-a" },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "trivy", repoUrl: "https://github.com/test/repo-b" },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans",
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);
    });

    it("status 쿼리 파라미터로 필터링할 수 있어야 한다", async () => {
      // 새 스캔 생성 (queued 상태)
      await app.inject({
        method: "POST",
        url: "/api/v1/scans",
        payload: { engine: "gitleaks", repoUrl: "https://github.com/test/repo-c" },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/scans?status=queued",
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      for (const scan of body) {
        expect(scan.status).toBe("queued");
      }
    });
  });
});
