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

const STATUS_GUIDES: Record<ScanStatus, string> = {
  queued: "큐에서 대기 중입니다. 워커가 처리할 때까지 잠시 기다려주세요.",
  running: "스캔이 진행 중입니다. 완료까지 잠시 기다려주세요.",
  completed: "스캔이 성공적으로 완료되었습니다.",
  failed:
    "스캔이 실패했습니다. 아래 오류 정보를 확인하고, redrive를 시도하거나 입력값을 점검하세요.",
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

export default function ScanDetailPage() {
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
          ← 대시보드로 돌아가기
        </Link>
      </main>
    );
  }

  if (!scan) {
    return (
      <main className={styles.container}>
        <p className={styles.stateText}>스캔을 찾을 수 없습니다.</p>
        <Link href="/" className={styles.backLink}>
          ← 대시보드로 돌아가기
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
      <div className={styles.header}>
        <Link href="/" className={styles.backLink}>
          ← 대시보드로 돌아가기
        </Link>
        {scan.status === "completed" && (
          <Link href={`/reports/${scan.id}`} className={styles.reportBtn}>
            리포트 보기 →
          </Link>
        )}
      </div>

      <h1 className={styles.title}>스캔 상세</h1>

      {/* 상태 섹션 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>상태</h2>
        <div className={styles.statusRow}>
          <span className={`${styles.badge} ${statusClass}`}>
            {STATUS_LABELS[scan.status]}
          </span>
          <p className={styles.guideText}>{STATUS_GUIDES[scan.status]}</p>
        </div>
      </section>

      {/* 메타 정보 섹션 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>스캔 정보</h2>
        <div className={styles.metaGrid}>
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>스캔 ID</span>
            <code className={styles.metaCode}>{scan.id}</code>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>엔진</span>
            <span className={`${styles.badge} ${styles.engineBadge}`}>
              {scan.engine}
            </span>
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
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>재시도 횟수</span>
            <span className={styles.metaValue}>{scan.retryCount}</span>
          </div>
        </div>
      </section>

      {/* Findings 섹션 (completed일 때) */}
      {scan.status === "completed" && scan.findings && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Findings 요약</h2>
          <div className={styles.findingsGrid}>
            <div
              className={styles.findingCard}
              style={{ borderTopColor: "var(--accent)" }}
            >
              <span className={styles.findingLabel}>전체</span>
              <span className={styles.findingCount}>
                {scan.findings.totalFindings}
              </span>
            </div>
            <div
              className={styles.findingCard}
              style={{ borderTopColor: "#f87171" }}
            >
              <span
                className={styles.findingLabel}
                style={{ color: "#f87171" }}
              >
                Critical
              </span>
              <span className={styles.findingCount}>
                {scan.findings.critical}
              </span>
            </div>
            <div
              className={styles.findingCard}
              style={{ borderTopColor: "#fb923c" }}
            >
              <span
                className={styles.findingLabel}
                style={{ color: "#fb923c" }}
              >
                High
              </span>
              <span className={styles.findingCount}>{scan.findings.high}</span>
            </div>
            <div
              className={styles.findingCard}
              style={{ borderTopColor: "#fbbf24" }}
            >
              <span
                className={styles.findingLabel}
                style={{ color: "#fbbf24" }}
              >
                Medium
              </span>
              <span className={styles.findingCount}>
                {scan.findings.medium}
              </span>
            </div>
            <div
              className={styles.findingCard}
              style={{ borderTopColor: "#a3a3a3" }}
            >
              <span
                className={styles.findingLabel}
                style={{ color: "#a3a3a3" }}
              >
                Low
              </span>
              <span className={styles.findingCount}>{scan.findings.low}</span>
            </div>
          </div>
        </section>
      )}

      {/* 오류 정보 섹션 (failed일 때) */}
      {scan.status === "failed" && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>오류 정보</h2>
          {scan.lastErrorCode && (
            <div className={styles.errorCodeRow}>
              <div className={styles.errorCodeHeader}>
                <span className={styles.metaLabel}>오류 코드</span>
                <span className={`${styles.badge} ${styles.errorBadge}`}>
                  {scan.lastErrorCode}
                </span>
              </div>
              <p className={styles.errorGuide}>
                {ERROR_CODE_GUIDES[scan.lastErrorCode]}
              </p>
            </div>
          )}
          {scan.lastError && (
            <div className={styles.errorBlock}>
              <span className={styles.metaLabel}>오류 메시지</span>
              <pre className={styles.errorPre}>{scan.lastError}</pre>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
