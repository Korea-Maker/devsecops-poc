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

/** Gitleaks Secret 탐지 어댑터 */
export class GitleaksAdapter implements ScanAdapter {
  readonly engine = "gitleaks" as const;

  async scan(request: ScanRequest): Promise<ScanResultSummary> {
    if (getScanExecutionMode() === "mock") {
      return createDeterministicMockSummary(request, this.engine);
    }

    return this.scanNative(request);
  }

  private async scanNative(request: ScanRequest): Promise<ScanResultSummary> {
    const output = await runNativeCli(this.engine, "gitleaks", [
      "detect",
      "--source",
      request.repoUrl,
      "--exit-code",
      "0",
      "--report-format",
      "json",
      "--report-path",
      "-",
    ]);

    try {
      const findingsReport = parseJsonOrThrow<unknown>(this.engine, output);
      const severities = extractGitleaksSeverities(this.engine, findingsReport);
      const findings = summarizeFindings(severities);
      return buildResultSummary(request, this.engine, findings);
    } catch (error) {
      throw normalizeNativeResultError(this.engine, error);
    }
  }
}

function extractGitleaksSeverities(engine: "gitleaks", report: unknown): unknown[] {
  if (!Array.isArray(report)) {
    throw createNativeResultShapeError(engine, "최상위 JSON은 배열이어야 합니다");
  }

  const severities: unknown[] = [];
  for (let index = 0; index < report.length; index += 1) {
    const finding = report[index];
    if (!isJsonObject(finding)) {
      throw createNativeResultShapeError(engine, `결과[${index}]는 객체여야 합니다`);
    }

    // gitleaks 결과에는 severity가 비어있는 경우가 많아 기본 high로 집계한다.
    const severity =
      typeof finding.Severity === "string" && finding.Severity.trim().length > 0
        ? finding.Severity
        : "high";

    severities.push(severity);
  }

  return severities;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
