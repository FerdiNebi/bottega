import path from 'path';
import fs from 'fs';
import { runCommand } from './shell.js';
import { assertValidBranchName } from './validators.js';

/**
 * Derive the worktree path for a task based on convention
 */
export function getWorktreePath(repoPath: string, taskId: number): string {
  return path.join(`${repoPath}-worktrees`, `task-${taskId}`);
}

/**
 * Get the project path within a worktree (for monorepos)
 */
export function getWorktreeProjectPath(
  repoPath: string,
  taskId: number,
  subprojectPath: string | null,
): string {
  const worktreePath = getWorktreePath(repoPath, taskId);
  if (subprojectPath) {
    return path.join(worktreePath, subprojectPath);
  }
  return worktreePath;
}

/**
 * Get the worktrees directory for a repository
 */
export function getWorktreesDir(repoPath: string): string {
  return `${repoPath}-worktrees`;
}

/**
 * Check if a worktree exists for a task
 */
export async function worktreeExists(repoPath: string, taskId: number): Promise<boolean> {
  const worktreePath = getWorktreePath(repoPath, taskId);
  try {
    await fs.promises.access(worktreePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is a git repository
 */
export async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await runCommand('git', ['rev-parse', '--git-dir'], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the default branch name (main or master).
 *
 * Previously this was a single `exec` with a shell `||` fallback. Now the
 * fallback lives in JS so we don't need a shell at all.
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await runCommand(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd: repoPath },
    );
    return stdout.trim().replace('refs/remotes/origin/', '');
  } catch {
    // fall through to the abbrev-ref attempt
  }
  try {
    const { stdout } = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
    });
    return stdout.trim().replace('refs/remotes/origin/', '');
  } catch {
    return 'main';
  }
}

export interface BootstrapBase {
  defaultBranch: string;
  /** `origin/<default>` after a successful fetch, else the local default branch. */
  baseRef: string;
  /** True when the fetch failed and `baseRef` is the possibly stale local branch. */
  stale: boolean;
}

/**
 * Fetch the remote default branch and return the ref bootstrap should read from
 * and branch from. Falls back to the local default branch when the fetch fails
 * (offline, no `origin`).
 */
export async function resolveBootstrapBase(repoPath: string): Promise<BootstrapBase> {
  const defaultBranch = assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');
  try {
    await runCommand('git', ['fetch', '--quiet', 'origin', defaultBranch], {
      cwd: repoPath,
      timeout: 60_000,
    });
    return { defaultBranch, baseRef: `origin/${defaultBranch}`, stale: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[bootstrap] git fetch failed in ${repoPath}, using local ${defaultBranch}: ${message}`);
    return { defaultBranch, baseRef: defaultBranch, stale: true };
  }
}

/**
 * Get the current branch name from a worktree
 */
export async function getBranchName(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand('git', ['branch', '--show-current'], {
      cwd: worktreePath,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await runCommand('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoPath,
    });
    return true;
  } catch {
    return false;
  }
}

function sanitizeTitle(title: string | null | undefined): string {
  return (title || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

async function symlinkEnvFiles(
  projectPath: string,
  worktreePath: string,
  subprojectPath: string | null,
): Promise<void> {
  const envFiles = ['.env', '.env.local', '.env.development', '.env.development.local'];

  const srcBase = subprojectPath ? path.join(projectPath, subprojectPath) : projectPath;
  const destBase = subprojectPath ? path.join(worktreePath, subprojectPath) : worktreePath;

  for (const file of envFiles) {
    const srcPath = path.join(srcBase, file);
    const destPath = path.join(destBase, file);

    if (!fs.existsSync(srcPath)) {
      continue;
    }

    if (fs.existsSync(destPath)) {
      continue;
    }

    try {
      await fs.promises.symlink(srcPath, destPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to symlink ${file}: ${message}`);
    }
  }
}

const DEPENDENCY_DIRS = ['node_modules', '.venv'];

function copyDependenciesInBackground(srcProjectPath: string, destProjectPath: string): void {
  for (const dir of DEPENDENCY_DIRS) {
    const srcDir = path.join(srcProjectPath, dir);

    if (!fs.existsSync(srcDir)) {
      continue;
    }

    const destDir = path.join(destProjectPath, dir);

    runCommand('cp', ['-a', srcDir, destDir], { timeout: 600_000 })
      .then(() => {
        console.log(`${dir} copied to worktree: ${destProjectPath}`);
      })
      .catch((err: Error) => {
        console.warn(`Failed to copy ${dir} to worktree: ${err.message}`);
      });
  }
}

async function createGitignoreddirs(projectPath: string): Promise<void> {
  const dirs = ['log', 'tmp', 'storage'];

  for (const dir of dirs) {
    const dirPath = path.join(projectPath, dir);
    try {
      await fs.promises.mkdir(dirPath, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Note: Could not create ${dir} directory: ${message}`);
    }
  }
}

export interface CreateWorktreeResult {
  success: boolean;
  worktreePath?: string;
  branch?: string;
  error?: string;
}

/**
 * Create a worktree for a task. Branches from the local default branch unless
 * `baseRef` is given (project bootstrap passes `origin/<default>` so new tasks
 * see freshly merged docs).
 */
export async function createWorktree(
  repoPath: string,
  taskId: number,
  title: string | null | undefined,
  subprojectPath: string | null = null,
  baseRef?: string,
): Promise<CreateWorktreeResult> {
  const sanitizedTitle = sanitizeTitle(title);
  const branch = `task/${taskId}-${sanitizedTitle}`;
  const worktreesDir = getWorktreesDir(repoPath);
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    await fs.promises.mkdir(worktreesDir, { recursive: true });

    const base = baseRef
      ? assertValidBranchName(baseRef, 'base ref')
      : assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');

    const branchExisted = await localBranchExists(repoPath, assertValidBranchName(branch));
    try {
      await runCommand(
        'git',
        [
          'worktree',
          'add',
          // A remote-tracking base would otherwise become the branch's upstream.
          ...(baseRef ? ['--no-track'] : []),
          '-b',
          branch,
          worktreePath,
          base,
        ],
        { cwd: repoPath },
      );
    } catch (addError) {
      // `worktree add -b` creates the branch before checking it out, so a
      // failed checkout (e.g. the path already exists) leaves a stray branch.
      if (!branchExisted) {
        await runCommand('git', ['branch', '-D', branch], { cwd: repoPath }).catch(() => {});
      }
      throw addError;
    }

    const projectPath = subprojectPath ? path.join(worktreePath, subprojectPath) : worktreePath;

    await symlinkEnvFiles(repoPath, worktreePath, subprojectPath);

    await createGitignoreddirs(projectPath);

    copyDependenciesInBackground(repoPath, projectPath);

    return { success: true, worktreePath, branch };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface RemoveWorktreeResult {
  success: boolean;
  error?: string;
}

/**
 * Remove a worktree and its branch
 */
/**
 * `git worktree remove --force`, falling back to deleting the folder and
 * pruning git's registration when git can't delete it — on Windows, git
 * fails with "Filename too long" on deep node_modules paths, while Node's fs
 * handles long paths. Either way uncommitted changes are discarded, as with
 * `--force`.
 */
async function deleteWorktreeDir(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath });
    return;
  } catch (error) {
    if (!fs.existsSync(worktreePath)) throw error;
    console.warn(`[worktree] git could not remove ${worktreePath}, deleting it directly: ${gitErrorText(error)}`);
  }
  await fs.promises.rm(worktreePath, { recursive: true, force: true, maxRetries: 3 });
  await runCommand('git', ['worktree', 'prune'], { cwd: repoPath });
}

export async function removeWorktree(
  repoPath: string,
  taskId: number,
): Promise<RemoveWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const branch = await getTaskBranch(repoPath, taskId);

    await deleteWorktreeDir(repoPath, worktreePath);

    if (branch) {
      try {
        await runCommand('git', ['branch', '-D', assertValidBranchName(branch)], { cwd: repoPath });
      } catch {
        /* ignore */
      }
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface WorktreeStatusResult {
  success: boolean;
  branch?: string | null;
  ahead?: number;
  behind?: number;
  mainBranch?: string;
  worktreePath?: string;
  error?: string;
}

/**
 * Get worktree status including commits ahead/behind main
 */
export async function getWorktreeStatus(
  repoPath: string,
  taskId: number,
): Promise<WorktreeStatusResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    await fs.promises.access(worktreePath);

    const branch = await getBranchName(worktreePath);
    const mainBranch = assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');

    try {
      await runCommand('git', ['fetch', 'origin'], { cwd: worktreePath });
    } catch {
      /* ignore */
    }

    let ahead = 0;
    let behind = 0;
    try {
      const { stdout } = await runCommand(
        'git',
        ['rev-list', '--left-right', '--count', `origin/${mainBranch}...HEAD`],
        { cwd: worktreePath },
      );
      const parts = stdout.trim().split(/\s+/);
      behind = parseInt(parts[0] ?? '0', 10) || 0;
      ahead = parseInt(parts[1] ?? '0', 10) || 0;
    } catch {
      /* ignore */
    }

    return {
      success: true,
      branch,
      ahead,
      behind,
      mainBranch,
      worktreePath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Sync a worktree with the main branch (merge main into worktree branch)
 */
export async function syncWithMain(
  repoPath: string,
  taskId: number,
): Promise<RemoveWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const mainBranch = assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');

    await runCommand('git', ['fetch', 'origin'], { cwd: worktreePath });
    await runCommand('git', ['merge', `origin/${mainBranch}`], { cwd: worktreePath });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface CreatePRResult {
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Create a pull request for a task's worktree branch
 */
export async function createPullRequest(
  repoPath: string,
  taskId: number,
  title: string,
  body: string,
): Promise<CreatePRResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const branch = await getBranchName(worktreePath);
    if (!branch) {
      return { success: false, error: 'Could not determine worktree branch' };
    }
    assertValidBranchName(branch);

    await runCommand('git', ['push', '-u', 'origin', branch], { cwd: worktreePath });

    // Title and body pass straight through as argv. No escaping needed —
    // shell metacharacters inside title/body are literal bytes here.
    const { stdout } = await runCommand(
      'gh',
      ['pr', 'create', '--title', title, '--body', body],
      { cwd: worktreePath },
    );

    return { success: true, url: stdout.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface CICheck {
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | string;
  name?: string;
  state?: string;
  link?: string;
}

export interface CIStatus {
  status: 'none' | 'pending' | 'passed' | 'failed' | 'unknown';
  checks: CICheck[];
}

export interface PullRequestStatusResult {
  success: boolean;
  exists: boolean;
  url?: string;
  state?: string;
  mergeable?: string;
  ciStatus?: CIStatus;
  error?: string;
}

/**
 * The task's branch: what its worktree has checked out, else the local
 * `task/<id>-…` branch. The fallback matters when the worktree folder is
 * gone or is no longer a checkout (a half-finished cleanup on Windows).
 */
export async function getTaskBranch(repoPath: string, taskId: number): Promise<string | null> {
  const fromWorktree = await getBranchName(getWorktreePath(repoPath, taskId));
  if (fromWorktree) return fromWorktree;
  try {
    const { stdout } = await runCommand(
      'git',
      ['branch', '--list', '--format=%(refname:short)', `task/${taskId}-*`],
      { cwd: repoPath },
    );
    return stdout.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the status of a task branch's pull request. Looked up by branch name
 * from the main repo, so it works even when the worktree is gone.
 */
export async function getPullRequestStatus(
  repoPath: string,
  taskId: number,
): Promise<PullRequestStatusResult> {
  const branch = await getTaskBranch(repoPath, taskId);
  if (!branch) return { success: true, exists: false };

  try {
    const { stdout } = await runCommand(
      'gh',
      ['pr', 'view', assertValidBranchName(branch), '--json', 'url,state,mergeable'],
      { cwd: repoPath },
    );
    const prData = JSON.parse(stdout) as { url: string; state: string; mergeable: string };

    let ciStatus: CIStatus = { status: 'none', checks: [] };
    try {
      const { stdout: checksOutput } = await runCommand(
        'gh',
        ['pr', 'checks', branch, '--json', 'bucket,name,state,link'],
        { cwd: repoPath },
      );
      const checks = JSON.parse(checksOutput) as CICheck[];

      if (checks.length > 0) {
        const hasFailed = checks.some((c) => c.bucket === 'fail');
        const hasPending = checks.some((c) => c.bucket === 'pending');
        const allPassed = checks.every((c) => c.bucket === 'pass' || c.bucket === 'skipping');

        if (hasFailed) {
          ciStatus = { status: 'failed', checks };
        } else if (hasPending) {
          ciStatus = { status: 'pending', checks };
        } else if (allPassed) {
          ciStatus = { status: 'passed', checks };
        } else {
          ciStatus = { status: 'unknown', checks };
        }
      }
    } catch (checksError) {
      const code = (checksError as { code?: number }).code;
      if (code === 8) {
        ciStatus = { status: 'pending', checks: [] };
      }
    }

    return {
      success: true,
      exists: true,
      url: prData.url,
      state: prData.state,
      mergeable: prData.mergeable,
      ciStatus,
    };
  } catch {
    return { success: true, exists: false };
  }
}

export interface MergeAndCleanupResult extends RemoveWorktreeResult {
  /** The PR is merged, but removing the worktree or updating the default branch failed. */
  cleanupWarning?: string;
}

/**
 * Merge a task's pull request (unless it is already merged), then remove the
 * worktree and branch and pull the default branch. Once the PR is merged the
 * result is a success: cleanup problems come back as `cleanupWarning`.
 */
export async function mergeAndCleanup(
  repoPath: string,
  taskId: number,
): Promise<MergeAndCleanupResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);
  let branch: string;
  let mainBranch: string;

  try {
    const taskBranch = await getTaskBranch(repoPath, taskId);
    if (!taskBranch) {
      return { success: false, error: `Could not find the branch for task ${taskId}` };
    }
    branch = assertValidBranchName(taskBranch);
    mainBranch = assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');

    const pr = await getPullRequestStatus(repoPath, taskId);
    if (!(pr.exists && pr.state === 'MERGED')) {
      await mergePullRequest(repoPath, branch, mainBranch);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }

  const warnings: string[] = [];
  if (fs.existsSync(worktreePath)) {
    try {
      await deleteWorktreeDir(repoPath, worktreePath);
    } catch (error) {
      warnings.push(`Could not remove the worktree ${worktreePath}: ${gitErrorText(error)}`);
    }
  }
  try {
    await runCommand('git', ['branch', '-D', branch], { cwd: repoPath });
  } catch {
    /* already gone */
  }
  try {
    await runCommand('git', ['checkout', mainBranch], { cwd: repoPath });
    await runCommand('git', ['pull'], { cwd: repoPath });
  } catch (error) {
    warnings.push(`Could not update local ${mainBranch}: ${gitErrorText(error)}`);
  }

  return warnings.length ? { success: true, cleanupWarning: warnings.join('\n') } : { success: true };
}

/** `gh pr merge`, retrying GitHub's transient 502 / "merge in progress". */
async function mergePullRequest(repoPath: string, branch: string, mainBranch: string): Promise<void> {
  let lastMergeError: Error | null = null;
  for (let mergeAttempt = 0; mergeAttempt < 3; mergeAttempt++) {
    try {
      await runCommand('gh', ['pr', 'merge', branch, '--merge'], { cwd: repoPath });
      return;
    } catch (mergeError) {
      lastMergeError = mergeError instanceof Error ? mergeError : new Error(String(mergeError));
      const message = lastMergeError.message;
      const is502 = message.includes('502');
      const isMergeInProgress = message.includes('Merge already in progress');
      if (!is502 && !isMergeInProgress) break;

      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        await runCommand('git', ['fetch', 'origin'], { cwd: repoPath });
        const { stdout: branchHead } = await runCommand('git', ['rev-parse', branch], { cwd: repoPath });
        const { stdout: mergeCheck } = await runCommand(
          'git',
          ['branch', '-r', '--contains', branchHead.trim(), `origin/${mainBranch}`],
          { cwd: repoPath },
        );
        if (mergeCheck.trim().length > 0) return;
      } catch {
        /* will retry merge */
      }
    }
  }
  throw lastMergeError ?? new Error('Failed to merge after retries');
}

export interface UncommittedChangesResult {
  success: boolean;
  hasChanges?: boolean;
  error?: string;
}

/**
 * Check if there are uncommitted changes in a worktree
 */
export async function hasUncommittedChanges(
  repoPath: string,
  taskId: number,
): Promise<UncommittedChangesResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const { stdout } = await runCommand('git', ['status', '--porcelain'], { cwd: worktreePath });
    return { success: true, hasChanges: stdout.trim().length > 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Commit all changes in the worktree with a given message
 */
export async function commitAllChanges(
  repoPath: string,
  taskId: number,
  message: string,
): Promise<RemoveWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    await runCommand('git', ['add', '-A'], { cwd: worktreePath });

    // The commit message passes through argv — no quoting, no escaping. Even
    // `$(rm -rf ~)` would land as a literal commit message.
    await runCommand('git', ['commit', '-m', message], { cwd: worktreePath });

    return { success: true };
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    if (errMessage.includes('nothing to commit')) {
      return { success: true };
    }
    return { success: false, error: errMessage };
  }
}

/**
 * The branch a local merge targets. Unlike getDefaultBranch, never falls back
 * to whatever the main checkout has checked out — that would make the
 * "main checkout must be on the default branch" guard meaningless.
 */
async function getMergeTargetBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath,
    });
    return stdout.trim().replace('refs/remotes/origin/', '');
  } catch {
    // No remote HEAD — look for a conventional local default branch.
  }
  for (const candidate of ['main', 'master']) {
    if (await localBranchExists(repoPath, candidate)) return candidate;
  }
  return null;
}

export interface MergeLocallyResult {
  success: boolean;
  branch?: string;
  defaultBranch?: string;
  /** True when the merged default branch was pushed to `origin`. */
  pushed?: boolean;
  /** Set when there is a remote but the push failed; the merge is kept. */
  pushError?: string;
  error?: string;
}

export async function hasOriginRemote(repoPath: string): Promise<boolean> {
  try {
    await runCommand('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

function gitErrorText(error: unknown): string {
  // Failed-command messages carry stderr; some git output (e.g. CONFLICT
  // lines) only appears on stdout.
  const stdout = (error as { stdout?: string }).stdout?.trim();
  const message = error instanceof Error ? error.message : String(error);
  return stdout ? `${message.trim()}\n${stdout}` : message.trim();
}

export interface UpdateWorktreeResult {
  success: boolean;
  /** The ref that was merged into the task branch. */
  baseRef?: string;
  error?: string;
}

/**
 * Bring a task worktree up to date with the default branch before work starts
 * on it: merge `origin/<default>` (after a fetch) into the task branch, or the
 * local default branch when there is no remote or the fetch fails. A failed
 * merge is aborted so the worktree is left as it was.
 */
export async function updateWorktreeFromDefault(
  repoPath: string,
  taskId: number,
): Promise<UpdateWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);
  const target = await getMergeTargetBranch(repoPath);
  if (!target) {
    return {
      success: false,
      error: 'Could not determine the default branch (no origin/HEAD, main or master)',
    };
  }
  assertValidBranchName(target, 'default branch');

  let baseRef = target;
  if (await hasOriginRemote(repoPath)) {
    try {
      await runCommand('git', ['fetch', '--quiet', 'origin', target], {
        cwd: repoPath,
        timeout: 60_000,
      });
      baseRef = `origin/${target}`;
    } catch (error) {
      console.warn(`[worktree] git fetch failed in ${repoPath}, merging local ${target}: ${gitErrorText(error)}`);
    }
  }

  try {
    await runCommand('git', ['merge', '--no-edit', baseRef], { cwd: worktreePath });
    return { success: true, baseRef };
  } catch (error) {
    try {
      await runCommand('git', ['merge', '--abort'], { cwd: worktreePath });
    } catch {
      /* nothing to abort (the merge refused to start) */
    }
    return {
      success: false,
      baseRef,
      error: `Could not merge ${baseRef} into the task branch: ${gitErrorText(error)}`,
    };
  }
}

/**
 * "Merge without PR": sync the default branch from `origin`, commit any
 * uncommitted worktree changes, merge the task branch into the default branch
 * in the main checkout, push it when there is a remote, then remove the
 * worktree and branch. The worktree is kept whenever the merge does not
 * happen, so no work is lost; a failed push is reported but keeps the merge.
 */
export async function mergeLocally(
  repoPath: string,
  taskId: number,
  commitMessage: string,
): Promise<MergeLocallyResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const branch = await getBranchName(worktreePath);
    if (!branch) {
      return { success: false, error: 'Could not determine worktree branch' };
    }
    assertValidBranchName(branch);
    const target = await getMergeTargetBranch(repoPath);
    if (!target) {
      return {
        success: false,
        error: 'Could not determine the default branch: no origin/HEAD and no local main or master branch.',
      };
    }
    const defaultBranch = assertValidBranchName(target, 'default branch');

    const checkedOut = await getBranchName(repoPath);
    if (checkedOut !== defaultBranch) {
      return {
        success: false,
        error: `The main checkout must be on ${defaultBranch} to merge (it is on ${checkedOut || 'a detached HEAD'}). Check out ${defaultBranch} in ${repoPath} and try again.`,
      };
    }

    // Bring the local default branch up to date first, so the push below is
    // not rejected because PRs were merged on the remote in the meantime.
    const hasRemote = await hasOriginRemote(repoPath);
    if (hasRemote) {
      let fetched = false;
      try {
        await runCommand('git', ['fetch', '--quiet', 'origin', defaultBranch], {
          cwd: repoPath,
          timeout: 60_000,
        });
        fetched = true;
      } catch (fetchError) {
        // Offline or no such remote branch yet: merge locally; the push reports it.
        console.warn(`[merge-local] fetch failed in ${repoPath}: ${gitErrorText(fetchError)}`);
      }
      if (fetched) {
        try {
          await runCommand('git', ['merge', '--ff-only', `origin/${defaultBranch}`], {
            cwd: repoPath,
          });
        } catch (ffError) {
          return {
            success: false,
            error: `Could not update local ${defaultBranch} from origin/${defaultBranch} (it may have diverged, or local changes are in the way). Nothing was merged; the worktree was kept. ${gitErrorText(ffError)}`,
          };
        }
      }
    }

    // Check first: git reports "nothing to commit" on stdout, which the
    // failed-command error does not carry (same guard as createOrUpdatePR).
    const changes = await hasUncommittedChanges(repoPath, taskId);
    if (!changes.success) {
      return { success: false, error: `Failed to read worktree status: ${changes.error}` };
    }
    if (changes.hasChanges) {
      const commit = await commitAllChanges(repoPath, taskId, commitMessage);
      if (!commit.success) {
        return { success: false, error: `Failed to commit worktree changes: ${commit.error}` };
      }
    }

    try {
      await runCommand('git', ['merge', '--no-ff', '-m', `Merge ${branch}`, branch], {
        cwd: repoPath,
      });
    } catch (mergeError) {
      // Leave the main checkout as it was. Fails harmlessly when no merge is in
      // progress (e.g. git refused up front because local changes were in the way).
      await runCommand('git', ['merge', '--abort'], { cwd: repoPath }).catch(() => {});
      // git reports conflicts ("CONFLICT (content): …") on stdout, which the
      // failed-command message does not include.
      const stdout = (mergeError as { stdout?: string }).stdout?.trim();
      const message = stdout || (mergeError instanceof Error ? mergeError.message : String(mergeError));
      return {
        success: false,
        error: `Merging ${branch} into ${defaultBranch} failed; the worktree was kept. ${message}`,
      };
    }

    let pushed = false;
    let pushError: string | undefined;
    if (hasRemote) {
      try {
        await runCommand('git', ['push', 'origin', defaultBranch], {
          cwd: repoPath,
          timeout: 120_000,
        });
        pushed = true;
      } catch (error) {
        pushError = gitErrorText(error);
      }
    }

    const removed = await removeWorktree(repoPath, taskId);
    if (!removed.success) {
      return {
        success: false,
        error: `Merged into ${defaultBranch}${pushed ? ' and pushed' : ''}, but removing the worktree failed: ${removed.error}`,
      };
    }

    return { success: true, branch, defaultBranch, pushed, ...(pushError ? { pushError } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface PushChangesResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Push changes to remote for an existing PR
 */
export async function pushChanges(
  repoPath: string,
  taskId: number,
  commitMessage: string,
): Promise<PushChangesResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const { stdout: status } = await runCommand('git', ['status', '--porcelain'], {
      cwd: worktreePath,
    });

    if (status.trim().length > 0) {
      await runCommand('git', ['add', '-A'], { cwd: worktreePath });
      await runCommand('git', ['commit', '-m', commitMessage], { cwd: worktreePath });
    }

    const branch = await getBranchName(worktreePath);
    if (!branch) {
      return { success: false, error: 'Could not determine worktree branch' };
    }
    assertValidBranchName(branch);
    await runCommand('git', ['push', 'origin', branch], { cwd: worktreePath });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('nothing to commit') && message.includes('Everything up-to-date')) {
      return { success: true, message: 'Already up to date' };
    }
    if (message.includes('Everything up-to-date')) {
      return { success: true, message: 'Already up to date' };
    }
    return { success: false, error: message };
  }
}
