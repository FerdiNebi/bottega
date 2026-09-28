import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db-helper.js';
import {
  CREATE_INITIAL_TASKS_TITLE,
  buildTaskDoc,
  computeLevels,
  createTasksFromBreakdown,
  parseCreateTasksArgs,
  topologicalOrder,
  validateTaskList,
  type CreateTasksDeps,
  type CreatedBreakdownTask,
  type TaskBreakdownItem,
} from './taskBreakdown.js';

function task(key: string, dependsOn: string[] = [], title = key): TaskBreakdownItem {
  return { key, title, dependsOn, spec: `## Goal\n${title}` };
}

function valid(input: unknown): TaskBreakdownItem[] {
  const result = validateTaskList(input);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.tasks;
}

function errorsOf(input: unknown): string[] {
  const result = validateTaskList(input);
  if (result.ok) throw new Error('expected validation to fail');
  return result.errors;
}

describe('computeLevels', () => {
  it('assigns increasing levels along a chain', () => {
    const levels = computeLevels(valid([task('a'), task('b', ['a']), task('c', ['b'])]));
    expect(Object.fromEntries(levels)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('gives a diamond join 1 + max of its dependencies', () => {
    const levels = computeLevels(
      valid([task('root'), task('left', ['root']), task('right', ['root']), task('join', ['left', 'right'])]),
    );
    expect(Object.fromEntries(levels)).toEqual({ root: 1, left: 2, right: 2, join: 3 });
  });

  it('puts every root at level 1', () => {
    const levels = computeLevels(valid([task('a'), task('b'), task('c', ['a'])]));
    expect(levels.get('a')).toBe(1);
    expect(levels.get('b')).toBe(1);
    expect(levels.get('c')).toBe(2);
  });

  it('uses the deepest dependency when deps sit at different levels', () => {
    const levels = computeLevels(
      valid([task('scaffold'), task('auth', ['scaffold']), task('orders', ['scaffold', 'auth'])]),
    );
    expect(levels.get('orders')).toBe(3);
  });

  it('does not depend on input order', () => {
    const levels = computeLevels(valid([task('c', ['b']), task('b', ['a']), task('a')]));
    expect(Object.fromEntries(levels)).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe('topologicalOrder', () => {
  it('sorts by level and keeps input order within a level', () => {
    const ordered = topologicalOrder(
      valid([task('join', ['x', 'y']), task('y'), task('x'), task('mid', ['y'])]),
    );
    expect(ordered.map((t) => `${t.level}:${t.key}`)).toEqual(['1:y', '1:x', '2:join', '2:mid']);
  });
});

describe('validateTaskList', () => {
  it('accepts a valid list and defaults dependsOn', () => {
    const tasks = valid([{ key: 'a', title: 'A', spec: 'spec' }]);
    expect(tasks[0]!.dependsOn).toEqual([]);
  });

  it('strips a level prefix the model put on a title', () => {
    expect(valid([task('a', [], '2. Authentication')])[0]!.title).toBe('Authentication');
  });

  it('rejects a non-array and an empty list', () => {
    expect(errorsOf({})[0]).toMatch(/input/);
    expect(errorsOf([])[0]).toMatch(/at least one task/);
  });

  it('reports a cycle', () => {
    const errors = errorsOf([task('a', ['c']), task('b', ['a']), task('c', ['b'])]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/dependency cycle: a -> c -> b -> a/);
  });

  it('reports a self-dependency', () => {
    expect(errorsOf([task('a', ['a'])])).toEqual(['task[0] "a": depends on itself']);
  });

  it('reports an unknown dependency key', () => {
    expect(errorsOf([task('a', ['missing'])])).toEqual(['task[0] "a": unknown dependency "missing"']);
  });

  it('reports duplicate keys', () => {
    expect(errorsOf([task('a'), task('a')])).toEqual(['task[1] "a": duplicate key "a"']);
  });

  it('reports empty titles and specs', () => {
    const errors = errorsOf([{ key: 'a', title: '  ', dependsOn: [], spec: '' }]);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/task\[0\]\[title\]: title must not be empty/),
        expect.stringMatching(/task\[0\]\[spec\]: spec must not be empty/),
      ]),
    );
  });

  it('reports every structural problem at once', () => {
    const errors = errorsOf([task('a', ['a']), task('b', ['nope']), task('b')]);
    expect(errors).toHaveLength(3);
  });
});

describe('buildTaskDoc', () => {
  it('appends a Depends on section with titles and task ids', () => {
    expect(buildTaskDoc('## Goal\nX\n', [{ id: 7, title: '1. Scaffold' }])).toBe(
      '## Goal\nX\n\n## Depends on\n\n- 1. Scaffold (task #7)\n',
    );
  });

  it('says None when there are no dependencies', () => {
    expect(buildTaskDoc('spec', [])).toContain('## Depends on\n\n- None');
  });
});

describe('parseCreateTasksArgs', () => {
  it('parses a task id and a path', () => {
    expect(parseCreateTasksArgs(['12', '/tmp/tasks.json'])).toEqual({
      ok: true,
      sessionTaskId: 12,
      jsonPath: '/tmp/tasks.json',
    });
  });

  it('rejects missing or non-numeric arguments', () => {
    expect(parseCreateTasksArgs([]).ok).toBe(false);
    expect(parseCreateTasksArgs(['12']).ok).toBe(false);
    expect(parseCreateTasksArgs(['abc', 'x.json']).ok).toBe(false);
  });
});

describe('createTasksFromBreakdown', () => {
  let testDb: TestDatabase;
  let userId: number;
  let projectId: number;
  let sessionTaskId: number;
  let docs: Map<number, string>;
  let deps: CreateTasksDeps & {
    createWorktree: ReturnType<typeof vi.fn>;
    removeWorktree: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    testDb = createTestDatabase();
    userId = testDb.userDb.createUser('owner', 'hash').id;
    projectId = testDb.projectsDb.create(userId, 'Proj', '/repo').id;
    sessionTaskId = testDb.tasksDb.create(projectId, CREATE_INITIAL_TASKS_TITLE, false, userId).id;
    docs = new Map();

    deps = {
      getSessionTask: (id) => testDb.tasksDb.getWithProject(id),
      isGitRepository: () => Promise.resolve(true),
      createTask: (pid, title, uid) => testDb.tasksDb.create(pid, title, false, uid),
      deleteTask: (id) => {
        testDb.tasksDb.delete(id);
      },
      markTaskCompleted: (id) => {
        testDb.tasksDb.update(id, { status: 'completed' });
      },
      createWorktree: vi.fn(() => Promise.resolve({ success: true })),
      removeWorktree: vi.fn(() => Promise.resolve({ success: true })),
      writeTaskDoc: (_pid, id, content) => {
        docs.set(id, content);
      },
      deleteTaskArchive: (_pid, id) => {
        docs.delete(id);
      },
    };
  });

  afterEach(() => {
    testDb.close();
  });

  const breakdown = [
    task('orders', ['auth', 'menu'], 'Guest ordering'),
    task('scaffold', [], 'Project scaffold'),
    task('auth', ['scaffold'], 'Authentication'),
    task('menu', ['scaffold'], 'Menu management'),
  ];

  function createdTasks() {
    return testDb.tasksDb.getByProject(projectId).filter((t) => t.id !== sessionTaskId);
  }

  it('creates level-prefixed tasks in topological order with Depends on docs', async () => {
    const result = await createTasksFromBreakdown(sessionTaskId, breakdown, deps);
    if (!result.ok) throw new Error(result.errors.join('\n'));

    expect(result.created.map((t) => t.title)).toEqual([
      '1. Project scaffold',
      '2. Authentication',
      '2. Menu management',
      '3. Guest ordering',
    ]);

    const rows = createdTasks();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.project_id).toBe(projectId);
      expect(row.user_id).toBe(userId);
      expect(row.status).toBe('pending');
    }

    const [scaffold, auth, menu, orders] = result.created as [CreatedBreakdownTask, CreatedBreakdownTask, CreatedBreakdownTask, CreatedBreakdownTask];
    expect(scaffold.id).toBeLessThan(auth.id);
    expect(docs.get(scaffold.id)).toContain('## Depends on\n\n- None');
    expect(docs.get(auth.id)).toContain(`- 1. Project scaffold (task #${scaffold.id})`);
    expect(docs.get(orders.id)).toContain('## Goal\nGuest ordering');
    expect(docs.get(orders.id)).toContain(
      `- 2. Authentication (task #${auth.id})\n- 2. Menu management (task #${menu.id})`,
    );

    expect(deps.createWorktree).toHaveBeenCalledTimes(4);
    expect(deps.createWorktree).toHaveBeenCalledWith('/repo', scaffold.id, '1. Project scaffold', null);
    expect(testDb.tasksDb.getById(sessionTaskId)!.status).toBe('completed');
  });

  it('skips worktrees for a non-git project', async () => {
    deps.isGitRepository = () => Promise.resolve(false);
    const result = await createTasksFromBreakdown(sessionTaskId, breakdown, deps);
    expect(result.ok).toBe(true);
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it('rolls back created tasks when a later creation fails', async () => {
    deps.createWorktree.mockImplementation((_repo: string, _id: number, title: string) =>
      Promise.resolve(title.startsWith('3.') ? { success: false, error: 'boom' } : { success: true }),
    );

    const result = await createTasksFromBreakdown(sessionTaskId, breakdown, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/Failed to create worktree for "3. Guest ordering": boom/);
    expect(createdTasks()).toHaveLength(0);
    expect(docs.size).toBe(0);
    // Worktrees were created for the three tasks before the failing one.
    expect(deps.removeWorktree).toHaveBeenCalledTimes(3);
    expect(testDb.tasksDb.getById(sessionTaskId)!.status).toBe('pending');
  });

  it('creates nothing when the list is invalid', async () => {
    const result = await createTasksFromBreakdown(sessionTaskId, [task('a', ['b']), task('b', ['a'])], deps);
    expect(result.ok).toBe(false);
    expect(createdTasks()).toHaveLength(0);
  });

  it('refuses a session task that does not exist, is not a breakdown session, or is completed', async () => {
    expect((await createTasksFromBreakdown(9999, breakdown, deps)).ok).toBe(false);

    const other = testDb.tasksDb.create(projectId, 'Some feature', false, userId);
    expect((await createTasksFromBreakdown(other.id, breakdown, deps)).ok).toBe(false);

    testDb.tasksDb.update(sessionTaskId, { status: 'completed' });
    expect((await createTasksFromBreakdown(sessionTaskId, breakdown, deps)).ok).toBe(false);
    expect(createdTasks()).toHaveLength(1); // only "Some feature"
  });
});
