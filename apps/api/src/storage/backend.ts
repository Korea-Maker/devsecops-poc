import { Pool, type QueryResult, type QueryResultRow } from "pg";
import type { ScanErrorCode, ScanStatus } from "../scanner/types.js";
import type { ScanFindingsSummary, ScanRecord } from "../scanner/store.js";
import { DEFAULT_TENANT_ID } from "../tenants/types.js";
import type { Organization, OrganizationMembership } from "../tenants/types.js";
import type { TenantAuditLog } from "../tenants/audit-log.js";

const DEFAULT_ORGANIZATION_NAME = "Default Organization";
const DEFAULT_ORGANIZATION_SLUG = "default";

export type DataBackend = "memory" | "postgres";

export type DataBackendInitFallbackReason =
  | "missing_database_url"
  | "connection_failed";

export interface PersistedDeadLetterItem {
  scanId: string;
  retryCount: number;
  error: string;
  code?: ScanErrorCode;
  failedAt: string;
}

export interface PersistedQueueState {
  queuedScanIds: string[];
  deadLetters: PersistedDeadLetterItem[];
}

export interface PersistedState {
  scans: ScanRecord[];
  organizations: Organization[];
  memberships: OrganizationMembership[];
  tenantAuditLogs: TenantAuditLog[];
  queue: PersistedQueueState;
}

export interface DataBackendInitResult {
  configuredBackend: DataBackend;
  activeBackend: DataBackend;
  reason?: DataBackendInitFallbackReason;
  persistedState: PersistedState;
}

export interface DataBackendLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

interface SqlClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>>;
  end(): Promise<void>;
}

type CreateSqlClient = (connectionString: string) => SqlClient;

interface InitializeDataBackendOptions {
  createSqlClient?: CreateSqlClient;
  logger?: DataBackendLogger;
}

interface ScanRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  engine: ScanRecord["engine"];
  repo_url: string;
  branch: string;
  status: ScanStatus;
  created_at: string;
  completed_at: string | null;
  retry_count: number;
  last_error: string | null;
  last_error_code: ScanErrorCode | null;
  findings: unknown;
}

interface OrganizationRow extends QueryResultRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

interface MembershipRow extends QueryResultRow {
  organization_id: string;
  user_id: string;
  role: OrganizationMembership["role"];
  created_at: string;
  updated_at: string;
}

interface TenantAuditLogRow extends QueryResultRow {
  id: string;
  organization_id: string;
  actor_user_id: string | null;
  action: TenantAuditLog["action"];
  target_user_id: string | null;
  details: unknown;
  created_at: string;
}

interface ScanQueueJobRow extends QueryResultRow {
  scan_id: string;
  position: number;
}

interface ScanDeadLetterRow extends QueryResultRow {
  id: number;
  scan_id: string;
  retry_count: number;
  error: string;
  code: ScanErrorCode | null;
  failed_at: string;
}

let activeBackend: DataBackend = "memory";
let sqlClient: SqlClient | null = null;
let initPromise: Promise<DataBackendInitResult> | null = null;
let persistenceTaskQueue: Promise<void> = Promise.resolve();
let backendLogger: DataBackendLogger = console;

function createEmptyPersistedState(): PersistedState {
  return {
    scans: [],
    organizations: [],
    memberships: [],
    tenantAuditLogs: [],
    queue: {
      queuedScanIds: [],
      deadLetters: [],
    },
  };
}

function readTrimmedEnv(name: string): string | undefined {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string") {
    return undefined;
  }

  const normalized = rawValue.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "알 수 없는 오류";
}

function warn(message: string, ...args: unknown[]): void {
  backendLogger.warn?.(message, ...args);
}

function error(message: string, ...args: unknown[]): void {
  backendLogger.error?.(message, ...args);
}

function info(message: string, ...args: unknown[]): void {
  backendLogger.info?.(message, ...args);
}

function normalizeDataBackend(rawValue: string | undefined): DataBackend {
  if (!rawValue) {
    return "memory";
  }

  return rawValue.trim().toLowerCase() === "postgres" ? "postgres" : "memory";
}

export function parseDataBackend(rawValue: string | undefined): DataBackend {
  return normalizeDataBackend(rawValue);
}

export function getConfiguredDataBackend(): DataBackend {
  return normalizeDataBackend(readTrimmedEnv("DATA_BACKEND"));
}

export function getActiveDataBackend(): DataBackend {
  return activeBackend;
}

export function getDatabaseUrl(): string | undefined {
  return readTrimmedEnv("DATABASE_URL");
}

function defaultCreateSqlClient(connectionString: string): SqlClient {
  return new Pool({
    connectionString,
  });
}

async function closeSqlClient(): Promise<void> {
  if (!sqlClient) {
    return;
  }

  const client = sqlClient;
  sqlClient = null;

  try {
    await client.end();
  } catch (closeError) {
    warn(
      "[storage] postgres 연결 종료 중 오류가 발생했습니다: %s",
      toErrorMessage(closeError)
    );
  }
}

interface SchemaMigrationRow extends QueryResultRow {
  version: string;
  applied_at: string;
}

interface RecoveredRunningScanRow extends QueryResultRow {
  id: string;
}

interface SchemaMigration {
  version: string;
  apply: (client: SqlClient) => Promise<void>;
}

function createSqlMigration(
  version: string,
  statements: readonly string[]
): SchemaMigration {
  return {
    version,
    apply: async (client) => {
      for (const statement of statements) {
        await client.query(statement);
      }
    },
  };
}

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  createSqlMigration("001_scans", [
    `
      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_code TEXT,
        findings JSONB
      )
    `,
    "CREATE INDEX IF NOT EXISTS idx_scans_tenant_id_status ON scans (tenant_id, status)",
  ]),
  {
    version: "002_tenants",
    apply: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS organization_memberships (
          organization_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (organization_id, user_id)
        )
      `);

      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_org_memberships_org_id ON organization_memberships (organization_id)"
      );

      await client.query(`
        CREATE TABLE IF NOT EXISTS tenant_audit_logs (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          actor_user_id TEXT,
          action TEXT NOT NULL,
          target_user_id TEXT,
          details JSONB,
          created_at TEXT NOT NULL
        )
      `);

      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_tenant_audit_org_created_at ON tenant_audit_logs (organization_id, created_at DESC)"
      );

      await client.query(
        `
          INSERT INTO organizations (id, name, slug, created_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING
        `,
        [
          DEFAULT_TENANT_ID,
          DEFAULT_ORGANIZATION_NAME,
          DEFAULT_ORGANIZATION_SLUG,
          new Date().toISOString(),
        ]
      );
    },
  },
  createSqlMigration("003_scan_queue", [
    `
      CREATE TABLE IF NOT EXISTS scan_queue_jobs (
        position BIGSERIAL PRIMARY KEY,
        scan_id TEXT NOT NULL
      )
    `,
    "CREATE INDEX IF NOT EXISTS idx_scan_queue_jobs_scan_id ON scan_queue_jobs (scan_id)",
    `
      CREATE TABLE IF NOT EXISTS scan_dead_letters (
        id BIGSERIAL PRIMARY KEY,
        scan_id TEXT NOT NULL,
        retry_count INTEGER NOT NULL,
        error TEXT NOT NULL,
        code TEXT,
        failed_at TEXT NOT NULL
      )
    `,
    "CREATE INDEX IF NOT EXISTS idx_scan_dead_letters_scan_id ON scan_dead_letters (scan_id)",
  ]),
];

async function ensureSchemaMigrationsTable(client: SqlClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

async function readAppliedMigrationVersions(client: SqlClient): Promise<Set<string>> {
  const result = await client.query<SchemaMigrationRow>(
    `
      SELECT version, applied_at
      FROM schema_migrations
      ORDER BY version ASC
    `
  );

  return new Set(result.rows.map((row) => row.version));
}

async function markMigrationApplied(client: SqlClient, version: string): Promise<void> {
  await client.query(
    `
      INSERT INTO schema_migrations (version, applied_at)
      VALUES ($1, $2)
      ON CONFLICT (version) DO NOTHING
    `,
    [version, new Date().toISOString()]
  );
}

async function applySchemaMigrations(client: SqlClient): Promise<void> {
  await ensureSchemaMigrationsTable(client);

  const appliedVersions = await readAppliedMigrationVersions(client);

  for (const migration of SCHEMA_MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    await migration.apply(client);
    await markMigrationApplied(client, migration.version);
    appliedVersions.add(migration.version);
  }
}

async function recoverInterruptedRunningScans(client: SqlClient): Promise<number> {
  const recoveredRunningScansResult = await client.query<RecoveredRunningScanRow>(
    `
      UPDATE scans
      SET status = 'queued', completed_at = NULL
      WHERE status = 'running'
      RETURNING id
    `
  );

  if (recoveredRunningScansResult.rows.length === 0) {
    return 0;
  }

  const queueJobsResult = await client.query<ScanQueueJobRow>(
    `
      SELECT scan_id, position
      FROM scan_queue_jobs
      ORDER BY position ASC
    `
  );

  const queuedScanIdSet = new Set(queueJobsResult.rows.map((row) => row.scan_id));

  for (const row of recoveredRunningScansResult.rows) {
    if (queuedScanIdSet.has(row.id)) {
      continue;
    }

    await client.query(
      `
        INSERT INTO scan_queue_jobs (scan_id)
        VALUES ($1)
      `,
      [row.id]
    );
    queuedScanIdSet.add(row.id);
  }

  return recoveredRunningScansResult.rows.length;
}

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return toObjectRecord(parsed);
    } catch {
      return undefined;
    }
  }

  return toObjectRecord(value);
}

function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readScanFindingsSummary(value: unknown): ScanFindingsSummary | undefined {
  const record = readJsonObject(value);
  if (!record) {
    return undefined;
  }

  const totalFindings = readNumberField(record, "totalFindings");
  const critical = readNumberField(record, "critical");
  const high = readNumberField(record, "high");
  const medium = readNumberField(record, "medium");
  const low = readNumberField(record, "low");

  if (
    totalFindings === undefined ||
    critical === undefined ||
    high === undefined ||
    medium === undefined ||
    low === undefined
  ) {
    return undefined;
  }

  return {
    totalFindings,
    critical,
    high,
    medium,
    low,
  };
}

function mapScanRowToRecord(row: ScanRow): ScanRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    engine: row.engine,
    repoUrl: row.repo_url,
    branch: row.branch,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    retryCount: row.retry_count,
    lastError: row.last_error ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    findings: readScanFindingsSummary(row.findings),
  };
}

function mapOrganizationRowToEntity(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
  };
}

function mapMembershipRowToEntity(row: MembershipRow): OrganizationMembership {
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAuditLogRowToEntity(row: TenantAuditLogRow): TenantAuditLog {
  return {
    id: row.id,
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id ?? undefined,
    action: row.action,
    targetUserId: row.target_user_id ?? undefined,
    details: readJsonObject(row.details),
    createdAt: row.created_at,
  };
}

function mapQueueDeadLetterRowToEntity(
  row: ScanDeadLetterRow
): PersistedDeadLetterItem {
  return {
    scanId: row.scan_id,
    retryCount: row.retry_count,
    error: row.error,
    code: row.code ?? undefined,
    failedAt: row.failed_at,
  };
}

async function readPersistedState(client: SqlClient): Promise<PersistedState> {
  const [
    scansResult,
    organizationsResult,
    membershipsResult,
    auditLogsResult,
    queueJobsResult,
    deadLettersResult,
  ] = await Promise.all([
    client.query<ScanRow>(
      `
          SELECT
            id,
            tenant_id,
            engine,
            repo_url,
            branch,
            status,
            created_at,
            completed_at,
            retry_count,
            last_error,
            last_error_code,
            findings
          FROM scans
          ORDER BY created_at ASC
        `
    ),
    client.query<OrganizationRow>(
      `
          SELECT id, name, slug, created_at
          FROM organizations
          ORDER BY created_at ASC
        `
    ),
    client.query<MembershipRow>(
      `
          SELECT organization_id, user_id, role, created_at, updated_at
          FROM organization_memberships
          ORDER BY created_at ASC
        `
    ),
    client.query<TenantAuditLogRow>(
      `
          SELECT
            id,
            organization_id,
            actor_user_id,
            action,
            target_user_id,
            details,
            created_at
          FROM tenant_audit_logs
          ORDER BY created_at ASC
        `
    ),
    client.query<ScanQueueJobRow>(
      `
          SELECT scan_id, position
          FROM scan_queue_jobs
          ORDER BY position ASC
        `
    ),
    client.query<ScanDeadLetterRow>(
      `
          SELECT id, scan_id, retry_count, error, code, failed_at
          FROM scan_dead_letters
          ORDER BY id ASC
        `
    ),
  ]);

  return {
    scans: scansResult.rows.map(mapScanRowToRecord),
    organizations: organizationsResult.rows.map(mapOrganizationRowToEntity),
    memberships: membershipsResult.rows.map(mapMembershipRowToEntity),
    tenantAuditLogs: auditLogsResult.rows.map(mapAuditLogRowToEntity),
    queue: {
      queuedScanIds: queueJobsResult.rows.map((row) => row.scan_id),
      deadLetters: deadLettersResult.rows.map(mapQueueDeadLetterRowToEntity),
    },
  };
}

export async function initializeDataBackend(
  options: InitializeDataBackendOptions = {}
): Promise<DataBackendInitResult> {
  if (initPromise) {
    return initPromise;
  }

  backendLogger = options.logger ?? console;

  initPromise = (async (): Promise<DataBackendInitResult> => {
    const configuredBackend = getConfiguredDataBackend();
    activeBackend = "memory";

    if (configuredBackend !== "postgres") {
      return {
        configuredBackend,
        activeBackend,
        persistedState: createEmptyPersistedState(),
      };
    }

    const databaseUrl = getDatabaseUrl();
    if (!databaseUrl) {
      warn(
        "[storage] DATA_BACKEND=postgres 이지만 DATABASE_URL이 없어 memory 백엔드로 fallback 합니다"
      );
      return {
        configuredBackend,
        activeBackend,
        reason: "missing_database_url",
        persistedState: createEmptyPersistedState(),
      };
    }

    const createSqlClient = options.createSqlClient ?? defaultCreateSqlClient;
    let candidateClient: SqlClient | null = null;

    try {
      candidateClient = createSqlClient(databaseUrl);
      await applySchemaMigrations(candidateClient);
      const recoveredRunningScans = await recoverInterruptedRunningScans(candidateClient);
      const persistedState = await readPersistedState(candidateClient);

      sqlClient = candidateClient;
      candidateClient = null;
      activeBackend = "postgres";
      info(
        "[storage] postgres backend 활성화 완료 (scans=%d, orgs=%d, memberships=%d, auditLogs=%d, queueJobs=%d, deadLetters=%d, recoveredRunning=%d)",
        persistedState.scans.length,
        persistedState.organizations.length,
        persistedState.memberships.length,
        persistedState.tenantAuditLogs.length,
        persistedState.queue.queuedScanIds.length,
        persistedState.queue.deadLetters.length,
        recoveredRunningScans
      );

      return {
        configuredBackend,
        activeBackend,
        persistedState,
      };
    } catch (initError) {
      error(
        "[storage] postgres 백엔드 초기화 실패, memory로 fallback 합니다: %s",
        toErrorMessage(initError)
      );
      activeBackend = "memory";

      if (candidateClient) {
        try {
          await candidateClient.end();
        } catch (closeError) {
          warn(
            "[storage] postgres 초기화 실패 후 연결 정리 중 오류가 발생했습니다: %s",
            toErrorMessage(closeError)
          );
        }
      }

      await closeSqlClient();

      return {
        configuredBackend,
        activeBackend,
        reason: "connection_failed",
        persistedState: createEmptyPersistedState(),
      };
    }
  })();

  return initPromise;
}

function schedulePersistenceTask(
  taskName: string,
  task: (client: SqlClient) => Promise<void>
): void {
  if (activeBackend !== "postgres" || !sqlClient) {
    return;
  }

  persistenceTaskQueue = persistenceTaskQueue
    .then(async () => {
      if (activeBackend !== "postgres" || !sqlClient) {
        return;
      }

      await task(sqlClient);
    })
    .catch((taskError) => {
      warn(
        "[storage] postgres persistence task 실패 (%s): %s",
        taskName,
        toErrorMessage(taskError)
      );
    });
}

export function persistScanRecord(record: ScanRecord): void {
  schedulePersistenceTask("persistScanRecord", async (client) => {
    await client.query(
      `
        INSERT INTO scans (
          id,
          tenant_id,
          engine,
          repo_url,
          branch,
          status,
          created_at,
          completed_at,
          retry_count,
          last_error,
          last_error_code,
          findings
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12::jsonb
        )
        ON CONFLICT (id)
        DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          engine = EXCLUDED.engine,
          repo_url = EXCLUDED.repo_url,
          branch = EXCLUDED.branch,
          status = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          completed_at = EXCLUDED.completed_at,
          retry_count = EXCLUDED.retry_count,
          last_error = EXCLUDED.last_error,
          last_error_code = EXCLUDED.last_error_code,
          findings = EXCLUDED.findings
      `,
      [
        record.id,
        record.tenantId,
        record.engine,
        record.repoUrl,
        record.branch,
        record.status,
        record.createdAt,
        record.completedAt ?? null,
        record.retryCount,
        record.lastError ?? null,
        record.lastErrorCode ?? null,
        record.findings ? JSON.stringify(record.findings) : null,
      ]
    );
  });
}

export function clearPersistedScans(): void {
  schedulePersistenceTask("clearPersistedScans", async (client) => {
    await client.query("DELETE FROM scans");
  });
}

export function persistQueueState(state: PersistedQueueState): void {
  const snapshotQueuedScanIds = [...state.queuedScanIds];
  const snapshotDeadLetters = state.deadLetters.map((item) => ({ ...item }));

  schedulePersistenceTask("persistQueueState", async (client) => {
    await client.query("DELETE FROM scan_queue_jobs");
    await client.query("DELETE FROM scan_dead_letters");

    for (const scanId of snapshotQueuedScanIds) {
      await client.query(
        `
          INSERT INTO scan_queue_jobs (scan_id)
          VALUES ($1)
        `,
        [scanId]
      );
    }

    for (const item of snapshotDeadLetters) {
      await client.query(
        `
          INSERT INTO scan_dead_letters (scan_id, retry_count, error, code, failed_at)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [item.scanId, item.retryCount, item.error, item.code ?? null, item.failedAt]
      );
    }
  });
}

export function clearPersistedQueueState(): void {
  schedulePersistenceTask("clearPersistedQueueState", async (client) => {
    await client.query("DELETE FROM scan_queue_jobs");
    await client.query("DELETE FROM scan_dead_letters");
  });
}

export function persistOrganizationRecord(organization: Organization): void {
  schedulePersistenceTask("persistOrganizationRecord", async (client) => {
    await client.query(
      `
        INSERT INTO organizations (id, name, slug, created_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id)
        DO UPDATE SET
          name = EXCLUDED.name,
          slug = EXCLUDED.slug,
          created_at = EXCLUDED.created_at
      `,
      [organization.id, organization.name, organization.slug, organization.createdAt]
    );
  });
}

export function persistMembershipRecord(membership: OrganizationMembership): void {
  schedulePersistenceTask("persistMembershipRecord", async (client) => {
    await client.query(
      `
        INSERT INTO organization_memberships (
          organization_id,
          user_id,
          role,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (organization_id, user_id)
        DO UPDATE SET
          role = EXCLUDED.role,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        membership.organizationId,
        membership.userId,
        membership.role,
        membership.createdAt,
        membership.updatedAt,
      ]
    );
  });
}

export function deletePersistedMembership(
  organizationId: string,
  userId: string
): void {
  schedulePersistenceTask("deletePersistedMembership", async (client) => {
    await client.query(
      `
        DELETE FROM organization_memberships
        WHERE organization_id = $1 AND user_id = $2
      `,
      [organizationId, userId]
    );
  });
}

export function clearPersistedOrganizationsAndMemberships(): void {
  schedulePersistenceTask(
    "clearPersistedOrganizationsAndMemberships",
    async (client) => {
      await client.query("DELETE FROM organization_memberships");
      await client.query("DELETE FROM organizations");
      await client.query(
        `
          INSERT INTO organizations (id, name, slug, created_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING
        `,
        [
          DEFAULT_TENANT_ID,
          DEFAULT_ORGANIZATION_NAME,
          DEFAULT_ORGANIZATION_SLUG,
          new Date().toISOString(),
        ]
      );
    }
  );
}

export function persistTenantAuditLog(log: TenantAuditLog): void {
  schedulePersistenceTask("persistTenantAuditLog", async (client) => {
    await client.query(
      `
        INSERT INTO tenant_audit_logs (
          id,
          organization_id,
          actor_user_id,
          action,
          target_user_id,
          details,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (id)
        DO UPDATE SET
          organization_id = EXCLUDED.organization_id,
          actor_user_id = EXCLUDED.actor_user_id,
          action = EXCLUDED.action,
          target_user_id = EXCLUDED.target_user_id,
          details = EXCLUDED.details,
          created_at = EXCLUDED.created_at
      `,
      [
        log.id,
        log.organizationId,
        log.actorUserId ?? null,
        log.action,
        log.targetUserId ?? null,
        log.details ? JSON.stringify(log.details) : null,
        log.createdAt,
      ]
    );
  });
}

export function clearPersistedTenantAuditLogs(): void {
  schedulePersistenceTask("clearPersistedTenantAuditLogs", async (client) => {
    await client.query("DELETE FROM tenant_audit_logs");
  });
}

export async function shutdownDataBackend(): Promise<void> {
  try {
    await persistenceTaskQueue;
  } catch {
    // schedulePersistenceTask 내부에서 에러를 삼키므로 실제 도달하지 않습니다.
  }

  await closeSqlClient();

  activeBackend = "memory";
  initPromise = null;
  persistenceTaskQueue = Promise.resolve();
}

/** 테스트 격리용 상태 리셋. */
export async function resetDataBackendForTests(): Promise<void> {
  await shutdownDataBackend();
}
