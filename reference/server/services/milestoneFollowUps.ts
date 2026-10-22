import { z } from 'zod';
import { isMilestoneTitle } from '../../shared/milestones.js';
import { buildTaskDoc, cleanTaskTitle, type DependencyRef, type SessionTaskInfo } from './taskBreakdown.js';

/**
 * Follow-up tasks of a milestone verification session (extra/project-bootstrap.md,
 * "Follow-up tasks"): every change the human asks for while verifying a
 * milestone becomes its own task, ready to start, so it goes through the full
 * pipeline instead of being patched in the chat.
 *
 * The session runs `scripts/milestone-task.ts`; everything here is pure or
 * takes its I/O as injected dependencies so it can be tested without the live
 * database, git, or the task archive.
 */

const FollowUpTaskSchema = z.object({
  title: z.string().trim().min(1, 'title must not be empty'),
  spec: z.string().trim().min(1, 'spec must not be empty'),
});

export type FollowUpTaskInput = z.infer<typeof FollowUpTaskSchema>;

const FOLLOW_UPS_HEADING = /^##\s+follow-up tasks\s*$/i;
const SECTION_END = /^#{1,2}\s/;

/** Task doc of a follow-up: the spec, no dependencies, and where it came from. */
export function buildFollowUpDoc(spec: string, milestone: DependencyRef): string {
  return `${buildTaskDoc(spec, [])}\n## Raised in\n\n- ${milestone.title} (task #${milestone.id})\n`;
}

/** Add `- <title> (task #N)` to the doc's `## Follow-up tasks` section, creating it at the end when missing. */
export function appendFollowUp(doc: string, task: DependencyRef): string {
  const entry = `- ${task.title} (task #${task.id})`;
  const trimmed = doc.replace(/\s+$/, '');
  if (trimmed === '') return `## Follow-up tasks\n\n${entry}\n`;

  const lines = trimmed.split(/\r?\n/);
  const start = lines.findIndex((line) => FOLLOW_UPS_HEADING.test(line.trim()));
  if (start === -1) return `${trimmed}\n\n## Follow-up tasks\n\n${entry}\n`;

  let end = lines.findIndex((line, i) => i > start && SECTION_END.test(line.trim()));
  if (end === -1) end = lines.length;
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1]!.trim() === '') insertAt--;

  const inserted = insertAt === start + 1 ? ['', entry] : [entry];
  if (insertAt < lines.length && lines[insertAt]!.trim() !== '') inserted.push('');
  lines.splice(insertAt, 0, ...inserted);
  return `${lines.join('\n')}\n`;
}

/** Task ids referenced as `(task #N)` in the doc's `## Follow-up tasks` section. */
export function parseFollowUps(doc: string): number[] {
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((line) => FOLLOW_UPS_HEADING.test(line.trim()));
  if (start === -1) return [];
  const ids: number[] = [];
  for (const line of lines.slice(start + 1)) {
    if (SECTION_END.test(line.trim())) break;
    for (const match of line.matchAll(/task\s*#(\d+)/gi)) {
      ids.push(Number(match[1]));
    }
  }
  return [...new Set(ids)];
}

// ---- Shared lookup ----------------------------------------------------------

export interface FollowUpTaskInfo {
  id: number;
  title: string | null;
  status: string;
}

export interface MilestoneLookupDeps {
  getTask: (taskId: number) => SessionTaskInfo | undefined;
}

type MilestoneLookup = { ok: true; milestone: SessionTaskInfo } | { ok: false; errors: string[] };

function findOpenMilestone(milestoneTaskId: number, deps: MilestoneLookupDeps): MilestoneLookup {
  const milestone = deps.getTask(milestoneTaskId);
  if (!milestone) return { ok: false, errors: [`Task ${milestoneTaskId} not found`] };
  if (!isMilestoneTitle(milestone.title)) {
    return { ok: false, errors: [`Task ${milestoneTaskId} is not a milestone task`] };
  }
  if (milestone.status === 'completed') {
    return { ok: false, errors: [`Milestone task ${milestoneTaskId} is already completed`] };
  }
  return { ok: true, milestone };
}

// ---- create -----------------------------------------------------------------

export interface CreateFollowUpDeps extends MilestoneLookupDeps {
  isGitRepository: (repoPath: string) => Promise<boolean>;
  /** The milestone task's branch, or null when it has none. */
  getTaskBranch: (repoPath: string, taskId: number) => Promise<string | null>;
  /** Fallback base (`origin/<default>` after a fetch) when the milestone has no branch. */
  resolveBaseRef: (repoPath: string) => Promise<string>;
  createTask: (projectId: number, title: string, userId: number | null) => { id: number };
  deleteTask: (taskId: number) => void;
  createWorktree: (
    repoPath: string,
    taskId: number,
    title: string,
    subprojectPath: string | null,
    baseRef: string,
  ) => Promise<{ success: boolean; error?: string }>;
  removeWorktree: (repoPath: string, taskId: number) => Promise<unknown>;
  readTaskDoc: (projectId: number, taskId: number) => string;
  writeTaskDoc: (projectId: number, taskId: number, content: string) => void;
  deleteTaskArchive: (projectId: number, taskId: number) => void;
}

export type CreateFollowUpResult =
  | { ok: true; task: DependencyRef; baseRef: string | null; milestone: DependencyRef }
  | { ok: false; errors: string[] };

/**
 * Create one follow-up task of a milestone: same project and owner, branched
 * from the milestone's branch, linked both ways through the task docs.
 * All-or-nothing: on failure the task, its worktree and doc are removed.
 */
export async function createFollowUpTask(
  milestoneTaskId: number,
  input: unknown,
  deps: CreateFollowUpDeps,
): Promise<CreateFollowUpResult> {
  const lookup = findOpenMilestone(milestoneTaskId, deps);
  if (!lookup.ok) return lookup;
  const { milestone } = lookup;

  const parsed = FollowUpTaskSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`),
    };
  }
  const title = cleanTaskTitle(parsed.data.title);
  const milestoneRef: DependencyRef = { id: milestone.id, title: milestone.title ?? `task #${milestone.id}` };

  const repoPath = milestone.repo_folder_path;
  const isGit = await deps.isGitRepository(repoPath);
  const baseRef = isGit
    ? (await deps.getTaskBranch(repoPath, milestone.id)) ?? (await deps.resolveBaseRef(repoPath))
    : null;

  let createdId: number | null = null;
  let hasWorktree = false;
  try {
    createdId = deps.createTask(milestone.project_id, title, milestone.user_id).id;
    if (baseRef) {
      const result = await deps.createWorktree(repoPath, createdId, title, milestone.subproject_path ?? null, baseRef);
      if (!result.success) {
        throw new Error(`Failed to create worktree for "${title}": ${result.error ?? 'unknown error'}`);
      }
      hasWorktree = true;
    }
    deps.writeTaskDoc(milestone.project_id, createdId, buildFollowUpDoc(parsed.data.spec, milestoneRef));

    const task = { id: createdId, title };
    const milestoneDoc = deps.readTaskDoc(milestone.project_id, milestone.id);
    deps.writeTaskDoc(milestone.project_id, milestone.id, appendFollowUp(milestoneDoc, task));
    return { ok: true, task, baseRef, milestone: milestoneRef };
  } catch (error) {
    const errors = [error instanceof Error ? error.message : String(error)];
    if (createdId !== null) {
      try {
        if (hasWorktree) await deps.removeWorktree(repoPath, createdId);
        deps.deleteTaskArchive(milestone.project_id, createdId);
        deps.deleteTask(createdId);
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        errors.push(`Rollback of task ${createdId} failed: ${message}`);
      }
    }
    return { ok: false, errors };
  }
}

// ---- list -------------------------------------------------------------------

export interface ListFollowUpsDeps extends MilestoneLookupDeps {
  readTaskDoc: (projectId: number, taskId: number) => string;
}

export type ListFollowUpsResult =
  | { ok: true; tasks: FollowUpTaskInfo[]; open: number }
  | { ok: false; errors: string[] };

/** The milestone's follow-up tasks and their status; deleted ones show as `deleted`. */
export function listFollowUpTasks(milestoneTaskId: number, deps: ListFollowUpsDeps): ListFollowUpsResult {
  const milestone = deps.getTask(milestoneTaskId);
  if (!milestone) return { ok: false, errors: [`Task ${milestoneTaskId} not found`] };
  if (!isMilestoneTitle(milestone.title)) {
    return { ok: false, errors: [`Task ${milestoneTaskId} is not a milestone task`] };
  }
  const tasks = parseFollowUps(deps.readTaskDoc(milestone.project_id, milestone.id)).map((id) => {
    const task = deps.getTask(id);
    return task ? { id, title: task.title, status: task.status } : { id, title: null, status: 'deleted' };
  });
  const open = tasks.filter((task) => task.status !== 'completed' && task.status !== 'deleted').length;
  return { ok: true, tasks, open };
}

// ---- sync -------------------------------------------------------------------

export interface SyncMilestoneDeps extends MilestoneLookupDeps {
  worktreeExists: (repoPath: string, taskId: number) => Promise<boolean>;
  updateWorktreeFromDefault: (
    repoPath: string,
    taskId: number,
  ) => Promise<{ success: boolean; baseRef?: string; error?: string }>;
}

export type SyncMilestoneResult = { ok: true; baseRef: string | null } | { ok: false; errors: string[] };

/** Merge the default branch into the milestone's worktree so merged follow-ups can be re-verified. */
export async function syncMilestoneWorktree(
  milestoneTaskId: number,
  deps: SyncMilestoneDeps,
): Promise<SyncMilestoneResult> {
  const lookup = findOpenMilestone(milestoneTaskId, deps);
  if (!lookup.ok) return lookup;
  const { milestone } = lookup;
  if (!(await deps.worktreeExists(milestone.repo_folder_path, milestone.id))) {
    return { ok: false, errors: [`Milestone task ${milestone.id} has no worktree`] };
  }
  const result = await deps.updateWorktreeFromDefault(milestone.repo_folder_path, milestone.id);
  return result.success
    ? { ok: true, baseRef: result.baseRef ?? null }
    : { ok: false, errors: [result.error ?? 'Could not update the worktree'] };
}

// ---- CLI --------------------------------------------------------------------

export type MilestoneTaskArgs =
  | { ok: true; command: 'create'; milestoneTaskId: number; jsonPath: string }
  | { ok: true; command: 'list' | 'sync'; milestoneTaskId: number }
  | { ok: false; error: string };

export function parseMilestoneTaskArgs(argv: string[]): MilestoneTaskArgs {
  const [command, taskIdArg, jsonPath] = argv;
  if (command !== 'create' && command !== 'list' && command !== 'sync') {
    return { ok: false, error: 'Command must be one of: create, list, sync' };
  }
  if (!taskIdArg || !/^\d+$/.test(taskIdArg)) {
    return { ok: false, error: 'Milestone task ID must be a positive integer' };
  }
  const milestoneTaskId = parseInt(taskIdArg, 10);
  if (command !== 'create') return { ok: true, command, milestoneTaskId };
  if (!jsonPath) return { ok: false, error: 'create needs a JSON path' };
  return { ok: true, command, milestoneTaskId, jsonPath };
}
