import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveDataBackend,
  getConfiguredDataBackend,
  initializeDataBackend,
  parseDataBackend,
  resetDataBackendForTests,
} from "../src/storage/backend.js";

const ORIGINAL_DATA_BACKEND = process.env.DATA_BACKEND;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

afterEach(async () => {
  restoreEnv("DATA_BACKEND", ORIGINAL_DATA_BACKEND);
  restoreEnv("DATABASE_URL", ORIGINAL_DATABASE_URL);
  await resetDataBackendForTests();
});

describe("data backend config", () => {
  it("DATA_BACKEND 미설정/알 수 없는 값은 memory로 fallback 해야 한다", () => {
    delete process.env.DATA_BACKEND;
    expect(getConfiguredDataBackend()).toBe("memory");

    process.env.DATA_BACKEND = "unknown";
    expect(getConfiguredDataBackend()).toBe("memory");
  });

  it("parseDataBackend는 postgres를 대소문자/공백 무시하고 인식해야 한다", () => {
    expect(parseDataBackend(" postgres ")).toBe("postgres");
    expect(parseDataBackend("POSTGRES")).toBe("postgres");
    expect(parseDataBackend("memory")).toBe("memory");
  });

  it("DATA_BACKEND=postgres + DATABASE_URL 누락 시 memory로 안전 fallback 해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    delete process.env.DATABASE_URL;

    const result = await initializeDataBackend({ logger: silentLogger });

    expect(result.configuredBackend).toBe("postgres");
    expect(result.activeBackend).toBe("memory");
    expect(result.reason).toBe("missing_database_url");
    expect(result.persistedState.scans).toEqual([]);
    expect(getActiveDataBackend()).toBe("memory");
  });

  it("postgres 초기화 실패 시 memory로 fallback 해야 한다", async () => {
    process.env.DATA_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgresql://invalid-host/devsecops";

    const result = await initializeDataBackend({
      logger: silentLogger,
      createSqlClient: () => ({
        query: async () => {
          throw new Error("bootstrap failure");
        },
        end: async () => undefined,
      }),
    });

    expect(result.configuredBackend).toBe("postgres");
    expect(result.activeBackend).toBe("memory");
    expect(result.reason).toBe("connection_failed");
    expect(getActiveDataBackend()).toBe("memory");
  });
});
