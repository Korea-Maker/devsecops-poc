import type { ScanAdapter, ScanRequest, ScanResultSummary } from "../types.js";
import {
  buildResultSummary,
  createDeterministicMockSummary,
  createNativeResultShapeError,
  getScanExecutionMode,
  normalizeNativeResultError,
  parseJsonOrThrow,
  runNativeCli,
  summarizeFindings,
} from "./common.js";

/** Semgrep SAST 어댑터 */
export class SemgrepAdapter implements ScanAdapter {
  readonly engine = "semgrep" as const;

  async scan(request: ScanRequest): Promise<ScanResultSummary> {
    if (getScanExecutionMode() === "mock") {
      return createDeterministicMockSummary(request, this.engine);
    }

    return this.scanNative(request);
  }

  private async scanNative(request: ScanRequest): Promise<ScanResultSummary> {
    const output = await runNativeCli(this.engine, "semgrep", [
      "--config",
      "auto",
      "--json",
      "--quiet",
      "--metrics",
      "off",
      request.repoUrl,
    ]);

    try {
      const report = parseJsonOrThrow<unknown>(this.engine, output);
      const severities = extractSemgrepSeverities(this.engine, report);
      const findings = summarizeFindings(severities);
      return buildResultSummary(request, this.engine, findings);
    } catch (error) {
      throw normalizeNativeResultError(this.engine, error);
    }
  }
}

function extractSemgrepSeverities(engine: "semgrep", report: unknown): unknown[] {
  if (!isJsonObject(report)) {
    throw createNativeResultShapeError(engine, "최상위 JSON은 객체여야 합니다");
  }

  const rawResults = report.results;
  if (rawResults === undefined) {
    return [];
  }
  if (!Array.isArray(rawResults)) {
    throw createNativeResultShapeError(engine, "results는 배열이어야 합니다");
  }

  const severities: unknown[] = [];
  for (let index = 0; index < rawResults.length; index += 1) {
    const rawResult = rawResults[index];
    if (!isJsonObject(rawResult)) {
      throw createNativeResultShapeError(engine, `results[${index}]는 객체여야 합니다`);
    }

    const rawExtra = rawResult.extra;
    if (rawExtra === undefined) {
      severities.push(undefined);
      continue;
    }

    if (!isJsonObject(rawExtra)) {
      throw createNativeResultShapeError(engine, `results[${index}].extra는 객체여야 합니다`);
    }

    severities.push(rawExtra.severity);
  }

  return severities;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
