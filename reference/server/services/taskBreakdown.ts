import { z } from 'zod';

/**
 * Task breakdown for the project-bootstrap extra ("Create initial tasks").
 *
 * The breakdown agent writes its confirmed task list as JSON and runs
 * `scripts/create-tasks.ts`, which validates the list, computes dependency
 * levels, and creates the tasks. Everything here is pure or takes its I/O as
 * injected dependencies so it can be tested without the live database, git,
 * or the task archive. See extra/project-bootstrap.md.
 */

/** Fixed title of the session task that owns a breakdown run. */
export const CREATE_INITIAL_TASKS_TITLE = 'Create initial tasks';

const TaskBreakdownItemSchema = z.object({
  key: z.string().trim().min(1, 'key must not be empty'),
  title: z.string().trim().min(1, 'title must not be empty'),
  dependsOn: z.array(z.string().trim().min(1, 'dependsOn entries must not be empty')).default([]),
  spec: z.string().trim().min(1, 'spec must not be empty'),
});

export const TaskBreakdownSchema = z
  .array(TaskBreakdownItemSchema)
  .min(1, 'the task list must contain at least one task');

export type TaskBreakdownItem = z.infer<typeof TaskBreakdownItemSchema>;

export type ValidateTaskListResult =
  | { ok: true; tasks: TaskBreakdownItem[] }
  | { ok: false; errors: string[] };

// The level prefix is computed, never trusted from the model — drop any the
// agent put on a title so "2. Auth" doesn't become "2. 2. Auth".
const LEVEL_PREFIX = /^\d+\.\s+/;

function describeTask(task: TaskBreakdownItem, index: number): string {
  return `task[${index}] "${task.key}"`;
}

/**
 * Validate a parsed JSON task list. Reports every problem at once so the
 * agent can fix the JSON in a single pass.
 */
export function validateTaskList(input: unknown): ValidateTaskListResult {
  const parsed = TaskBreakdownSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const where = issue.path.length > 0 ? `task${issue.path.map((p) => `[${String(p)}]`).join('')}` : 'input';
        return `${where}: ${issue.message}`;
      }),
    };
  }

  const tasks = parsed.data.map((task) => ({
    ...task,
    title: task.title.replace(LEVEL_PREFIX, '').trim() || task.title,
  }));
  const errors: string[] = [];

  const seen = new Set<string>();
  tasks.forEach((task, index) => {
    if (seen.has(task.key)) {
      errors.push(`${describeTask(task, index)}: duplicate key "${task.key}"`);
    }
    seen.add(task.key);
  });

  tasks.forEach((task, index) => {
    const deps = new Set<string>();
    for (const dep of task.dependsOn) {
      if (dep === task.key) {
        errors.push(`${describeTask(task, index)}: depends on itself`);
      } else if (!seen.has(dep)) {
        errors.push(`${describeTask(task, index)}: unknown dependency "${dep}"`);
      } else if (deps.has(dep)) {
        errors.push(`${describeTask(task, index)}: dependency "${dep}" listed more than once`);
      }
      deps.add(dep);
    }
  });

  for (const cycle of findCycles(tasks)) {
    errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, tasks };
}

/**
 * Find dependency cycles (ignoring self-dependencies and unknown keys, which
 * validateTaskList reports separately). Each cycle is returned as a key path
 * that starts and ends on the same key.
 */
function findCycles(tasks: TaskBreakdownItem[]): string[][] {
  const deps = new Map<string, string[]>();
  for (const task of tasks) {
    if (!deps.has(task.key)) deps.set(task.key, task.dependsOn);
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (key: string): void => {
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of deps.get(key) ?? []) {
      if (dep === key || !deps.has(dep)) continue;
      const depState = state.get(dep);
      if (depState === 'visiting') {
        cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      } else if (depState === undefined) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(key, 'done');
  };

  for (const key of deps.keys()) {
    if (!state.has(key)) visit(key);
  }
  return cycles;
}

/**
 * Dependency level of every task:
 *   level(t) = 1                              if t has no dependencies
 *   level(t) = 1 + max(level(d) for d in deps) otherwise
 * Expects a list that passed validateTaskList (no cycles, known keys).
 */
export function computeLevels(tasks: TaskBreakdownItem[]): Map<string, number> {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const levels = new Map<string, number>();

  const levelOf = (key: string): number => {
    const cached = levels.get(key);
    if (cached !== undefined) return cached;
    const task = byKey.get(key);
    if (!task) throw new Error(`Unknown task key "${key}"`);
    const level = task.dependsOn.length === 0 ? 1 : 1 + Math.max(...task.dependsOn.map(levelOf));
    levels.set(key, level);
    return level;
  };

  for (const task of tasks) levelOf(task.key);
  return levels;
}

export interface LeveledTask extends TaskBreakdownItem {
  level: number;
}

/**
 * Tasks sorted by level, keeping the agent's order within a level. Every
 * dependency has a strictly lower level, so this is a topological order.
 */
export function topologicalOrder(tasks: TaskBreakdownItem[]): LeveledTask[] {
  const levels = computeLevels(tasks);
  return tasks
    .map((task, index) => ({ task: { ...task, level: levels.get(task.key)! }, index }))
    .sort((a, b) => a.task.level - b.task.level || a.index - b.index)
    .map(({ task }) => task);
}

export function formatLeveledTitle(level: number, title: string): string {
  return `${level}. ${title}`;
}

export interface DependencyRef {
  id: number;
  title: string;
}

/** Task doc = the agent's spec plus a `## Depends on` section with task ids. */
export function buildTaskDoc(spec: string, dependencies: DependencyRef[]): string {
  const lines =
    dependencies.length === 0
      ? ['- None']
      : dependencies.map((dep) => `- ${dep.title} (task #${dep.id})`);
  return `${spec.trim()}\n\n## Depends on\n\n${lines.join('\n')}\n`;
}

// ---- Creation ---------------------------------------------------------------

export interface SessionTaskInfo {
  id: number;
  project_id: number;
  user_id: number | null;
  title: string | null;
  status: string;
  repo_folder_path: string;
  subproject_path?: string | null;
}

export interface CreateTasksDeps {
  getSessionTask: (taskId: number) => SessionTaskInfo | undefined;
  isGitRepository: (repoPath: string) => Promise<boolean>;
  createTask: (projectId: number, title: string, userId: number | null) => { id: number };
  deleteTask: (taskId: number) => void;
  markTaskCompleted: (taskId: number) => void;
  createWorktree: (
    repoPath: string,
    taskId: number,
    title: string,
    subprojectPath: string | null,
  ) => Promise<{ success: boolean; error?: string }>;
  removeWorktree: (repoPath: string, taskId: number) => Promise<unknown>;
  writeTaskDoc: (projectId: number, taskId: number, content: string) => void;
  deleteTaskArchive: (projectId: number, taskId: number) => void;
}

export interface CreatedBreakdownTask {
  key: string;
  id: number;
  level: number;
  title: string;
  dependsOn: DependencyRef[];
}

export type CreateTasksResult =
  | { ok: true; created: CreatedBreakdownTask[] }
  | { ok: false; errors: string[] };

/**
 * Create the tasks of a validated breakdown in topological order, in the
 * session task's project and owned by the session task's owner. All-or-nothing:
 * on any failure, tasks (and worktrees, docs) created so far are removed.
 * On success the session task is marked completed.
 */
export async function createTasksFromBreakdown(
  sessionTaskId: number,
  input: unknown,
  deps: CreateTasksDeps,
): Promise<CreateTasksResult> {
  const session = deps.getSessionTask(sessionTaskId);
  if (!session) {
    return { ok: false, errors: [`Session task ${sessionTaskId} not found`] };
  }
  if (session.title !== CREATE_INITIAL_TASKS_TITLE) {
    return {
      ok: false,
      errors: [`Task ${sessionTaskId} is not a "${CREATE_INITIAL_TASKS_TITLE}" session task`],
    };
  }
  if (session.status === 'completed') {
    return {
      ok: false,
      errors: [`Session task ${sessionTaskId} is already completed — its tasks were already created`],
    };
  }

  const validation = validateTaskList(input);
  if (!validation.ok) return validation;

  const ordered = topologicalOrder(validation.tasks);
  const isGit = await deps.isGitRepository(session.repo_folder_path);
  const created: Array<CreatedBreakdownTask & { hasWorktree: boolean }> = [];
  const idsByKey = new Map<string, DependencyRef>();

  try {
    for (const task of ordered) {
      const title = formatLeveledTitle(task.level, task.title);
      const row = deps.createTask(session.project_id, title, session.user_id);
      const entry = { key: task.key, id: row.id, level: task.level, title, dependsOn: [] as DependencyRef[], hasWorktree: false };
      created.push(entry);

      if (isGit) {
        const result = await deps.createWorktree(
          session.repo_folder_path,
          row.id,
          title,
          session.subproject_path ?? null,
        );
        if (!result.success) {
          throw new Error(`Failed to create worktree for "${title}": ${result.error ?? 'unknown error'}`);
        }
        entry.hasWorktree = true;
      }

      entry.dependsOn = task.dependsOn.map((key) => idsByKey.get(key)!);
      deps.writeTaskDoc(session.project_id, row.id, buildTaskDoc(task.spec, entry.dependsOn));
      idsByKey.set(task.key, { id: row.id, title });
    }

    deps.markTaskCompleted(session.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rollbackErrors = await rollback(session, created, deps);
    return { ok: false, errors: [message, ...rollbackErrors] };
  }

  return { ok: true, created: created.map(({ hasWorktree: _hasWorktree, ...task }) => task) };
}

async function rollback(
  session: SessionTaskInfo,
  created: Array<{ id: number; hasWorktree: boolean }>,
  deps: CreateTasksDeps,
): Promise<string[]> {
  const errors: string[] = [];
  for (const task of [...created].reverse()) {
    try {
      if (task.hasWorktree) await deps.removeWorktree(session.repo_folder_path, task.id);
      deps.deleteTaskArchive(session.project_id, task.id);
      deps.deleteTask(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Rollback of task ${task.id} failed: ${message}`);
    }
  }
  return errors;
}

// ---- CLI --------------------------------------------------------------------

export type CreateTasksArgs =
  | { ok: true; sessionTaskId: number; jsonPath: string }
  | { ok: false; error: string };

export function parseCreateTasksArgs(argv: string[]): CreateTasksArgs {
  const [taskIdArg, jsonPath] = argv;
  if (!taskIdArg || !jsonPath) {
    return { ok: false, error: 'Session task ID and JSON path are required' };
  }
  if (!/^\d+$/.test(taskIdArg)) {
    return { ok: false, error: 'Session task ID must be a positive integer' };
  }
  return { ok: true, sessionTaskId: parseInt(taskIdArg, 10), jsonPath };
}
