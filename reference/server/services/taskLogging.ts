import { z } from 'zod';
import { isMilestoneTitle } from '../../shared/milestones.js';
import {
  CREATE_INITIAL_TASKS_TITLE,
  appendTaskLink,
  buildTaskDoc,
  cleanTaskTitle,
  formatLeveledTitle,
  parseTaskLinks,
  type DependencyRef,
  type SessionTaskInfo,
} from './taskBreakdown.js';

/**
 * Logging tasks from any task conversation (extra/task-logging.md): the agent
 * turns what a chat found into a batch of tasks with dependencies, numbered by
 * dependency level like the initial breakdown, so autopilot runs them in order.
 *
 * The agent runs `scripts/log-tasks.ts`; everything here is pure or takes its
 * I/O as injected dependencies so it can be tested without the live database,
 * git, or the task archive.
 */

const LOGGED_TASKS_HEADING = 'Logged tasks';
const LOGGED_FROM_HEADING = 'Logged from';

const LoggedTaskSchema = z.object({
  key: z.string().trim().min(1, 'key must not be empty'),
  title: z.string().trim().min(1, 'title must not be empty'),
  /** A key of this batch, or the id of an existing task in the same project. */
  dependsOn: z
    .array(
      z.union([
        z.string().trim().min(1, 'dependsOn entries must not be empty'),
        z.number().int().positive('task ids must be positive integers'),
      ]),
    )
    .default([]),
  kind: z.enum(['task', 'milestone']).default('task'),
  spec: z.string().trim().min(1, 'spec must not be empty'),
  autopilotCanStart: z.boolean().default(true),
  autopilotCanWork: z.boolean().default(true),
});

const LoggedTaskListSchema = z.array(LoggedTaskSchema).min(1, 'the task list must contain at least one task');

export type LoggedTaskInput = z.infer<typeof LoggedTaskSchema>;

export interface ExistingTaskInfo {
  id: number;
  project_id: number;
  title: string | null;
  status: string;
}

/** Dependency level from a `N. ` title prefix; 0 when there is none. */
function existingLevel(title: string | null): number {
  const match = /^(\d+)\.\s/.exec(title ?? '');
  return match ? Number(match[1]) : 0;
}

export interface ValidatedLoggedTask extends LoggedTaskInput {
  level: number;
  /** Keys of this batch it depends on. */
  batchDeps: string[];
  /** Existing tasks it depends on. */
  existingDeps: DependencyRef[];
}

export type ValidateLoggedTasksResult =
  | { ok: true; tasks: ValidatedLoggedTask[] }
  | { ok: false; errors: string[] };

/**
 * Validate a batch and compute its levels. Reports every problem at once so
 * the agent can fix the JSON in one pass. Returns the tasks in topological
 * order (level, then the agent's order).
 */
export function validateLoggedTasks(
  input: unknown,
  projectId: number,
  getTask: (taskId: number) => ExistingTaskInfo | undefined,
): ValidateLoggedTasksResult {
  const parsed = LoggedTaskListSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const where = issue.path.length > 0 ? `task${issue.path.map((p) => `[${String(p)}]`).join('')}` : 'input';
        return `${where}: ${issue.message}`;
      }),
    };
  }

  const tasks = parsed.data.map((task) => ({ ...task, title: cleanTaskTitle(task.title) }));
  const errors: string[] = [];
  const describe = (task: LoggedTaskInput, index: number) => `task[${index}] "${task.key}"`;

  const keys = new Set<string>();
  tasks.forEach((task, index) => {
    if (keys.has(task.key)) errors.push(`${describe(task, index)}: duplicate key "${task.key}"`);
    keys.add(task.key);
  });

  const existingLevels = new Map<number, number>();
  const batchDeps = new Map<string, string[]>();
  const existingDeps = new Map<string, DependencyRef[]>();
  tasks.forEach((task, index) => {
    const seen = new Set<string | number>();
    const batch: string[] = [];
    const existing: DependencyRef[] = [];
    for (const dep of task.dependsOn) {
      if (seen.has(dep)) {
        errors.push(`${describe(task, index)}: dependency ${JSON.stringify(dep)} listed more than once`);
        continue;
      }
      seen.add(dep);
      if (typeof dep === 'string') {
        if (dep === task.key) errors.push(`${describe(task, index)}: depends on itself`);
        else if (!keys.has(dep)) errors.push(`${describe(task, index)}: unknown dependency "${dep}"`);
        else batch.push(dep);
        continue;
      }
      const row = getTask(dep);
      if (!row || row.project_id !== projectId) {
        errors.push(`${describe(task, index)}: task #${dep} does not exist in this project`);
        continue;
      }
      existingLevels.set(dep, existingLevel(row.title));
      existing.push({ id: dep, title: row.title ?? `task #${dep}` });
    }
    if (!batchDeps.has(task.key)) {
      batchDeps.set(task.key, batch);
      existingDeps.set(task.key, existing);
    }
  });

  for (const cycle of findCycles(batchDeps)) {
    errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const levels = new Map<string, number>();
  const levelOf = (key: string): number => {
    const cached = levels.get(key);
    if (cached !== undefined) return cached;
    const depLevels = [
      ...batchDeps.get(key)!.map(levelOf),
      ...existingDeps.get(key)!.map((dep) => existingLevels.get(dep.id) ?? 0),
    ];
    const level = 1 + Math.max(0, ...depLevels);
    levels.set(key, level);
    return level;
  };

  const leveled = tasks.map((task, index) => ({
    task: {
      ...task,
      level: levelOf(task.key),
      batchDeps: batchDeps.get(task.key)!,
      existingDeps: existingDeps.get(task.key)!,
    },
    index,
  }));
  leveled.sort((a, b) => a.task.level - b.task.level || a.index - b.index);
  return { ok: true, tasks: leveled.map(({ task }) => task) };
}

/** Cycles among the batch's own keys, each as a key path that starts and ends on the same key. */
function findCycles(deps: Map<string, string[]>): string[][] {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (key: string): void => {
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of deps.get(key) ?? []) {
      const depState = state.get(dep);
      if (depState === 'visiting') cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      else if (depState === undefined) visit(dep);
    }
    stack.pop();
    state.set(key, 'done');
  };
  for (const key of deps.keys()) {
    if (!state.has(key)) visit(key);
  }
  return cycles;
}

/** Task doc of a logged task: the spec, its dependencies, and where it was logged from. */
export function buildLoggedTaskDoc(spec: string, dependencies: DependencyRef[], source: DependencyRef): string {
  return `${buildTaskDoc(spec, dependencies)}\n## ${LOGGED_FROM_HEADING}\n\n- ${source.title} (task #${source.id})\n`;
}

// ---- Source task --------------------------------------------------------------

export interface SourceLookupDeps {
  getTask: (taskId: number) => SessionTaskInfo | undefined;
}

/** Milestone tasks and "Create initial tasks" sessions create tasks with their own scripts. */
export function canLogTasksFrom(title: string | null): boolean {
  return !isMilestoneTitle(title) && title !== CREATE_INITIAL_TASKS_TITLE;
}

type SourceLookup = { ok: true; source: SessionTaskInfo } | { ok: false; errors: string[] };

function findSource(sourceTaskId: number, deps: SourceLookupDeps): SourceLookup {
  const source = deps.getTask(sourceTaskId);
  if (!source) return { ok: false, errors: [`Task ${sourceTaskId} not found`] };
  if (isMilestoneTitle(source.title)) {
    return {
      ok: false,
      errors: [`Task ${sourceTaskId} is a milestone task: log its follow-up tasks with milestone-task.ts`],
    };
  }
  if (source.title === CREATE_INITIAL_TASKS_TITLE) {
    return {
      ok: false,
      errors: [`Task ${sourceTaskId} is a "${CREATE_INITIAL_TASKS_TITLE}" session: create its tasks with create-tasks.ts`],
    };
  }
  return { ok: true, source };
}

const sourceRef = (source: SessionTaskInfo): DependencyRef => ({
  id: source.id,
  title: source.title ?? `task #${source.id}`,
});

// ---- create -----------------------------------------------------------------

export interface LogTasksDeps extends SourceLookupDeps {
  isGitRepository: (repoPath: string) => Promise<boolean>;
  /** Ref new worktrees branch from (`origin/<default>` after a fetch). */
  resolveBaseRef: (repoPath: string) => Promise<string>;
  createTask: (
    projectId: number,
    title: string,
    userId: number | null,
    autopilot: { autopilotCanStart: boolean; autopilotCanWork: boolean },
  ) => { id: number };
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

export interface LoggedTask {
  key: string;
  id: number;
  level: number;
  title: string;
  dependsOn: DependencyRef[];
  autopilotCanStart: boolean;
  autopilotCanWork: boolean;
}

export type LogTasksResult =
  | { ok: true; created: LoggedTask[]; source: DependencyRef; baseRef: string | null }
  | { ok: false; errors: string[] };

/**
 * Create a validated batch in topological order, in the source task's project
 * and owned by its owner, and list them under the source doc's
 * `## Logged tasks`. All-or-nothing: on failure, every task, worktree and doc
 * created so far is removed and the source doc is left alone.
 */
export async function logTasks(sourceTaskId: number, input: unknown, deps: LogTasksDeps): Promise<LogTasksResult> {
  const lookup = findSource(sourceTaskId, deps);
  if (!lookup.ok) return lookup;
  const { source } = lookup;

  const validation = validateLoggedTasks(input, source.project_id, deps.getTask);
  if (!validation.ok) return validation;

  const repoPath = source.repo_folder_path;
  const isGit = await deps.isGitRepository(repoPath);
  const baseRef = isGit ? await deps.resolveBaseRef(repoPath) : null;
  const from = sourceRef(source);
  const created: Array<LoggedTask & { hasWorktree: boolean }> = [];
  const refsByKey = new Map<string, DependencyRef>();

  try {
    for (const task of validation.tasks) {
      const title = formatLeveledTitle(task.level, task.title, task.kind);
      const flags = { autopilotCanStart: task.autopilotCanStart, autopilotCanWork: task.autopilotCanWork };
      const row = deps.createTask(source.project_id, title, source.user_id, flags);
      const dependsOn = [...task.batchDeps.map((key) => refsByKey.get(key)!), ...task.existingDeps];
      const entry = { key: task.key, id: row.id, level: task.level, title, dependsOn, ...flags, hasWorktree: false };
      created.push(entry);

      if (baseRef) {
        const result = await deps.createWorktree(repoPath, row.id, title, source.subproject_path ?? null, baseRef);
        if (!result.success) {
          throw new Error(`Failed to create worktree for "${title}": ${result.error ?? 'unknown error'}`);
        }
        entry.hasWorktree = true;
      }
      deps.writeTaskDoc(source.project_id, row.id, buildLoggedTaskDoc(task.spec, dependsOn, from));
      refsByKey.set(task.key, { id: row.id, title });
    }

    let sourceDoc = deps.readTaskDoc(source.project_id, source.id);
    for (const task of created) sourceDoc = appendTaskLink(sourceDoc, LOGGED_TASKS_HEADING, task);
    deps.writeTaskDoc(source.project_id, source.id, sourceDoc);
  } catch (error) {
    const errors = [error instanceof Error ? error.message : String(error)];
    for (const task of [...created].reverse()) {
      try {
        if (task.hasWorktree) await deps.removeWorktree(repoPath, task.id);
        deps.deleteTaskArchive(source.project_id, task.id);
        deps.deleteTask(task.id);
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        errors.push(`Rollback of task ${task.id} failed: ${message}`);
      }
    }
    return { ok: false, errors };
  }

  return {
    ok: true,
    created: created.map(({ hasWorktree: _hasWorktree, ...task }) => task),
    source: from,
    baseRef,
  };
}

// ---- list -------------------------------------------------------------------

export interface ListLoggedTasksDeps extends SourceLookupDeps {
  readTaskDoc: (projectId: number, taskId: number) => string;
}

export type ListLoggedTasksResult =
  | { ok: true; tasks: Array<{ id: number; title: string | null; status: string }>; open: number }
  | { ok: false; errors: string[] };

/** The tasks listed under the source doc's `## Logged tasks`; deleted ones show as `deleted`. */
export function listLoggedTasks(sourceTaskId: number, deps: ListLoggedTasksDeps): ListLoggedTasksResult {
  const lookup = findSource(sourceTaskId, deps);
  if (!lookup.ok) return lookup;
  const { source } = lookup;
  const tasks = parseTaskLinks(deps.readTaskDoc(source.project_id, source.id), LOGGED_TASKS_HEADING).map((id) => {
    const task = deps.getTask(id);
    return task ? { id, title: task.title, status: task.status } : { id, title: null, status: 'deleted' };
  });
  const open = tasks.filter((task) => task.status !== 'completed' && task.status !== 'deleted').length;
  return { ok: true, tasks, open };
}

// ---- CLI --------------------------------------------------------------------

export type LogTasksArgs =
  | { ok: true; command: 'create'; sourceTaskId: number; jsonPath: string }
  | { ok: true; command: 'list'; sourceTaskId: number }
  | { ok: false; error: string };

export function parseLogTasksArgs(argv: string[]): LogTasksArgs {
  const [command, taskIdArg, jsonPath] = argv;
  if (command !== 'create' && command !== 'list') {
    return { ok: false, error: 'Command must be one of: create, list' };
  }
  if (!taskIdArg || !/^\d+$/.test(taskIdArg)) {
    return { ok: false, error: 'Source task ID must be a positive integer' };
  }
  const sourceTaskId = parseInt(taskIdArg, 10);
  if (command === 'list') return { ok: true, command, sourceTaskId };
  if (!jsonPath) return { ok: false, error: 'create needs a JSON path' };
  return { ok: true, command, sourceTaskId, jsonPath };
}
