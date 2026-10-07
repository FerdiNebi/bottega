// Autopilot extra (extra/autopilot.md): run a project's tasks one at a time,
// in dependency order, through the whole pipeline, and merge each one when it
// passes — no human gates, no questions.
//
// The flag lives on the project row and is read at every decision point, so
// unticking it mid-run degrades to the normal pipeline after the current turn.
// The completion handler (agentRunLifecycle.ts) calls in here through a
// dynamic import; this module imports agentRunner statically.

import { tasksDb, agentRunsDb, projectsDb } from '../database/db.js';
import { startAgentRun } from './agentRunner.js';
import { isAutopilotProject } from './autopilotFlag.js';
import { readTaskDoc } from './documentation.js';
import {
  createWorktree,
  getPullRequestStatus,
  hasOriginRemote,
  isGitRepository,
  mergeAndCleanup,
  mergeLocally,
  resolveBootstrapBase,
  updateWorktreeFromDefault,
  worktreeExists,
} from './worktree.js';
import { switchWorktree } from './webServerManager.js';
import { ProviderCredentialsMissingError } from './credentials/types.js';
import type { ProjectRow, TaskRow } from '../database/db.js';
import type { AutopilotStatusResponse } from '@shared/api/projects';
import type {
  AgentType,
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';

export interface AutopilotContext {
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  userId?: number | undefined;
}

// ---- Selection (pure) -------------------------------------------------------

/** Task ids referenced as `(task #N)` in the doc's `## Depends on` section. */
export function parseDependsOn(doc: string): number[] {
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+depends on\s*$/i.test(line.trim()));
  if (start === -1) return [];
  const ids: number[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line.trim())) break;
    for (const match of line.matchAll(/task\s*#(\d+)/gi)) {
      ids.push(Number(match[1]));
    }
  }
  return [...new Set(ids)];
}

/** Dependency level from a `N. ` title prefix, or null when there is none. */
export function parseLevel(title: string | null): number | null {
  const match = /^(\d+)\.\s/.exec(title ?? '');
  return match ? Number(match[1]) : null;
}

export interface AutopilotTaskInfo {
  task: TaskRow;
  hasAgentRuns: boolean;
  runningAgentType: AgentType | null;
  /** Only read for pending tasks. */
  dependsOn: number[];
}

export interface AutopilotPlan {
  running: { task: TaskRow; agentType: AgentType } | null;
  ready: TaskRow[];
  waiting: TaskRow[];
  blocked: TaskRow[];
}

const STARTED_STATUSES = new Set(['in_progress', 'in_review']);

export function planAutopilot(infos: AutopilotTaskInfo[]): AutopilotPlan {
  const statusById = new Map(infos.map((i) => [i.task.id, i.task.status]));
  // A dependency that no longer exists can never complete, so it doesn't block.
  const resolved = (id: number) => !statusById.has(id) || statusById.get(id) === 'completed';

  const plan: AutopilotPlan = { running: null, ready: [], waiting: [], blocked: [] };
  for (const info of infos) {
    const { task } = info;
    if (info.runningAgentType) {
      plan.running ??= { task, agentType: info.runningAgentType };
      continue;
    }
    if (task.status === 'pending') {
      (info.dependsOn.every(resolved) ? plan.ready : plan.waiting).push(task);
    } else if (STARTED_STATUSES.has(task.status) && info.hasAgentRuns) {
      (task.workflow_blocked ? plan.blocked : plan.ready).push(task);
    }
  }

  plan.ready.sort((a, b) => {
    const started = Number(b.status !== 'pending') - Number(a.status !== 'pending');
    if (started !== 0) return started;
    const levelA = parseLevel(a.title) ?? Number.POSITIVE_INFINITY;
    const levelB = parseLevel(b.title) ?? Number.POSITIVE_INFINITY;
    if (levelA !== levelB) return levelA - levelB;
    return a.id - b.id;
  });
  return plan;
}

export type AutopilotStep = AgentType | 'finish';

/** What to run for a task, continuing from where its flags say it stopped. */
export function nextStepForTask(task: TaskRow, hasRemote: boolean): AutopilotStep {
  if (task.pr_agent_complete) return 'finish';
  if (task.yolo_mode) return 'yolo';
  if (task.workflow_complete) {
    if (!task.refinement_complete) return 'refinement';
    return hasRemote ? 'pr' : 'finish';
  }
  if (task.planification_complete) return 'implementation';
  return 'planification';
}

// ---- DB-backed state ----------------------------------------------------------

export function collectTaskInfos(projectId: number): AutopilotTaskInfo[] {
  return tasksDb.getByProject(projectId).map((task) => {
    const runs = agentRunsDb.getByTask(task.id);
    return {
      task,
      hasAgentRuns: runs.length > 0,
      runningAgentType: runs.find((r) => r.status === 'running')?.agent_type ?? null,
      dependsOn: task.status === 'pending' ? parseDependsOn(readTaskDoc(projectId, task.id)) : [],
    };
  });
}

export function getAutopilotPlan(projectId: number): AutopilotPlan {
  return planAutopilot(collectTaskInfos(projectId));
}

export async function getAutopilotStatus(project: ProjectRow): Promise<AutopilotStatusResponse> {
  const isGit = await isGitRepository(project.repo_folder_path);
  const plan = getAutopilotPlan(project.id);
  const next = plan.ready[0];
  return {
    enabled: project.autopilot_enabled === 1,
    isGitRepository: isGit,
    running: plan.running
      ? {
          taskId: plan.running.task.id,
          title: plan.running.task.title,
          agentType: plan.running.agentType,
        }
      : null,
    next: next ? { taskId: next.id, title: next.title } : null,
    readyCount: plan.ready.length,
    waitingCount: plan.waiting.length,
    blockedCount: plan.blocked.length,
    message: project.autopilot_message,
  };
}

function label(task: Pick<TaskRow, 'id' | 'title'>): string {
  return task.title ? `task #${task.id} "${task.title}"` : `task #${task.id}`;
}

function setMessage(projectId: number, message: string): void {
  console.log(`[Autopilot] project ${projectId}: ${message}`);
  projectsDb.setAutopilotMessage(projectId, message);
}

export function stopAutopilot(projectId: number, reason: string): void {
  setMessage(projectId, `Stopped: ${reason}`);
}

// One start/finish at a time per project, so two completion handlers (or a
// handler and a Start click) can never start two tasks.
const busyProjects = new Set<number>();

export function isAutopilotBusy(projectId: number): boolean {
  return busyProjects.has(projectId);
}

async function withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T | 'busy'> {
  if (busyProjects.has(projectId)) return 'busy';
  busyProjects.add(projectId);
  try {
    return await fn();
  } finally {
    busyProjects.delete(projectId);
  }
}

// ---- Start ------------------------------------------------------------------

export type StartNextResult =
  | { status: 'started'; taskId: number; step: AutopilotStep }
  | { status: 'finished'; taskId: number }
  | { status: 'disabled' | 'busy' | 'running' | 'idle' | 'failed'; message: string };

/** Pick the next ready task and start (or finish) it. */
export async function startNextAutopilotTask(
  projectId: number,
  ctx: AutopilotContext,
): Promise<StartNextResult> {
  const result = await withProjectLock(projectId, () => startNextLocked(projectId, ctx));
  return result === 'busy'
    ? { status: 'busy', message: 'Autopilot is already starting or finishing a task' }
    : result;
}

async function startNextLocked(projectId: number, ctx: AutopilotContext): Promise<StartNextResult> {
  const project = projectsDb.getByIdAdmin(projectId);
  if (!project || project.autopilot_enabled !== 1) {
    return { status: 'disabled', message: 'Autopilot is off for this project' };
  }

  const plan = getAutopilotPlan(projectId);
  if (plan.running) {
    return {
      status: 'running',
      message: `${label(plan.running.task)} is already running (${plan.running.agentType})`,
    };
  }

  const task = plan.ready[0];
  if (!task) {
    let message: string;
    if (plan.waiting.length === 0 && plan.blocked.length === 0) {
      message = 'Done: no tasks left to run.';
    } else if (plan.blocked.length > 0) {
      message = `Stopped: ${plan.blocked.map(label).join(', ')} blocked; ${plan.waiting.length} task(s) waiting on dependencies.`;
    } else {
      message = `Stopped: ${plan.waiting.length} task(s) wait on dependencies that aren't completed.`;
    }
    setMessage(projectId, message);
    return { status: 'idle', message };
  }

  const repoPath = project.repo_folder_path;
  try {
    if (task.status === 'pending') {
      const prepared = await prepareWorktree(repoPath, task, project.subproject_path);
      if (prepared) {
        stopAutopilot(projectId, `${label(task)}: ${prepared}`);
        return { status: 'failed', message: prepared };
      }
    }

    const step = nextStepForTask(task, await hasOriginRemote(repoPath));
    if (step === 'finish') {
      const finished = await finishLocked(task.id, ctx);
      return finished
        ? { status: 'finished', taskId: task.id }
        : { status: 'failed', message: projectsDb.getByIdAdmin(projectId)?.autopilot_message ?? '' };
    }

    await startAgentRun(task.id, step, ctx);
    setMessage(projectId, `Running ${label(task)} (${step}).`);
    return { status: 'started', taskId: task.id, step };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stopAutopilot(projectId, `could not start ${label(task)}: ${message}`);
    // The Start route turns this into the usual 403 "connect the provider".
    if (error instanceof ProviderCredentialsMissingError) throw error;
    return { status: 'failed', message };
  }
}

/** Returns an error message, or null when the worktree is ready. */
async function prepareWorktree(
  repoPath: string,
  task: TaskRow,
  subprojectPath: string | null,
): Promise<string | null> {
  if (await worktreeExists(repoPath, task.id)) {
    const updated = await updateWorktreeFromDefault(repoPath, task.id);
    return updated.success ? null : updated.error ?? 'worktree update failed';
  }
  const { baseRef } = await resolveBootstrapBase(repoPath);
  const created = await createWorktree(repoPath, task.id, task.title ?? undefined, subprojectPath, baseRef);
  return created.success ? null : `could not create the worktree: ${created.error}`;
}

// ---- Finish -----------------------------------------------------------------

/**
 * Merge a finished task (PR merge or local merge), mark it completed, and
 * start the next one after the usual settle delay.
 */
export async function finishAutopilotTask(taskId: number, ctx: AutopilotContext): Promise<void> {
  const projectId = tasksDb.getById(taskId)?.project_id;
  if (projectId == null) return;
  const result = await withProjectLock(projectId, () => finishLocked(taskId, ctx));
  if (result === 'busy') {
    console.warn(`[Autopilot] project ${projectId} busy; not finishing task ${taskId} twice`);
  }
}

/** Returns true when the task was merged and the next task was scheduled. */
async function finishLocked(taskId: number, ctx: AutopilotContext): Promise<boolean> {
  const task = tasksDb.getWithProject(taskId);
  if (!task) return false;
  const projectId = task.project_id;
  const project = projectsDb.getByIdAdmin(projectId);
  if (!project || project.autopilot_enabled !== 1) return false;

  const repoPath = task.repo_folder_path;
  const merged = await mergeTask(repoPath, task);
  if (!merged.ok) {
    stopAutopilot(projectId, `${label(task)}: ${merged.reason}`);
    return false;
  }

  tasksDb.update(taskId, { status: 'completed' });

  const userId = ctx.userId ?? task.user_id ?? project.user_id;
  if (project.active_worktree_task_id === taskId && project.serve_symlink_path) {
    try {
      await switchWorktree(projectId, null, userId);
    } catch (error) {
      console.error('[Autopilot] Failed to switch the web server back to main:', error);
    }
  }

  setMessage(projectId, `Merged ${label(task)}${merged.note ? ` (${merged.note})` : ''}; starting the next task.`);

  setTimeout(() => {
    startNextAutopilotTask(projectId, { ...ctx, userId }).catch((error: unknown) => {
      console.error('[Autopilot] Failed to start the next task:', error);
    });
  }, 1000);
  return true;
}

function withWarning(note: string, warning: string | undefined): string {
  return warning ? `${note}; cleanup warning: ${warning}` : note;
}

type MergeOutcome ={ ok: true; note?: string } | { ok: false; reason: string };

async function mergeTask(
  repoPath: string,
  task: TaskRow,
): Promise<MergeOutcome> {
  if (!(await worktreeExists(repoPath, task.id))) {
    return { ok: true, note: 'no worktree to merge' };
  }

  if (await hasOriginRemote(repoPath)) {
    const pr = await getPullRequestStatus(repoPath, task.id);
    if (pr.exists) {
      if (pr.state === 'MERGED') {
        // Merged by hand, or an earlier finish merged it but its cleanup
        // failed: mergeAndCleanup skips the merge and just cleans up.
        const result = await mergeAndCleanup(repoPath, task.id);
        return result.success
          ? { ok: true, note: withWarning('the PR was already merged', result.cleanupWarning) }
          : { ok: false, reason: `cleaning up after ${pr.url} failed: ${result.error}` };
      }
      if (pr.state !== 'OPEN') {
        return { ok: false, reason: `the PR is ${String(pr.state).toLowerCase()} (${pr.url})` };
      }
      const ci = pr.ciStatus?.status ?? 'none';
      if (ci !== 'passed' && ci !== 'none') {
        return { ok: false, reason: `CI is ${ci} on ${pr.url}` };
      }
      if (pr.mergeable !== 'MERGEABLE') {
        return { ok: false, reason: `the PR is not mergeable (${pr.mergeable}): ${pr.url}` };
      }
      const result = await mergeAndCleanup(repoPath, task.id);
      return result.success
        ? { ok: true, note: withWarning(`merged ${pr.url}`, result.cleanupWarning) }
        : { ok: false, reason: `merging ${pr.url} failed: ${result.error}` };
    }
  }

  const result = await mergeLocally(repoPath, task.id, task.title || `Task #${task.id}`);
  if (!result.success) {
    return { ok: false, reason: result.error ?? 'the local merge failed' };
  }
  if (result.pushError) {
    return { ok: true, note: `merged locally, push failed: ${result.pushError}` };
  }
  return { ok: true, note: result.pushed ? 'merged locally and pushed' : 'merged locally' };
}

// ---- Completion-handler hooks -------------------------------------------------

/**
 * Called by the completion handler after a run ends normally. Returns true
 * when autopilot handled the transition (the core rules must not chain).
 */
export async function onAutopilotRunCompleted(
  taskId: number,
  agentType: AgentType,
  ctx: AutopilotContext,
): Promise<boolean> {
  const task = tasksDb.getById(taskId);
  if (!task || !isAutopilotProject(task.project_id)) return false;
  const projectId = task.project_id;

  if (agentType === 'pr' || agentType === 'yolo') {
    if (task.pr_agent_complete) {
      await finishAutopilotTask(taskId, ctx);
    } else {
      stopAutopilot(projectId, `${label(task)}: the ${agentType} agent ended without signalling a green, mergeable PR.`);
    }
    return true;
  }

  if (agentType === 'planification' && !task.planification_complete) {
    stopAutopilot(projectId, `${label(task)}: planning ended without a completed plan.`);
    return true;
  }
  return false;
}

/**
 * The PR was marked complete (`complete-pr.ts`) in a conversation that isn't
 * a normally-ended agent run — e.g. the user continued a stopped PR run by
 * hand. Finish the task as if the PR agent had. Returns true when it did.
 */
export async function finishIfPrCompletedOutsideRun(
  taskId: number,
  ctx: AutopilotContext,
): Promise<boolean> {
  const task = tasksDb.getById(taskId);
  if (!task || !isAutopilotProject(task.project_id)) return false;
  if (!task.pr_agent_complete || task.status === 'completed') return false;
  if (agentRunsDb.getByTask(taskId).some((r) => r.status === 'running')) return false;
  await finishAutopilotTask(taskId, ctx);
  return true;
}

/** The finish pipeline would start the PR agent; without a remote, merge instead. */
export async function shouldSkipPrAgent(taskId: number, repoPath: string): Promise<boolean> {
  const task = tasksDb.getById(taskId);
  if (!task || !isAutopilotProject(task.project_id)) return false;
  return !(await hasOriginRemote(repoPath));
}

export function onAutopilotLoopStopped(taskId: number, reason: string): void {
  const task = tasksDb.getById(taskId);
  if (!task || !isAutopilotProject(task.project_id)) return;
  stopAutopilot(task.project_id, `${label(task)}: ${reason}`);
}
