import { Pool, type QueryResult, type QueryResultRow } from "pg";
import type { ScanErrorCode, ScanStatus } from "../scanner/types.js";
import type { ScanFindingsSummary, ScanRecord } from "../scanner/store.js";
import { DEFAULT_TENANT_ID } from "../tenants/types.js";
import type { Organization, OrganizationInviteToken, OrganizationMembership } from "../tenants/types.js";
import type { TenantAuditLog } from "../tenants/audit-log.js";

const DEFAULT_ORGANIZATION_NAME = "Default Organization";
const DEFAULT_ORGANIZATION_SLUG = "default";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export type DataBackend = "memory" | "postgres";
export type TenantRlsMode = "off" | "shadow" | "enforce";

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

export interface PersistedRetryScheduleItem {
  scanId: string;
  dueAt: string;
}

export interface PersistedQueueState {
  queuedScanIds: string[];
  deadLetters: PersistedDeadLetterItem[];
  pendingRetries: PersistedRetryScheduleItem[];
}

export interface PersistedState {
  scans: ScanRecord[];
  organizations: Organization[];
  memberships: OrganizationMembership[];
  inviteTokens: OrganizationInviteToken[];
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

type TenantRlsActorRole = OrganizationMembership["role"] | "service";

interface TenantRlsSessionContext {
  tenantId: string;
  userId: string;
  userRole: TenantRlsActorRole;
}

const SYSTEM_TENANT_RLS_CONTEXT: TenantRlsSessionContext = {
  tenantId: "*",
  userId: "system",
  userRole: "service",
};

const TENANT_RLS_TARGET_TABLES = [
  "scans",
  "organizations",
  "organization_memberships",
  "organization_invite_tokens",
  "tenant_audit_logs",
] as const;

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
  active: boolean;
  created_at: string;
  disabled_at: string | null;
}

interface MembershipRow extends QueryResultRow {
  organization_id: string;
  user_id: string;
  role: OrganizationMembership["role"];
  created_at: string;
  updated_at: string;
}

interface OrganizationInviteTokenRow extends QueryResultRow {
  token: string;
  organization_id: string;
  role: OrganizationInviteToken["role"];
  email: string | null;
  created_by_user_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_user_id: string | null;
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

interface ScanRetryScheduleRow extends QueryResultRow {
  scan_id: string;
  due_at: string;
}

let activeBackend: DataBackend = "memory";
let activeTenantRlsMode: TenantRlsMode = "off";
let sqlClient: SqlClient | null = null;
let initPromise: Promise<DataBackendInitResult> | null = null;
let persistenceTaskQueue: Promise<void> = Promise.resolve();
let backendLogger: DataBackendLogger = console;

function createEmptyPersistedState(): PersistedState {
  return {
    scans: [],
    organizations: [],
    memberships: [],
    inviteTokens: [],
    tenantAuditLogs: [],
    queue: {
      queuedScanIds: [],
      deadLetters: [],
      pendingRetries: [],
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

function normalizeTenantRlsMode(rawValue: string | undefined): TenantRlsMode {
  if (!rawValue) {
    return "off";
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "shadow") {
    return "shadow";
  }

  if (normalized === "enforce") {
    return "enforce";
  }

  return "off";
}

export function parseTenantRlsMode(rawValue: string | undefined): TenantRlsMode {
  return normalizeTenantRlsMode(rawValue);
}

export function getConfiguredTenantRlsMode(): TenantRlsMode {
  return normalizeTenantRlsMode(readTrimmedEnv("TENANT_RLS_MODE"));
}

export function getActiveTenantRlsMode(): TenantRlsMode {
  return activeTenantRlsMode;
}

export function getDatabaseUrl(): string | undefined {
  return readTrimmedEnv("DATABASE_URL");
}

function isTenantRlsContextEnabled(mode: TenantRlsMode = activeTenantRlsMode): boolean {
  return mode !== "off";
}

function normalizeTenantRlsSessionContext(
  context: Partial<TenantRlsSessionContext> | undefined
): TenantRlsSessionContext {
  const normalizedTenantId = context?.tenantId?.trim();
  const tenantId =
    normalizedTenantId && normalizedTenantId.length > 0
      ? normalizedTenantId
      : SYSTEM_TENANT_RLS_CONTEXT.tenantId;

  const normalizedUserId = context?.userId?.trim();
  const userId =
    normalizedUserId && normalizedUserId.length > 0
      ? normalizedUserId
      : SYSTEM_TENANT_RLS_CONTEXT.userId;

  const userRole = context?.userRole ?? SYSTEM_TENANT_RLS_CONTEXT.userRole;

  return {
    tenantId,
    userId,
    userRole,
  };
}

function createTenantRlsContextForTenant(tenantId: string): TenantRlsSessionContext {
  const normalizedTenantId = tenantId.trim();

  return normalizeTenantRlsSessionContext({
    tenantId: normalizedTenantId.length > 0 ? normalizedTenantId : DEFAULT_TENANT_ID,
    userId: "storage-worker",
    userRole: "owner",
  });
}

function readAuditLogRetentionDays(): number | undefined {
  const rawValue = readTrimmedEnv("TENANT_AUDIT_LOG_RETENTION_DAYS");
  if (!rawValue) {
    return undefined;
  }

  if (!/^\d+$/.test(rawValue)) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }

  return parsed;
}

function getAuditLogRetentionCutoffIso(nowMs = Date.now()): string | undefined {
  const retentionDays = readAuditLogRetentionDays();
  if (!retentionDays) {
    return undefined;
  }

  return new Date(nowMs - retentionDays * MILLISECONDS_PER_DAY).toISOString();
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
  createSqlMigration("004_scan_retry_schedule", [
    `
      CREATE TABLE IF NOT EXISTS scan_retry_schedules (
        scan_id TEXT PRIMARY KEY,
        due_at TEXT NOT NULL
      )
    `,
    "CREATE INDEX IF NOT EXISTS idx_scan_retry_schedules_due_at ON scan_retry_schedules (due_at)",
  ]),
  {
    version: "005_tenant_org_hardening",
    apply: async (client) => {
      await client.query(
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS active BOOLEAN"
      );
      await client.query(
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS disabled_at TEXT"
      );
      await client.query("UPDATE organizations SET active = TRUE WHERE active IS NULL");
      await client.query("ALTER TABLE organizations ALTER COLUMN active SET DEFAULT TRUE");
      await client.query("ALTER TABLE organizations ALTER COLUMN active SET NOT NULL");

      await client.query(`
        CREATE TABLE IF NOT EXISTS organization_invite_tokens (
          token TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          role TEXT NOT NULL,
          email TEXT,
          created_by_user_id TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          consumed_by_user_id TEXT
        )
      `);

      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_org_invite_tokens_org_id ON organization_invite_tokens (organization_id)"
      );
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_org_invite_tokens_expires_at ON organization_invite_tokens (expires_at)"
      );
    },
  },
  {
    version: "006_tenant_rls_preview",
    apply: async (client) => {
      await client.query("CREATE SCHEMA IF NOT EXISTS app");

      await client.query(`
        CREATE OR REPLACE FUNCTION app.tenant_id()
        RETURNS text
        LANGUAGE sql
        STABLE
        AS $$
          SELECT COALESCE(
            NULLIF(current_setting('app.tenant_id', true), ''),
            NULLIF(current_setting('app.current_tenant_id', true), '')
          );
        $$
      `);

      await client.query(`
        CREATE OR REPLACE FUNCTION app.user_id()
        RETURNS text
        LANGUAGE sql
        STABLE
        AS $$
          SELECT COALESCE(
            NULLIF(current_setting('app.user_id', true), ''),
            NULLIF(current_setting('app.current_user_id', true), '')
          );
        $$
      `);

      await client.query(`
        CREATE OR REPLACE FUNCTION app.user_role()
        RETURNS text
        LANGUAGE sql
        STABLE
        AS $$
          SELECT COALESCE(
            NULLIF(current_setting('app.user_role', true), ''),
            NULLIF(current_setting('app.current_user_role', true), '')
          );
        $$
      `);

      await client.query(`
        CREATE OR REPLACE FUNCTION app.is_service_context()
        RETURNS boolean
        LANGUAGE sql
        STABLE
        AS $$
          SELECT app.user_role() = 'service' OR app.tenant_id() = '*';
        $$
      `);

      await client.query(`
        CREATE OR REPLACE FUNCTION app.role_at_least(required_role text)
        RETURNS boolean
        LANGUAGE sql
        STABLE
        AS $$
          SELECT COALESCE(
            array_position(ARRAY['viewer', 'member', 'admin', 'owner', 'service'], app.user_role())
              >= array_position(ARRAY['viewer', 'member', 'admin', 'owner', 'service'], required_role),
            false
          )
        $$
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant_runtime') THEN
            CREATE ROLE app_tenant_runtime NOLOGIN;
          END IF;
        EXCEPTION
          WHEN insufficient_privilege THEN
            RAISE NOTICE 'skip creating role app_tenant_runtime (insufficient privilege)';
        END
        $$
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant_migration') THEN
            CREATE ROLE app_tenant_migration NOLOGIN;
          END IF;
        EXCEPTION
          WHEN insufficient_privilege THEN
            RAISE NOTICE 'skip creating role app_tenant_migration (insufficient privilege)';
        END
        $$
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_policies
            WHERE schemaname = current_schema()
              AND tablename = 'scans'
              AND policyname = 'scans_tenant_isolation'
          ) THEN
            CREATE POLICY scans_tenant_isolation
              ON scans
              USING (app.is_service_context() OR tenant_id = app.tenant_id())
              WITH CHECK (app.is_service_context() OR tenant_id = app.tenant_id());
          END IF;
        END
        $$
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_policies
            WHERE schemaname = current_schema()
              AND tablename = 'organizations'
              AND policyname = 'organizations_tenant_isolation'
          ) THEN
            CREATE POLICY organizations_tenant_isolation
              ON organizations
              USING (app.is_service_context() OR id = app.tenant_id())
              WITH CHECK (app.is_service_context() OR id = app.tenant_id());
          END IF;
        END
        $$
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_policies
            WHERE schemaname = current_schema()
              AND tablename = 'organization_memberships'
              AND policyname = 'organization_memberships_tenant_isolation'
          ) THEN
            CREATE POLICY organization_memberships_tenant_isolation
              ON organization_memberships
              USING (app.is_service_context() OR organization_id = app.tenant_id())
              WITH CHECK (app.is_service_context() OR organization_id = app.tenant_id());
          END IF;
        END
        $$
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_policies
            WHERE schemaname = current_schema()
              AND tablename = 'organization_invite_tokens'
              AND policyname = 'organization_invite_tokens_tenant_isolation'
          ) THEN
            CREATE POLICY organization_invite_tokens_tenant_isolation
              ON organization_invite_tokens
              USING (app.is_service_context() OR organization_id = app.tenant_id())
              WITH CHECK (app.is_service_context() OR organization_id = app.tenant_id());
          END IF;
        END
        $$
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_policies
            WHERE schemaname = current_schema()
              AND tablename = 'tenant_audit_logs'
              AND policyname = 'tenant_audit_logs_tenant_isolation'
          ) THEN
            CREATE POLICY tenant_audit_logs_tenant_isolation
              ON tenant_audit_logs
              USING (app.is_service_context() OR organization_id = app.tenant_id())
              WITH CHECK (app.is_service_context() OR organization_id = app.tenant_id());
          END IF;
        END
        $$
      `);
    },
  },
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

async function applyTenantRlsMode(
  client: SqlClient,
  mode: TenantRlsMode
): Promise<void> {
  for (const tableName of TENANT_RLS_TARGET_TABLES) {
    if (mode === "enforce") {
      await client.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`);
      continue;
    }

    await client.query(`ALTER TABLE ${tableName} NO FORCE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${tableName} DISABLE ROW LEVEL SECURITY`);
  }
}

async function applyTenantRlsSessionContext(
  client: SqlClient,
  context: TenantRlsSessionContext
): Promise<void> {
  await client.query(
    `
      SELECT
        set_config('app.tenant_id', $1, true),
        set_config('app.user_id', $2, true),
        set_config('app.user_role', $3, true),
        set_config('app.current_tenant_id', $1, true),
        set_config('app.current_user_id', $2, true),
        set_config('app.current_user_role', $3, true)
    `,
    [context.tenantId, context.userId, context.userRole]
  );
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

async function prunePersistedTenantAuditLogsOnStartup(client: SqlClient): Promise<void> {
  const cutoffIso = getAuditLogRetentionCutoffIso();
  if (!cutoffIso) {
    return;
  }

  const pruneResult = await client.query(
    `
      DELETE FROM tenant_audit_logs
      WHERE created_at < $1
    `,
    [cutoffIso]
  );

  info(
    "[storage] tenant audit log retention prune 적용 (deleted=%d, cutoff=%s)",
    pruneResult.rowCount ?? 0,
    cutoffIso
  );
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
    active: typeof row.active === "boolean" ? row.active : true,
    createdAt: row.created_at,
    disabledAt: row.disabled_at ?? undefined,
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

function mapOrganizationInviteTokenRowToEntity(
  row: OrganizationInviteTokenRow
): OrganizationInviteToken {
  return {
    token: row.token,
    organizationId: row.organization_id,
    role: row.role,
    email: row.email ?? undefined,
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? undefined,
    consumedByUserId: row.consumed_by_user_id ?? undefined,
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

function mapRetryScheduleRowToEntity(
  row: ScanRetryScheduleRow
): PersistedRetryScheduleItem {
  return {
    scanId: row.scan_id,
    dueAt: row.due_at,
  };
}

async function readPersistedState(client: SqlClient): Promise<PersistedState> {
  const [
    scansResult,
    organizationsResult,
    membershipsResult,
    inviteTokensResult,
    auditLogsResult,
    queueJobsResult,
    deadLettersResult,
    retrySchedulesResult,
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
          SELECT id, name, slug, active, created_at, disabled_at
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
    client.query<OrganizationInviteTokenRow>(
      `
          SELECT
            token,
            organization_id,
            role,
            email,
            created_by_user_id,
            created_at,
            expires_at,
            consumed_at,
            consumed_by_user_id
          FROM organization_invite_tokens
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
    client.query<ScanRetryScheduleRow>(
      `
          SELECT scan_id, due_at
          FROM scan_retry_schedules
          ORDER BY due_at ASC, scan_id ASC
        `
    ),
  ]);

  return {
    scans: scansResult.rows.map(mapScanRowToRecord),
    organizations: organizationsResult.rows.map(mapOrganizationRowToEntity),
    memberships: membershipsResult.rows.map(mapMembershipRowToEntity),
    inviteTokens: inviteTokensResult.rows.map(mapOrganizationInviteTokenRowToEntity),
    tenantAuditLogs: auditLogsResult.rows.map(mapAuditLogRowToEntity),
    queue: {
      queuedScanIds: queueJobsResult.rows.map((row) => row.scan_id),
      deadLetters: deadLettersResult.rows.map(mapQueueDeadLetterRowToEntity),
      pendingRetries: retrySchedulesResult.rows.map(mapRetryScheduleRowToEntity),
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
    const configuredTenantRlsMode = getConfiguredTenantRlsMode();
    activeBackend = "memory";
    activeTenantRlsMode = "off";

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
      const postgresClient = createSqlClient(databaseUrl);
      candidateClient = postgresClient;

      await applySchemaMigrations(postgresClient);
      await applyTenantRlsMode(postgresClient, configuredTenantRlsMode);

      const { recoveredRunningScans, persistedState } = await runWithTenantRlsContext(
        postgresClient,
        "initializeDataBackend",
        SYSTEM_TENANT_RLS_CONTEXT,
        async () => {
          await prunePersistedTenantAuditLogsOnStartup(postgresClient);
          const recoveredRunningScans = await recoverInterruptedRunningScans(postgresClient);
          const persistedState = await readPersistedState(postgresClient);

          return {
            recoveredRunningScans,
            persistedState,
          };
        },
        configuredTenantRlsMode
      );

      sqlClient = postgresClient;
      candidateClient = null;
      activeBackend = "postgres";
      activeTenantRlsMode = configuredTenantRlsMode;
      info(
        "[storage] postgres backend 활성화 완료 (scans=%d, orgs=%d, memberships=%d, invites=%d, auditLogs=%d, queueJobs=%d, deadLetters=%d, retrySchedules=%d, recoveredRunning=%d, tenantRlsMode=%s)",
        persistedState.scans.length,
        persistedState.organizations.length,
        persistedState.memberships.length,
        persistedState.inviteTokens.length,
        persistedState.tenantAuditLogs.length,
        persistedState.queue.queuedScanIds.length,
        persistedState.queue.deadLetters.length,
        persistedState.queue.pendingRetries.length,
        recoveredRunningScans,
        activeTenantRlsMode
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
      activeTenantRlsMode = "off";

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

async function runInTransaction<T>(
  client: SqlClient,
  transactionName: string,
  task: () => Promise<T>
): Promise<T> {
  await client.query("BEGIN");

  try {
    const result = await task();
    await client.query("COMMIT");
    return result;
  } catch (transactionError) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      warn(
        "[storage] postgres transaction rollback 실패 (%s): %s",
        transactionName,
        toErrorMessage(rollbackError)
      );
    }

    throw transactionError;
  }
}

async function runWithTenantRlsContext<T>(
  client: SqlClient,
  transactionName: string,
  context: Partial<TenantRlsSessionContext> | undefined,
  task: () => Promise<T>,
  mode: TenantRlsMode = activeTenantRlsMode
): Promise<T> {
  if (!isTenantRlsContextEnabled(mode)) {
    return task();
  }

  const normalizedContext = normalizeTenantRlsSessionContext(context);

  return runInTransaction(client, `tenantRls:${transactionName}`, async () => {
    await applyTenantRlsSessionContext(client, normalizedContext);
    return task();
  });
}

export function persistScanRecord(record: ScanRecord): void {
  const tenantRlsContext = createTenantRlsContextForTenant(record.tenantId);

  schedulePersistenceTask("persistScanRecord", async (client) => {
    await runWithTenantRlsContext(
      client,
      "persistScanRecord",
      tenantRlsContext,
      async () => {
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
      }
    );
  });
}

export function clearPersistedScans(): void {
  schedulePersistenceTask("clearPersistedScans", async (client) => {
    await runWithTenantRlsContext(
      client,
      "clearPersistedScans",
      SYSTEM_TENANT_RLS_CONTEXT,
      async () => {
        await client.query("DELETE FROM scans");
      }
    );
  });
}

export function persistQueueState(state: PersistedQueueState): void {
  const snapshotQueuedScanIds = [...state.queuedScanIds];
  const snapshotDeadLetters = state.deadLetters.map((item) => ({ ...item }));
  const snapshotPendingRetries = state.pendingRetries.map((item) => ({ ...item }));

  schedulePersistenceTask("persistQueueState", async (client) => {
    await runInTransaction(client, "persistQueueState", async () => {
      await client.query("DELETE FROM scan_queue_jobs");
      await client.query("DELETE FROM scan_dead_letters");
      await client.query("DELETE FROM scan_retry_schedules");

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

      for (const item of snapshotPendingRetries) {
        await client.query(
          `
            INSERT INTO scan_retry_schedules (scan_id, due_at)
            VALUES ($1, $2)
          `,
          [item.scanId, item.dueAt]
        );
      }
    });
  });
}

export function clearPersistedQueueState(): void {
  schedulePersistenceTask("clearPersistedQueueState", async (client) => {
    await runInTransaction(client, "clearPersistedQueueState", async () => {
      await client.query("DELETE FROM scan_queue_jobs");
      await client.query("DELETE FROM scan_dead_letters");
      await client.query("DELETE FROM scan_retry_schedules");
    });
  });
}

export function persistOrganizationRecord(organization: Organization): void {
  const tenantRlsContext = createTenantRlsContextForTenant(organization.id);

  schedulePersistenceTask("persistOrganizationRecord", async (client) => {
    await runWithTenantRlsContext(
      client,
      "persistOrganizationRecord",
      tenantRlsContext,
      async () => {
        await client.query(
          `
            INSERT INTO organizations (id, name, slug, active, created_at, disabled_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (id)
            DO UPDATE SET
              name = EXCLUDED.name,
              slug = EXCLUDED.slug,
              active = EXCLUDED.active,
              created_at = EXCLUDED.created_at,
              disabled_at = EXCLUDED.disabled_at
          `,
          [
            organization.id,
            organization.name,
            organization.slug,
            organization.active,
            organization.createdAt,
            organization.disabledAt ?? null,
          ]
        );
      }
    );
  });
}

export function persistMembershipRecord(membership: OrganizationMembership): void {
  const tenantRlsContext = createTenantRlsContextForTenant(membership.organizationId);

  schedulePersistenceTask("persistMembershipRecord", async (client) => {
    await runWithTenantRlsContext(
      client,
      "persistMembershipRecord",
      tenantRlsContext,
      async () => {
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
      }
    );
  });
}

export function persistOrganizationInviteTokenRecord(
  inviteToken: OrganizationInviteToken
): void {
  const tenantRlsContext = createTenantRlsContextForTenant(inviteToken.organizationId);

  schedulePersistenceTask("persistOrganizationInviteTokenRecord", async (client) => {
    await runWithTenantRlsContext(
      client,
      "persistOrganizationInviteTokenRecord",
      tenantRlsContext,
      async () => {
        await client.query(
          `
            INSERT INTO organization_invite_tokens (
              token,
              organization_id,
              role,
              email,
              created_by_user_id,
              created_at,
              expires_at,
              consumed_at,
              consumed_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (token)
            DO UPDATE SET
              organization_id = EXCLUDED.organization_id,
              role = EXCLUDED.role,
              email = EXCLUDED.email,
              created_by_user_id = EXCLUDED.created_by_user_id,
              created_at = EXCLUDED.created_at,
              expires_at = EXCLUDED.expires_at,
              consumed_at = EXCLUDED.consumed_at,
              consumed_by_user_id = EXCLUDED.consumed_by_user_id
          `,
          [
            inviteToken.token,
            inviteToken.organizationId,
            inviteToken.role,
            inviteToken.email ?? null,
            inviteToken.createdByUserId ?? null,
            inviteToken.createdAt,
            inviteToken.expiresAt,
            inviteToken.consumedAt ?? null,
            inviteToken.consumedByUserId ?? null,
          ]
        );
      }
    );
  });
}

export function deletePersistedMembership(
  organizationId: string,
  userId: string
): void {
  const tenantRlsContext = createTenantRlsContextForTenant(organizationId);

  schedulePersistenceTask("deletePersistedMembership", async (client) => {
    await runWithTenantRlsContext(
      client,
      "deletePersistedMembership",
      tenantRlsContext,
      async () => {
        await client.query(
          `
            DELETE FROM organization_memberships
            WHERE organization_id = $1 AND user_id = $2
          `,
          [organizationId, userId]
        );
      }
    );
  });
}

export function clearPersistedOrganizationsAndMemberships(): void {
  schedulePersistenceTask(
    "clearPersistedOrganizationsAndMemberships",
    async (client) => {
      await runWithTenantRlsContext(
        client,
        "clearPersistedOrganizationsAndMemberships",
        SYSTEM_TENANT_RLS_CONTEXT,
        async () => {
          await client.query("DELETE FROM organization_invite_tokens");
          await client.query("DELETE FROM organization_memberships");
          await client.query("DELETE FROM organizations");
          await client.query(
            `
              INSERT INTO organizations (id, name, slug, active, created_at, disabled_at)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT DO NOTHING
            `,
            [
              DEFAULT_TENANT_ID,
              DEFAULT_ORGANIZATION_NAME,
              DEFAULT_ORGANIZATION_SLUG,
              true,
              new Date().toISOString(),
              null,
            ]
          );
        }
      );
    }
  );
}

export function persistTenantAuditLog(log: TenantAuditLog): void {
  const tenantRlsContext = createTenantRlsContextForTenant(log.organizationId);

  schedulePersistenceTask("persistTenantAuditLog", async (client) => {
    await runWithTenantRlsContext(
      client,
      "persistTenantAuditLog",
      tenantRlsContext,
      async () => {
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
      }
    );
  });
}

export function prunePersistedTenantAuditLogs(cutoffIso: string): void {
  const cutoffMs = Date.parse(cutoffIso);
  if (Number.isNaN(cutoffMs)) {
    return;
  }

  const normalizedCutoffIso = new Date(cutoffMs).toISOString();

  schedulePersistenceTask("prunePersistedTenantAuditLogs", async (client) => {
    await runWithTenantRlsContext(
      client,
      "prunePersistedTenantAuditLogs",
      SYSTEM_TENANT_RLS_CONTEXT,
      async () => {
        await client.query(
          `
            DELETE FROM tenant_audit_logs
            WHERE created_at < $1
          `,
          [normalizedCutoffIso]
        );
      }
    );
  });
}

export function clearPersistedTenantAuditLogs(): void {
  schedulePersistenceTask("clearPersistedTenantAuditLogs", async (client) => {
    await runWithTenantRlsContext(
      client,
      "clearPersistedTenantAuditLogs",
      SYSTEM_TENANT_RLS_CONTEXT,
      async () => {
        await client.query("DELETE FROM tenant_audit_logs");
      }
    );
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
  activeTenantRlsMode = "off";
  initPromise = null;
  persistenceTaskQueue = Promise.resolve();
}

/** 테스트 격리용 상태 리셋. */
export async function resetDataBackendForTests(): Promise<void> {
  await shutdownDataBackend();
}
