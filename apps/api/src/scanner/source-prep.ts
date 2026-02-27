import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ScanExecutionMode } from "./adapters/common.js";

const execFileAsync = promisify(execFile);
const SOURCE_PREP_TIMEOUT_MS = 60_000;
const SCANNER_QUEUE_LOG_PREFIX = "[scanner-queue]";

export type RepoUrlInputKind = "local-directory" | "remote-repository" | "unsupported";
export type SourcePrepErrorCode =
  | "SOURCE_PREP_CLONE_FAILED"
  | "SOURCE_PREP_UNSUPPORTED_REPO_URL";

export interface PreparedScanSource {
  repoUrl: string;
  cleanup: () => Promise<void>;
}

export class SourcePrepError extends Error {
  readonly code: SourcePrepErrorCode;
  readonly details?: Record<string, string>;

  constructor(
    code: SourcePrepErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, string> }
  ) {
    super(message, { cause: options?.cause });
    this.name = "SourcePrepError";
    this.code = code;
    this.details = options?.details;
  }
}

export function isSourcePrepError(error: unknown): error is SourcePrepError {
  return error instanceof SourcePrepError;
}

const noopCleanup = async (): Promise<void> => {
  // no-op
};

export function normalizeRepoUrlInput(repoUrl: string): string {
  return repoUrl.trim();
}

/**
 * API/스캐너 공통 repoUrl 입력 계약 분류기
 * - local-directory: 실제 존재하는 로컬 디렉터리
 * - remote-repository: 지원하는 원격 저장소 주소 형식
 * - unsupported: 위 조건 외 입력(빈 문자열, 미지원 스킴 포함)
 */
export async function classifyRepoUrlInput(repoUrl: unknown): Promise<RepoUrlInputKind> {
  if (typeof repoUrl !== "string") {
    return "unsupported";
  }

  const normalizedRepoUrl = normalizeRepoUrlInput(repoUrl);
  if (normalizedRepoUrl.length === 0) {
    return "unsupported";
  }

  if (await isExistingDirectory(normalizedRepoUrl)) {
    return "local-directory";
  }

  if (isRemoteRepositoryUrl(normalizedRepoUrl)) {
    return "remote-repository";
  }

  return "unsupported";
}

/**
 * 스캔 실행 전 소스 경로를 준비한다.
 * - mock: 기존 repoUrl 그대로 사용
 * - native:
 *   - 로컬 디렉터리 경로면 그대로 사용
 *   - 원격 저장소 URL이면 임시 디렉터리에 shallow clone 후 clone 경로 사용
 */
export async function prepareScanSource(
  repoUrl: string,
  branch: string,
  mode: ScanExecutionMode
): Promise<PreparedScanSource> {
  if (mode === "mock") {
    return {
      repoUrl,
      cleanup: noopCleanup,
    };
  }

  const normalizedRepoUrl = normalizeRepoUrlInput(repoUrl);
  const repoUrlInputKind = await classifyRepoUrlInput(normalizedRepoUrl);

  if (repoUrlInputKind === "local-directory") {
    return {
      repoUrl: normalizedRepoUrl,
      cleanup: noopCleanup,
    };
  }

  if (repoUrlInputKind === "remote-repository") {
    return cloneRemoteRepository(normalizedRepoUrl, branch);
  }

  throw new SourcePrepError(
    "SOURCE_PREP_UNSUPPORTED_REPO_URL",
    `[source-prep] native 소스 준비 실패: 로컬 경로가 아니며 지원하지 않는 저장소 주소입니다 (${normalizedRepoUrl})`,
    {
      details: {
        repoUrl: normalizedRepoUrl,
      },
    }
  );
}

async function cloneRemoteRepository(
  repoUrl: string,
  branch: string
): Promise<PreparedScanSource> {
  const tempRootDir = await mkdtemp(join(tmpdir(), "scan-source-"));
  const clonePath = join(tempRootDir, "repo");

  const cleanup = async (): Promise<void> => {
    await rm(tempRootDir, { recursive: true, force: true });
  };

  try {
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--branch", branch, repoUrl, clonePath],
      {
        encoding: "utf8",
        timeout: SOURCE_PREP_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    return {
      repoUrl: clonePath,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch((cleanupError) => {
      // clone 실패 정리 중 에러는 원본 실패 원인을 가리지 않되, 관측 로그는 남긴다.
      console.warn(
        `${SCANNER_QUEUE_LOG_PREFIX} source cleanup 실패 (repoUrl=${repoUrl}, branch=${branch}): ${getErrorReason(cleanupError)}`
      );
    });

    throw new SourcePrepError(
      "SOURCE_PREP_CLONE_FAILED",
      `[source-prep] native 소스 준비 실패: git clone 실패 (repoUrl=${repoUrl}, branch=${branch}): ${getErrorReason(error)}`,
      {
        cause: error,
        details: {
          repoUrl,
          branch,
        },
      }
    );
  }
}

async function isExistingDirectory(pathValue: string): Promise<boolean> {
  try {
    return (await stat(pathValue)).isDirectory();
  } catch {
    return false;
  }
}

function isRemoteRepositoryUrl(repoUrl: string): boolean {
  const lowered = repoUrl.toLowerCase();

  return (
    lowered.startsWith("http://") ||
    lowered.startsWith("https://") ||
    lowered.startsWith("ssh://") ||
    lowered.startsWith("file://") ||
    /^git@[^:]+:.+/.test(repoUrl)
  );
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

function isErrorWithStderr(error: unknown): error is { stderr: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
  );
}
