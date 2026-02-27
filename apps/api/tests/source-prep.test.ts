import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRepoUrlInput, prepareScanSource } from "../src/scanner/source-prep.js";

const TEMP_DIRS_FOR_CLEANUP: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS_FOR_CLEANUP.push(dir);
  return dir;
}

function cleanupTempDirs(): void {
  while (TEMP_DIRS_FOR_CLEANUP.length > 0) {
    const dir = TEMP_DIRS_FOR_CLEANUP.pop();
    if (!dir) {
      continue;
    }

    rmSync(dir, { recursive: true, force: true });
  }
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createGitRepoWithMainBranch(): string {
  const repoDir = createTempDir("source-prep-repo-");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "source-prep-test@example.com"], repoDir);
  runGit(["config", "user.name", "source-prep-test"], repoDir);

  writeFileSync(join(repoDir, "README.md"), "# source-prep test\n", { encoding: "utf8" });

  runGit(["add", "README.md"], repoDir);
  runGit(["commit", "-m", "init"], repoDir);
  runGit(["branch", "-M", "main"], repoDir);

  return repoDir;
}

describe("prepareScanSource", () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it("mock 모드에서는 repoUrl을 그대로 반환하고 cleanup은 no-op 이어야 한다", async () => {
    const repoUrl = "https://github.com/example/mock-repo";

    const prepared = await prepareScanSource(repoUrl, "main", "mock");

    expect(prepared.repoUrl).toBe(repoUrl);
    await expect(prepared.cleanup()).resolves.toBeUndefined();
  });

  it("native 모드 + 로컬 경로면 clone 없이 동일 경로를 사용해야 한다", async () => {
    const localPath = createTempDir("source-prep-local-");

    const prepared = await prepareScanSource(localPath, "main", "native");

    expect(prepared.repoUrl).toBe(localPath);

    await prepared.cleanup();

    // 로컬 경로 passthrough cleanup은 no-op 이므로 원본 디렉터리는 남아 있어야 한다.
    expect(existsSync(localPath)).toBe(true);
  });

  it("native 모드 + file:// 원격 URL이면 임시 clone 경로를 반환하고 cleanup으로 정리해야 한다", async () => {
    const sourceRepoPath = createGitRepoWithMainBranch();
    const repoUrl = pathToFileURL(sourceRepoPath).href;

    const prepared = await prepareScanSource(repoUrl, "main", "native");

    expect(prepared.repoUrl).not.toBe(repoUrl);
    expect(existsSync(join(prepared.repoUrl, ".git"))).toBe(true);
    expect(readFileSync(join(prepared.repoUrl, "README.md"), "utf8")).toContain(
      "source-prep test"
    );

    await prepared.cleanup();
    expect(existsSync(prepared.repoUrl)).toBe(false);
  });

  it("repoUrl 입력 분류 계약에서 git@은 remote-repository로 판별되어야 한다", async () => {
    await expect(classifyRepoUrlInput("git@github.com:test/repo.git")).resolves.toBe(
      "remote-repository"
    );
  });

  it("native 모드에서 ftp:// 스킴은 지원하지 않는 저장소 주소 에러를 반환해야 한다", async () => {
    await expect(prepareScanSource("ftp://example.com/repo.git", "main", "native")).rejects.toThrow(
      "지원하지 않는 저장소 주소"
    );
  });
});
