"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchScan } from "@/lib/api";
import type { ScanRecord, ScanStatus, ScanErrorCode } from "@/lib/types";
import styles from "./page.module.css";

const STATUS_LABELS: Record<ScanStatus, string> = {
  queued: "대기 중",
  running: "진행 중",
  completed: "완료",
  failed: "실패",
};

const ERROR_CODE_GUIDES: Record<ScanErrorCode, string> = {
  SOURCE_PREP_CLONE_FAILED:
    "저장소 clone에 실패했습니다. URL과 접근 권한을 확인하세요.",
  SOURCE_PREP_UNSUPPORTED_REPO_URL:
    "지원하지 않는 저장소 URL 형식입니다. http/https/ssh/git@ 형식을 사용하세요.",
  SCAN_EXECUTION_FAILED:
    "스캔 엔진 실행에 실패했습니다. 엔진 설치 상태를 확인하세요.",
  SCAN_UNKNOWN_ERROR: "알 수 없는 오류가 발생했습니다. 로그를 확인하세요.",
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString("ko-KR");
}

function generateHtmlReport(scan: ScanRecord): string {
  const date = new Date().toLocaleDateString("ko-KR");

  const findingsHtml = scan.findings
    ? `
    <section>
      <h2>Findings 요약</h2>
      <table>
        <thead>
          <tr><th>심각도</th><th>건수</th></tr>
        </thead>
        <tbody>
          <tr><td>전체</td><td><strong>${scan.findings.totalFindings}</strong></td></tr>
          <tr><td style="color:#f87171">Critical</td><td>${scan.findings.critical}</td></tr>
          <tr><td style="color:#fb923c">High</td><td>${scan.findings.high}</td></tr>
          <tr><td style="color:#fbbf24">Medium</td><td>${scan.findings.medium}</td></tr>
          <tr><td style="color:#a3a3a3">Low</td><td>${scan.findings.low}</td></tr>
        </tbody>
      </table>
    </section>`
    : "";

  const errorCodeGuide =
    scan.lastErrorCode && ERROR_CODE_GUIDES[scan.lastErrorCode]
      ? `<p class="error-guide">${ERROR_CODE_GUIDES[scan.lastErrorCode]}</p>`
      : "";

  const errorHtml =
    scan.status === "failed"
      ? `
    <section>
      <h2>오류 정보</h2>
      ${scan.lastErrorCode ? `<p><strong>오류 코드:</strong> <code>${scan.lastErrorCode}</code></p>` : ""}
      ${errorCodeGuide}
      ${scan.lastError ? `<pre class="error-pre">${scan.lastError}</pre>` : ""}
    </section>`
      : "";

  const statusBadgeClass = `badge-${scan.status}`;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>스캔 리포트 - ${scan.id.slice(0, 8)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #fafafa; line-height: 1.6; padding: 40px 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 6px; }
    h2 { font-size: 0.75rem; font-weight: 600; color: #a3a3a3; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px; }
    .meta { color: #737373; font-size: 0.875rem; margin-bottom: 32px; }
    section { background: #141414; border: 1px solid #262626; border-radius: 8px; padding: 24px; margin-bottom: 20px; }
    .dl { display: grid; grid-template-columns: 130px 1fr; gap: 10px 16px; }
    .dl dt { color: #737373; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; display: flex; align-items: center; }
    .dl dd { font-size: 0.875rem; word-break: break-all; }
    code { font-family: "Menlo", "SF Mono", monospace; font-size: 0.8em; background: #1a1a1a; padding: 2px 6px; border-radius: 4px; border: 1px solid #262626; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #262626; font-size: 0.875rem; }
    th { color: #a3a3a3; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .badge { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; }
    .badge-completed { background: rgba(52,211,153,0.15); color: #34d399; border: 1px solid #34d399; }
    .badge-failed { background: rgba(248,113,113,0.15); color: #f87171; border: 1px solid #f87171; }
    .badge-queued { background: rgba(163,163,163,0.15); color: #a3a3a3; border: 1px solid #a3a3a3; }
    .badge-running { background: rgba(45,212,191,0.1); color: #2dd4bf; border: 1px solid #2dd4bf; }
    .error-guide { font-size: 0.875rem; color: #a3a3a3; padding: 8px 12px; background: rgba(248,113,113,0.05); border-left: 3px solid #f87171; border-radius: 0 4px 4px 0; margin: 10px 0; }
    .error-pre { font-family: monospace; font-size: 0.8rem; background: #0a0a0a; border: 1px solid #262626; border-radius: 6px; padding: 12px 16px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; color: #f87171; line-height: 1.6; margin-top: 10px; }
    footer { margin-top: 40px; color: #525252; font-size: 0.75rem; border-top: 1px solid #262626; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>스캔 리포트</h1>
    <p class="meta">생성일: ${date}</p>

    <section>
      <h2>스캔 정보</h2>
      <dl class="dl">
        <dt>스캔 ID</dt><dd><code>${scan.id}</code></dd>
        <dt>엔진</dt><dd><code>${scan.engine}</code></dd>
        <dt>저장소 URL</dt><dd><code>${scan.repoUrl}</code></dd>
        <dt>브랜치</dt><dd><code>${scan.branch}</code></dd>
        <dt>상태</dt><dd><span class="badge ${statusBadgeClass}">${STATUS_LABELS[scan.status]}</span></dd>
        <dt>생성일</dt><dd>${formatDate(scan.createdAt)}</dd>
        ${scan.completedAt ? `<dt>완료일</dt><dd>${formatDate(scan.completedAt)}</dd>` : ""}
        <dt>재시도 횟수</dt><dd>${scan.retryCount}</dd>
      </dl>
    </section>

    ${findingsHtml}
    ${errorHtml}

    <footer>Previo &mdash; 리포트 생성 시각: ${new Date().toISOString()}</footer>
  </div>
</body>
</html>`;
}

export default function ReportPage() {
  const params = useParams();
  const id = params.id as string;

  const [scan, setScan] = useState<ScanRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetchScan(id)
      .then((data) => {
        setScan(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [id]);

  function handleDownload() {
    if (!scan) return;
    const html = generateHtmlReport(scan);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    a.href = url;
    a.download = `report-${scan.id.slice(0, 8)}-${dateStr}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <main className={styles.container}>
        <p className={styles.stateText}>로딩 중...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className={styles.container}>
        <p className={styles.stateText} style={{ color: "var(--danger)" }}>
          오류: {error}
        </p>
        <Link href="/" className={styles.backLink}>
          ← 대시보드로
        </Link>
      </main>
    );
  }

  if (!scan) {
    return (
      <main className={styles.container}>
        <p className={styles.stateText}>스캔을 찾을 수 없습니다.</p>
        <Link href="/" className={styles.backLink}>
          ← 대시보드로
        </Link>
      </main>
    );
  }

  const statusClass =
    scan.status === "queued"
      ? styles.statusQueued
      : scan.status === "running"
        ? styles.statusRunning
        : scan.status === "completed"
          ? styles.statusCompleted
          : styles.statusFailed;

  return (
    <main className={styles.container}>
      {/* 네비게이션 헤더 */}
      <div className={styles.header}>
        <div className={styles.navLinks}>
          <Link href={`/scans/${scan.id}`} className={styles.backLink}>
            ← 스캔 상세로 돌아가기
          </Link>
          <Link href="/" className={styles.dashLink}>
            대시보드로
          </Link>
        </div>
        <button onClick={handleDownload} className={styles.downloadBtn}>
          HTML 리포트 다운로드
        </button>
      </div>

      <h1 className={styles.title}>스캔 리포트</h1>

      {/* PDF 안내 */}
      <div className={styles.printHint}>
        <span className={styles.printHintIcon}>💡</span>
        <span>
          PDF로 저장하려면 Ctrl+P (또는 Cmd+P)를 눌러 &apos;프린트 → PDF로
          저장&apos;을 선택하세요.
        </span>
      </div>

      {/* 스캔 메타 정보 요약 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>스캔 정보</h2>
        <div className={styles.metaGrid}>
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>스캔 ID</span>
            <code className={styles.metaCode}>{scan.id}</code>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>엔진</span>
            <code className={styles.metaCode}>{scan.engine}</code>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>저장소 URL</span>
            <code className={styles.metaCode}>{scan.repoUrl}</code>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>브랜치</span>
            <code className={styles.metaCode}>{scan.branch}</code>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>상태</span>
            <span className={`${styles.badge} ${statusClass}`}>
              {STATUS_LABELS[scan.status]}
            </span>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>생성일</span>
            <span className={styles.metaValue}>{formatDate(scan.createdAt)}</span>
          </div>
          {scan.completedAt && (
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>완료일</span>
              <span className={styles.metaValue}>
                {formatDate(scan.completedAt)}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Findings 요약 테이블 */}
      {scan.findings && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Findings 요약</h2>
          <table className={styles.findingsTable}>
            <thead>
              <tr>
                <th className={styles.th}>심각도</th>
                <th className={styles.th}>건수</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={styles.td}>전체</td>
                <td className={styles.td}>
                  <strong>{scan.findings.totalFindings}</strong>
                </td>
              </tr>
              <tr>
                <td className={styles.td} style={{ color: "#f87171" }}>
                  Critical
                </td>
                <td className={styles.td}>{scan.findings.critical}</td>
              </tr>
              <tr>
                <td className={styles.td} style={{ color: "#fb923c" }}>
                  High
                </td>
                <td className={styles.td}>{scan.findings.high}</td>
              </tr>
              <tr>
                <td className={styles.td} style={{ color: "#fbbf24" }}>
                  Medium
                </td>
                <td className={styles.td}>{scan.findings.medium}</td>
              </tr>
              <tr>
                <td className={styles.td} style={{ color: "#a3a3a3" }}>
                  Low
                </td>
                <td className={styles.td}>{scan.findings.low}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {/* 오류 정보 (failed일 때) */}
      {scan.status === "failed" && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>오류 정보</h2>
          {scan.lastErrorCode && (
            <div className={styles.errorCodeRow}>
              <span className={`${styles.badge} ${styles.errorBadge}`}>
                {scan.lastErrorCode}
              </span>
              <p className={styles.errorGuide}>
                {ERROR_CODE_GUIDES[scan.lastErrorCode]}
              </p>
            </div>
          )}
          {scan.lastError && (
            <pre className={styles.errorPre}>{scan.lastError}</pre>
          )}
        </section>
      )}
    </main>
  );
}
