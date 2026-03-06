"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { fetchScans, fetchQueueStatus } from "@/lib/api";
import type { ScanRecord, QueueStatus, ScanStatus, ScanEngineType } from "@/lib/types";
import styles from "./page.module.css";

function formatDate(dateStr: string): string {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(dateStr));
  } catch {
    return dateStr;
  }
}

const STATUS_LABEL: Record<ScanStatus, string> = {
  queued: "대기",
  running: "실행중",
  completed: "완료",
  failed: "실패",
};

const ENGINE_LABEL: Record<ScanEngineType, string> = {
  semgrep: "Semgrep",
  trivy: "Trivy",
  gitleaks: "Gitleaks",
};

function StatusBadge({ status }: { status: ScanStatus }) {
  return (
    <span className={`${styles.statusBadge} ${styles[`status_${status}`]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function EngineBadge({ engine }: { engine: ScanEngineType }) {
  return (
    <span className={`${styles.engineBadge} ${styles[`engine_${engine}`]}`}>
      {ENGINE_LABEL[engine]}
    </span>
  );
}

function FindingsSummary({ findings }: { findings: ScanRecord["findings"] }) {
  if (!findings) return <span className={styles.noFindings}>—</span>;
  return (
    <span className={styles.findingsSummary}>
      <span className={styles.findingCritical} title="Critical">{findings.critical}C</span>
      <span className={styles.findingHigh} title="High">{findings.high}H</span>
      <span className={styles.findingMedium} title="Medium">{findings.medium}M</span>
      <span className={styles.findingLow} title="Low">{findings.low}L</span>
    </span>
  );
}

function DashboardContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const statusFilter = searchParams.get("filter") ?? "all";
  const engineFilter = searchParams.get("engine") ?? "all";
  const searchQuery = searchParams.get("search") ?? "";
  const sortOrder = searchParams.get("sort") ?? "desc";

  const loadData = useCallback(async () => {
    try {
      const [scansData, queueData] = await Promise.all([
        fetchScans(),
        fetchQueueStatus(),
      ]);
      setScans(scansData);
      setQueueStatus(queueData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "데이터를 불러오는 데 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    const defaults: Record<string, string> = {
      filter: "all",
      engine: "all",
      search: "",
      sort: "desc",
    };
    if (value === (defaults[key] ?? "")) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "/");
  }

  // 요약 통계
  const statusCounts: Record<ScanStatus, number> = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };
  const findingsTotals = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };

  for (const scan of scans) {
    statusCounts[scan.status]++;
    if (scan.findings) {
      findingsTotals.total += scan.findings.totalFindings;
      findingsTotals.critical += scan.findings.critical;
      findingsTotals.high += scan.findings.high;
      findingsTotals.medium += scan.findings.medium;
      findingsTotals.low += scan.findings.low;
    }
  }

  // 필터 + 정렬
  const filteredScans = scans
    .filter((s) => {
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (engineFilter !== "all" && s.engine !== engineFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!s.id.toLowerCase().includes(q) && !s.repoUrl.toLowerCase().includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return sortOrder === "asc" ? ta - tb : tb - ta;
    });

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loadingState}>데이터를 불러오는 중...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* 헤더 */}
      <header className={styles.header}>
        <h1 className={styles.title}>Previo Dashboard</h1>
        <p className={styles.subtitle}>보안 스캔 현황 및 취약점 모니터링</p>
      </header>

      {error && <div className={styles.errorBanner}>오류: {error}</div>}

      {/* 스캔 현황 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>스캔 현황</h2>
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{scans.length}</div>
            <div className={styles.statLabel}>총 스캔 수</div>
          </div>
          <div className={`${styles.statCard} ${styles.statCardQueued}`}>
            <div className={styles.statValue}>{statusCounts.queued}</div>
            <div className={styles.statLabel}>대기중</div>
          </div>
          <div className={`${styles.statCard} ${styles.statCardRunning}`}>
            <div className={styles.statValue}>{statusCounts.running}</div>
            <div className={styles.statLabel}>실행중</div>
          </div>
          <div className={`${styles.statCard} ${styles.statCardCompleted}`}>
            <div className={styles.statValue}>{statusCounts.completed}</div>
            <div className={styles.statLabel}>완료</div>
          </div>
          <div className={`${styles.statCard} ${styles.statCardFailed}`}>
            <div className={styles.statValue}>{statusCounts.failed}</div>
            <div className={styles.statLabel}>실패</div>
          </div>
        </div>
      </section>

      {/* Findings 요약 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Findings 요약</h2>
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{findingsTotals.total}</div>
            <div className={styles.statLabel}>총 Findings</div>
          </div>
          <div className={`${styles.statCard} ${styles.statCardFailed}`}>
            <div className={styles.statValue}>{findingsTotals.critical}</div>
            <div className={styles.statLabel}>Critical</div>
          </div>
          <div className={`${styles.statCard} ${styles.statCardHigh}`}>
            <div className={styles.statValue}>{findingsTotals.high}</div>
            <div className={styles.statLabel}>High</div>
          </div>
          <div className={`${styles.statCard} ${styles.statCardMedium}`}>
            <div className={styles.statValue}>{findingsTotals.medium}</div>
            <div className={styles.statLabel}>Medium</div>
          </div>
          <div className={styles.statCard}>
            <div className={`${styles.statValue} ${styles.statValueMuted}`}>
              {findingsTotals.low}
            </div>
            <div className={styles.statLabel}>Low</div>
          </div>
        </div>
      </section>

      {/* 큐 상태 */}
      {queueStatus && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>큐 상태</h2>
          <div className={styles.queueCard}>
            <div className={styles.queueGrid}>
              <div className={styles.queueItem}>
                <div className={styles.queueValue}>{queueStatus.queuedJobs}</div>
                <div className={styles.queueLabel}>대기 작업</div>
              </div>
              <div className={styles.queueItem}>
                <div
                  className={`${styles.queueValue} ${queueStatus.deadLetters > 0 ? styles.queueValueDanger : ""}`}
                >
                  {queueStatus.deadLetters}
                </div>
                <div className={styles.queueLabel}>Dead Letters</div>
              </div>
              <div className={styles.queueItem}>
                <div className={styles.queueValue}>{queueStatus.pendingRetryTimers}</div>
                <div className={styles.queueLabel}>재시도 예약</div>
              </div>
              <div className={styles.queueItem}>
                <div
                  className={`${styles.queueStatus} ${
                    queueStatus.workerRunning ? styles.queueStatusActive : styles.queueStatusInactive
                  }`}
                >
                  {queueStatus.workerRunning ? "동작중" : "중지"}
                </div>
                <div className={styles.queueLabel}>워커</div>
              </div>
              <div className={styles.queueItem}>
                <div
                  className={`${styles.queueStatus} ${
                    queueStatus.processing ? styles.queueStatusActive : styles.queueStatusIdle
                  }`}
                >
                  {queueStatus.processing ? "처리중" : "대기"}
                </div>
                <div className={styles.queueLabel}>처리 상태</div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 필터/검색/정렬 */}
      <section className={styles.section}>
        <div className={styles.filterBar}>
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel}>상태</label>
            <select
              className={styles.filterSelect}
              value={statusFilter}
              onChange={(e) => updateParam("filter", e.target.value)}
            >
              <option value="all">전체</option>
              <option value="queued">대기중</option>
              <option value="running">실행중</option>
              <option value="completed">완료</option>
              <option value="failed">실패</option>
            </select>
          </div>
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel}>엔진</label>
            <select
              className={styles.filterSelect}
              value={engineFilter}
              onChange={(e) => updateParam("engine", e.target.value)}
            >
              <option value="all">전체</option>
              <option value="semgrep">Semgrep</option>
              <option value="trivy">Trivy</option>
              <option value="gitleaks">Gitleaks</option>
            </select>
          </div>
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel}>검색</label>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="Scan ID 또는 저장소 URL"
              value={searchQuery}
              onChange={(e) => updateParam("search", e.target.value)}
            />
          </div>
          <button
            className={styles.sortButton}
            onClick={() => updateParam("sort", sortOrder === "desc" ? "asc" : "desc")}
          >
            생성일 {sortOrder === "desc" ? "▼ 최신순" : "▲ 오래된순"}
          </button>
        </div>
      </section>

      {/* 스캔 목록 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>
          스캔 목록
          <span className={styles.scanCount}>{filteredScans.length}건</span>
        </h2>

        {filteredScans.length === 0 ? (
          <div className={styles.emptyState}>등록된 스캔이 없습니다</div>
        ) : (
          <>
            {/* 데스크톱 테이블 */}
            <div className={`${styles.tableWrapper} ${styles.desktopTable}`}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th}>Scan ID</th>
                    <th className={styles.th}>엔진</th>
                    <th className={styles.th}>저장소</th>
                    <th className={styles.th}>브랜치</th>
                    <th className={styles.th}>상태</th>
                    <th className={styles.th}>생성일</th>
                    <th className={styles.th}>Findings</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredScans.map((scan) => (
                    <tr key={scan.id} className={styles.row}>
                      <td className={styles.td}>
                        <Link href={`/scans/${scan.id}`} className={styles.scanLink}>
                          <code className={styles.scanId}>{scan.id.slice(0, 8)}</code>
                        </Link>
                      </td>
                      <td className={styles.td}>
                        <EngineBadge engine={scan.engine} />
                      </td>
                      <td className={styles.td}>
                        <span className={styles.repoUrl} title={scan.repoUrl}>
                          {scan.repoUrl.replace(/^https?:\/\//, "").slice(0, 40)}
                          {scan.repoUrl.replace(/^https?:\/\//, "").length > 40 ? "…" : ""}
                        </span>
                      </td>
                      <td className={styles.td}>
                        <code className={styles.branch}>{scan.branch}</code>
                      </td>
                      <td className={styles.td}>
                        <StatusBadge status={scan.status} />
                      </td>
                      <td className={styles.td}>
                        <span className={styles.dateText}>{formatDate(scan.createdAt)}</span>
                      </td>
                      <td className={styles.td}>
                        <FindingsSummary findings={scan.findings} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 모바일 카드 리스트 */}
            <div className={styles.mobileList}>
              {filteredScans.map((scan) => (
                <Link key={scan.id} href={`/scans/${scan.id}`} className={styles.mobileCard}>
                  <div className={styles.mobileCardHeader}>
                    <code className={styles.scanId}>{scan.id.slice(0, 8)}</code>
                    <StatusBadge status={scan.status} />
                  </div>
                  <div className={styles.mobileCardRow}>
                    <EngineBadge engine={scan.engine} />
                    <code className={styles.branch}>{scan.branch}</code>
                  </div>
                  <div className={styles.mobileCardRepo}>{scan.repoUrl}</div>
                  <div className={styles.mobileCardFooter}>
                    <span className={styles.dateText}>{formatDate(scan.createdAt)}</span>
                    <FindingsSummary findings={scan.findings} />
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: "80px 20px", textAlign: "center", color: "var(--text-muted)" }}>
          로딩 중...
        </div>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
