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

/** Trivy SCA 어댑터 */
export class TrivyAdapter implements ScanAdapter {
  readonly engine = "trivy" as const;

  async scan(request: ScanRequest): Promise<ScanResultSummary> {
    if (getScanExecutionMode() === "mock") {
      return createDeterministicMockSummary(request, this.engine);
    }

    return this.scanNative(request);
  }

  private async scanNative(request: ScanRequest): Promise<ScanResultSummary> {
    const output = await runNativeCli(this.engine, "trivy", [
      "fs",
      "--format",
      "json",
      "--quiet",
      request.repoUrl,
    ]);

    try {
      const report = parseJsonOrThrow<unknown>(this.engine, output);
      const severities = extractTrivySeverities(this.engine, report);
      const findings = summarizeFindings(severities);
      return buildResultSummary(request, this.engine, findings);
    } catch (error) {
      throw normalizeNativeResultError(this.engine, error);
    }
  }
}

function extractTrivySeverities(engine: "trivy", report: unknown): unknown[] {
  if (!isJsonObject(report)) {
    throw createNativeResultShapeError(engine, "최상위 JSON은 객체여야 합니다");
  }

  const rawResults = report.Results;
  if (rawResults === undefined) {
    return [];
  }
  if (!Array.isArray(rawResults)) {
    throw createNativeResultShapeError(engine, "Results는 배열이어야 합니다");
  }

  const severities: unknown[] = [];
  for (let resultIndex = 0; resultIndex < rawResults.length; resultIndex += 1) {
    const rawResult = rawResults[resultIndex];
    if (!isJsonObject(rawResult)) {
      throw createNativeResultShapeError(
        engine,
        `Results[${resultIndex}]는 객체여야 합니다`
      );
    }

    appendSeverityField(
      engine,
      rawResult,
      resultIndex,
      "Vulnerabilities",
      severities
    );
    appendSeverityField(
      engine,
      rawResult,
      resultIndex,
      "Misconfigurations",
      severities
    );
    appendSeverityField(engine, rawResult, resultIndex, "Secrets", severities);
  }

  return severities;
}

function appendSeverityField(
  engine: "trivy",
  result: Record<string, unknown>,
  resultIndex: number,
  fieldName: "Vulnerabilities" | "Misconfigurations" | "Secrets",
  target: unknown[]
): void {
  const rawEntries = result[fieldName];
  if (rawEntries === undefined) {
    return;
  }
  if (!Array.isArray(rawEntries)) {
    throw createNativeResultShapeError(
      engine,
      `Results[${resultIndex}].${fieldName}는 배열이어야 합니다`
    );
  }

  for (let entryIndex = 0; entryIndex < rawEntries.length; entryIndex += 1) {
    const rawEntry = rawEntries[entryIndex];
    if (!isJsonObject(rawEntry)) {
      throw createNativeResultShapeError(
        engine,
        `Results[${resultIndex}].${fieldName}[${entryIndex}]는 객체여야 합니다`
      );
    }

    target.push(rawEntry.Severity);
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
