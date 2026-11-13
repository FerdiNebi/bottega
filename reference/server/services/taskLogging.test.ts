import { describe, it, expect, vi } from 'vitest';
import {
  buildLoggedTaskDoc,
  canLogTasksFrom,
  listLoggedTasks,
  logTasks,
  parseLogTasksArgs,
  validateLoggedTasks,
  type LogTasksDeps,
} from './taskLogging.js';
import type { SessionTaskInfo } from './taskBreakdown.js';

const spec = (goal: string) => `## Goal\n${goal}`;

function makeDeps(overrides: Partial<LogTasksDeps> = {}) {
  const tasks = new Map<number, SessionTaskInfo>([
    [10, { id: 10, project_id: 1, user_id: 5, title: 'How does checkout work?', status: 'in_progress', repo_folder_path: '/repo', subproject_path: null }],
    [412, { id: 412, project_id: 1, user_id: 5, title: '3. Payments', status: 'completed', repo_folder_path: '/repo' }],
    [413, { id: 413, project_id: 1, user_id: 5, title: 'Hand-made task', status: 'pending', repo_folder_path: '/repo' }],
    [900, { id: 900, project_id: 2, user_id: 5, title: '1. Other project', status: 'pending', repo_folder_path: '/other' }],
    [20, { id: 20, project_id: 1, user_id: 5, title: '4. Milestone: Checkout works', status: 'in_progress', repo_folder_path: '/repo' }],
    [21, { id: 21, project_id: 1, user_id: 5, title: 'Create initial tasks', status: 'in_progress', repo_folder_path: '/repo' }],
  ]);
  const docs = new Map<number, string>([[10, '## Notes\n\nSome notes']]);
  let nextId = 100;
  const created: Array<{ id: number; title: string; autopilot: unknown }> = [];
  const deps: LogTasksDeps = {
    getTask: (id) => tasks.get(id),
    isGitRepository: vi.fn(async () => true),
    resolveBaseRef: vi.fn(async () => 'origin/main'),
    createTask: vi.fn((projectId, title, userId, autopilot) => {
      const id = nextId++;
      tasks.set(id, { id, project_id: projectId, user_id: userId, title, status: 'pending', repo_folder_path: '/repo' });
      created.push({ id, title, autopilot });
      return { id };
    }),
    deleteTask: vi.fn((id) => {
      tasks.delete(id);
    }),
    createWorktree: vi.fn(async () => ({ success: true })),
    removeWorktree: vi.fn(async () => undefined),
    readTaskDoc: (_projectId, taskId) => docs.get(taskId) ?? '',
    writeTaskDoc: vi.fn((_projectId, taskId, content) => {
      docs.set(taskId, content);
    }),
    deleteTaskArchive: vi.fn((_projectId, taskId) => {
      docs.delete(taskId);
    }),
    ...overrides,
  };
  return { deps, tasks, docs, created };
}

describe('validateLoggedTasks', () => {
  const getTask = makeDeps().deps.getTask;

  it('levels the batch like the breakdown, counting existing dependencies by their prefix', () => {
    const result = validateLoggedTasks(
      [
        { key: 'persist', title: '7. Persist the cart', dependsOn: ['schema', 412], spec: spec('b') },
        { key: 'schema', title: 'Cart schema', spec: spec('a') },
        { key: 'manual', title: 'After a hand-made task', dependsOn: [413], spec: spec('c') },
      ],
      1,
      getTask,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks.map((t) => [t.key, t.level, t.title])).toEqual([
      ['schema', 1, 'Cart schema'],
      ['manual', 1, 'After a hand-made task'], // an unprefixed task counts as level 0
      ['persist', 4, 'Persist the cart'], // 1 + max(level 1, existing level 3); the model's prefix is dropped
    ]);
    expect(result.tasks[2]!.autopilotCanStart).toBe(true);
    expect(result.tasks[2]!.autopilotCanWork).toBe(true);
  });

  it('reports every problem at once', () => {
    const result = validateLoggedTasks(
      [
        { key: 'a', title: 'A', dependsOn: ['a', 'missing', 900, 777], spec: spec('a') },
        { key: 'a', title: 'A again', spec: spec('a') },
        { key: 'b', title: 'B', dependsOn: ['c', 'c'], spec: spec('b') },
        { key: 'c', title: 'C', dependsOn: ['b'], spec: spec('c') },
      ],
      1,
      getTask,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'task[1] "a": duplicate key "a"',
        'task[0] "a": depends on itself',
        'task[0] "a": unknown dependency "missing"',
        'task[0] "a": task #900 does not exist in this project',
        'task[0] "a": task #777 does not exist in this project',
        'task[2] "b": dependency "c" listed more than once',
        'dependency cycle: b -> c -> b',
      ]),
    );
  });

  it('rejects malformed input', () => {
    const result = validateLoggedTasks([{ key: 'a', title: '', spec: '' }], 1, getTask);
    expect(result.ok).toBe(false);
    expect(validateLoggedTasks([], 1, getTask).ok).toBe(false);
  });
});

describe('logTasks', () => {
  it('creates numbered tasks in order with links both ways and the autopilot switches', async () => {
    const { deps, docs, created } = makeDeps();
    const result = await logTasks(
      10,
      [
        { key: 'persist', title: 'Persist the cart', dependsOn: ['schema', 412], spec: spec('persist') },
        { key: 'schema', title: 'Cart schema', spec: spec('schema') },
        { key: 'copy', title: 'Copy fixes', spec: spec('copy'), autopilotCanStart: false },
        { key: 'check', kind: 'milestone', title: 'Checkout works', dependsOn: ['persist'], spec: spec('m') },
      ],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(created.map((t) => t.title)).toEqual([
      '1. Cart schema',
      '1. Copy fixes',
      '4. Persist the cart',
      '5. Milestone: Checkout works',
    ]);
    expect(created[1]!.autopilot).toEqual({ autopilotCanStart: false, autopilotCanWork: true });
    expect(deps.createWorktree).toHaveBeenCalledWith('/repo', 100, '1. Cart schema', null, 'origin/main');

    expect(docs.get(102)).toBe(
      buildLoggedTaskDoc(
        spec('persist'),
        [
          { id: 100, title: '1. Cart schema' },
          { id: 412, title: '3. Payments' },
        ],
        { id: 10, title: 'How does checkout work?' },
      ),
    );
    expect(docs.get(102)).toContain('## Depends on\n\n- 1. Cart schema (task #100)\n- 3. Payments (task #412)');
    expect(docs.get(102)).toContain('## Logged from\n\n- How does checkout work? (task #10)');
    expect(docs.get(10)).toBe(
      '## Notes\n\nSome notes\n\n## Logged tasks\n\n' +
        '- 1. Cart schema (task #100)\n- 1. Copy fixes (task #101)\n' +
        '- 4. Persist the cart (task #102)\n- 5. Milestone: Checkout works (task #103)\n',
    );
    expect(result.baseRef).toBe('origin/main');
  });

  it('skips worktrees outside git', async () => {
    const { deps } = makeDeps({ isGitRepository: vi.fn(async () => false) });
    const result = await logTasks(10, [{ key: 'a', title: 'A', spec: spec('a') }], deps);
    expect(result).toEqual(expect.objectContaining({ ok: true, baseRef: null }));
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it('is all-or-nothing', async () => {
    const createWorktree = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'disk full' });
    const { deps, tasks, docs } = makeDeps({ createWorktree });
    const result = await logTasks(
      10,
      [
        { key: 'a', title: 'A', spec: spec('a') },
        { key: 'b', title: 'B', dependsOn: ['a'], spec: spec('b') },
      ],
      deps,
    );
    expect(result).toEqual({ ok: false, errors: ['Failed to create worktree for "2. B": disk full'] });
    expect(tasks.has(100)).toBe(false);
    expect(tasks.has(101)).toBe(false);
    expect(deps.removeWorktree).toHaveBeenCalledWith('/repo', 100);
    expect(docs.get(10)).toBe('## Notes\n\nSome notes');
  });

  it('refuses milestone tasks, breakdown sessions and unknown tasks', async () => {
    const { deps } = makeDeps();
    const input = [{ key: 'a', title: 'A', spec: spec('a') }];
    expect(await logTasks(20, input, deps)).toEqual({
      ok: false,
      errors: ['Task 20 is a milestone task: log its follow-up tasks with milestone-task.ts'],
    });
    expect((await logTasks(21, input, deps)).ok).toBe(false);
    expect(await logTasks(999, input, deps)).toEqual({ ok: false, errors: ['Task 999 not found'] });
    expect(deps.createTask).not.toHaveBeenCalled();
  });
});

describe('listLoggedTasks', () => {
  it('lists the logged tasks with status, counting the open ones', async () => {
    const { deps } = makeDeps();
    await logTasks(
      10,
      [
        { key: 'a', title: 'A', spec: spec('a') },
        { key: 'b', title: 'B', spec: spec('b') },
      ],
      deps,
    );
    deps.deleteTask(101);
    const result = listLoggedTasks(10, deps);
    expect(result).toEqual({
      ok: true,
      tasks: [
        { id: 100, title: '1. A', status: 'pending' },
        { id: 101, title: null, status: 'deleted' },
      ],
      open: 1,
    });
  });
});

describe('canLogTasksFrom', () => {
  it('leaves out milestone tasks and breakdown sessions', () => {
    expect(canLogTasksFrom('Ask about checkout')).toBe(true);
    expect(canLogTasksFrom(null)).toBe(true);
    expect(canLogTasksFrom('3. Milestone: Sign in')).toBe(false);
    expect(canLogTasksFrom('Create initial tasks')).toBe(false);
  });
});

describe('parseLogTasksArgs', () => {
  it('parses create and list', () => {
    expect(parseLogTasksArgs(['create', '10', '/tmp/t.json'])).toEqual({
      ok: true,
      command: 'create',
      sourceTaskId: 10,
      jsonPath: '/tmp/t.json',
    });
    expect(parseLogTasksArgs(['list', '10'])).toEqual({ ok: true, command: 'list', sourceTaskId: 10 });
    expect(parseLogTasksArgs(['create', '10']).ok).toBe(false);
    expect(parseLogTasksArgs(['sync', '10']).ok).toBe(false);
    expect(parseLogTasksArgs(['list', 'x']).ok).toBe(false);
  });
});
