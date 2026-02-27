import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitleaksAdapter } from "../src/scanner/adapters/gitleaks.js";
import { SemgrepAdapter } from "../src/scanner/adapters/semgrep.js";
import { TrivyAdapter } from "../src/scanner/adapters/trivy.js";
import type { ScanAdapter, ScanRequest, ScanResultSummary } from "../src/scanner/types.js";

const ORIGINAL_SCAN_EXECUTION_MODE = process.env.SCAN_EXECUTION_MODE;
const ORIGINAL_PATH = process.env.PATH;
const TEMP_DIRS_FOR_CLEANUP: string[] = [];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function createRequest(engine: ScanRequest["engine"]): ScanRequest {
  return {
    id: `scan-${engine}-1`,
    engine,
    repoUrl: "https://github.com/test/mock-repo",
    branch: "main",
    status: "queued",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function stripCompletedAt(summary: ScanResultSummary): Omit<ScanResultSummary, "completedAt"> {
  const { completedAt: _completedAt, ...rest } = summary;
  return rest;
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS_FOR_CLEANUP.push(dir);
  return dir;
}

function createMockBinary(command: string, stdout: string): string {
  const binDir = createTempDir("adapters-native-bin-");
  const commandPath = join(binDir, command);
  const escapedStdout = stdout.replaceAll("'", "'\"'\"'");
  const script = `#!/bin/sh\nprintf '%s\\n' '${escapedStdout}'\n`;

  writeFileSync(commandPath, script, { encoding: "utf8" });
  chmodSync(commandPath, 0o755);

  return binDir;
}

function cleanupTempDirs(): void {
  while (TEMP_DIRS_FOR_CLEANUP.length > 0) {
    const dir = TEMP_DIRS_FOR_CLEANUP.pop();
    if (!dir) {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Scanner adapters (mock mode)", () => {
  beforeEach(() => {
    process.env.SCAN_EXECUTION_MODE = "mock";
  });

  afterEach(() => {
    restoreEnv("SCAN_EXECUTION_MODE", ORIGINAL_SCAN_EXECUTION_MODE);
  });

  it.each([
    ["semgrep", new SemgrepAdapter()],
    ["trivy", new TrivyAdapter()],
    ["gitleaks", new GitleaksAdapter()],
  ] satisfies Array<[string, ScanAdapter]>)
  ("%s 어댑터는 mock 결과 요약 포맷을 반환해야 한다", async (_name, adapter) => {
    const request = createRequest(adapter.engine);
    const summary = await adapter.scan(request);

    expect(summary.scanId).toBe(request.id);
    expect(summary.engine).toBe(request.engine);
    expect(summary.completedAt).toBeInstanceOf(Date);
    expect(summary.totalFindings).toBe(
      summary.critical + summary.high + summary.medium + summary.low
    );
  });

  it("동일 입력이면 mock 결과가 deterministic 해야 한다", async () => {
    const adapter = new SemgrepAdapter();
    const request = createRequest("semgrep");

    const first = await adapter.scan(request);
    const second = await adapter.scan(request);

    expect(stripCompletedAt(first)).toEqual(stripCompletedAt(second));
  });

  it("SCAN_EXECUTION_MODE 값이 비정상이면 mock으로 fallback 해야 한다", async () => {
    const adapter = new TrivyAdapter();
    const request = createRequest("trivy");

    process.env.SCAN_EXECUTION_MODE = "invalid-mode";
    const invalidModeResult = await adapter.scan(request);

    process.env.SCAN_EXECUTION_MODE = "mock";
    const mockModeResult = await adapter.scan(request);

    expect(stripCompletedAt(invalidModeResult)).toEqual(stripCompletedAt(mockModeResult));
  });
});

describe("Scanner adapters (native mode boundary)", () => {
  const nativeCases = [
    {
      engine: "semgrep" as const,
      command: "semgrep",
      createAdapter: () => new SemgrepAdapter(),
      malformedOutput: "[]",
    },
    {
      engine: "trivy" as const,
      command: "trivy",
      createAdapter: () => new TrivyAdapter(),
      malformedOutput: "[]",
    },
    {
      engine: "gitleaks" as const,
      command: "gitleaks",
      createAdapter: () => new GitleaksAdapter(),
      malformedOutput: '{"results":[]}',
    },
  ];

  beforeEach(() => {
    process.env.SCAN_EXECUTION_MODE = "native";
  });

  afterEach(() => {
    restoreEnv("SCAN_EXECUTION_MODE", ORIGINAL_SCAN_EXECUTION_MODE);
    restoreEnv("PATH", ORIGINAL_PATH);
    cleanupTempDirs();
  });

  it.each(nativeCases)(
    "native 모드에서 $engine CLI가 없으면 엔진명 포함 실행 실패 에러를 던져야 한다",
    async ({ engine, createAdapter }) => {
      const emptyPathDir = createTempDir("adapters-native-empty-path-");
      process.env.PATH = emptyPathDir;

      await expect(createAdapter().scan(createRequest(engine))).rejects.toThrow(
        `[${engine}] native 실행 실패:`
      );
    }
  );

  it.each(nativeCases)(
    "native 모드에서 $engine 결과 형식이 깨지면 엔진명 포함 형식 오류를 던져야 한다",
    async ({ engine, command, createAdapter, malformedOutput }) => {
      process.env.PATH = createMockBinary(command, malformedOutput);

      await expect(createAdapter().scan(createRequest(engine))).rejects.toThrow(
        `[${engine}] native 결과 형식 오류:`
      );
    }
  );
});
