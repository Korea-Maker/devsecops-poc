import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ScanEngineType, ScanRequest, ScanResultSummary } from "../types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_NATIVE_TIMEOUT_MS = 60_000;

export type ScanExecutionMode = "mock" | "native";

export interface FindingsSummary {
  totalFindings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * 스캔 실행 모드를 결정한다.
 * - SCAN_EXECUTION_MODE=native 일 때만 native
 * - 그 외 값/미설정은 모두 mock
 */
export function getScanExecutionMode(): ScanExecutionMode {
  const rawMode = process.env.SCAN_EXECUTION_MODE?.trim().toLowerCase();
  return rawMode === "native" ? "native" : "mock";
}

/**
 * 요청 정보 기반으로 안정적인 mock 결과를 생성한다.
 * 동일한 입력(repoUrl/branch/engine)이면 항상 동일한 카운트를 반환한다.
 */
export function createDeterministicMockSummary(
  request: ScanRequest,
  engine: ScanEngineType
): ScanResultSummary {
  const seed = stableHash(`${engine}:${request.repoUrl}:${request.branch}`);

  const critical = seed % 2;
  const high = Math.floor(seed / 2) % 3;
  const medium = Math.floor(seed / 6) % 4;
  const low = Math.floor(seed / 24) % 5;

  return buildResultSummary(request, engine, {
    totalFindings: critical + high + medium + low,
    critical,
    high,
    medium,
    low,
  });
}

export function buildResultSummary(
  request: ScanRequest,
  engine: ScanEngineType,
  findings: FindingsSummary
): ScanResultSummary {
  return {
    scanId: request.id,
    engine,
    ...findings,
    completedAt: new Date(),
  };
}

/**
 * native 모드에서 CLI를 실행하고 stdout 문자열을 반환한다.
 */
export async function runNativeCli(
  engine: ScanEngineType,
  command: string,
  args: string[]
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: DEFAULT_NATIVE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });

    return stdout;
  } catch (error) {
    throw new Error(formatNativeExecutionError(engine, command, error));
  }
}

/**
 * JSON 파싱 실패 시 엔진명을 포함한 에러를 던진다.
 */
export function parseJsonOrThrow<T>(engine: ScanEngineType, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw createNativeResultShapeError(engine, `JSON 파싱 실패: ${getErrorReason(error)}`);
  }
}

/**
 * native 결과 형식 검증 실패 시 일관된 에러를 생성한다.
 */
export function createNativeResultShapeError(
  engine: ScanEngineType,
  reason: string
): Error {
  return new Error(`[${engine}] native 결과 형식 오류: ${reason}`);
}

/**
 * native 결과 처리 중 발생한 임의의 오류를 엔진명 포함 에러로 정규화한다.
 */
export function normalizeNativeResultError(
  engine: ScanEngineType,
  error: unknown
): Error {
  if (error instanceof Error && error.message.includes(`[${engine}]`)) {
    return error;
  }

  return createNativeResultShapeError(engine, getErrorReason(error));
}

/**
 * 다양한 도구의 severity 문자열을 공통 4단계로 정규화한다.
 */
export function normalizeSeverity(severity: unknown): "critical" | "high" | "medium" | "low" {
  const token = typeof severity === "string" ? severity.trim().toLowerCase() : "";

  if (token.includes("critical")) {
    return "critical";
  }
  if (token.includes("high") || token === "error") {
    return "high";
  }
  if (token.includes("medium") || token.includes("moderate") || token === "warning") {
    return "medium";
  }

  // info/low/unknown/null 등은 low로 흡수
  return "low";
}

/**
 * severity 목록을 findings 카운트로 합산한다.
 */
export function summarizeFindings(severities: unknown[]): FindingsSummary {
  const summary: FindingsSummary = {
    totalFindings: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const severity of severities) {
    const normalized = normalizeSeverity(severity);
    summary[normalized] += 1;
    summary.totalFindings += 1;
  }

  return summary;
}

function stableHash(input: string): number {
  let hash = 0;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function formatNativeExecutionError(
  engine: ScanEngineType,
  command: string,
  error: unknown
): string {
  if (isNodeErrorWithCode(error) && error.code === "ENOENT") {
    return `[${engine}] native 실행 실패: ${command} CLI를 찾을 수 없습니다(ENOENT)`;
  }

  return `[${engine}] native 실행 실패: ${getErrorReason(error)}`;
}

function getErrorReason(error: unknown): string {
  if (isErrorWithStderr(error)) {
    const stderr = error.stderr.trim();
    if (stderr.length > 0) {
      return stderr;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "알 수 없는 오류";
}

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function isErrorWithStderr(error: unknown): error is { stderr: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
  );
}
