import { describe, it, expect, vi } from 'vitest';
import {
  appendFollowUp,
  buildFollowUpDoc,
  createFollowUpTask,
  listFollowUpTasks,
  parseFollowUps,
  parseMilestoneTaskArgs,
  syncMilestoneWorktree,
  type CreateFollowUpDeps,
} from './milestoneFollowUps.js';
import { parseDependsOn } from './autopilot.js';
import type { SessionTaskInfo } from './taskBreakdown.js';

const MILESTONE: SessionTaskInfo = {
  id: 10,
  project_id: 3,
  user_id: 7,
  title: '4. Milestone: Sign in and view settings',
  status: 'in_progress',
  repo_folder_path: '/repo',
  subproject_path: null,
};

function fakeDeps(overrides: Partial<CreateFollowUpDeps> = {}) {
  const tasks = new Map<number, SessionTaskInfo>([[MILESTONE.id, { ...MILESTONE }]]);
  const docs = new Map<number, string>([[MILESTONE.id, '## Goal\nVerify sign-in.\n']]);
  let nextId = 50;
  const deps: CreateFollowUpDeps = {
    getTask: (id) => tasks.get(id),
    isGitRepository: vi.fn(async () => true),
    getTaskBranch: vi.fn(async () => 'task/10-milestone-sign-in'),
    resolveBaseRef: vi.fn(async () => 'origin/main'),
    createTask: vi.fn((projectId: number, title: string, userId: number | null) => {
      const id = nextId++;
      tasks.set(id, { ...MILESTONE, id, project_id: projectId, user_id: userId, title, status: 'pending' });
      return { id };
    }),
    deleteTask: vi.fn((id: number) => void tasks.delete(id)),
    createWorktree: vi.fn(async () => ({ success: true })),
    removeWorktree: vi.fn(async () => undefined),
    readTaskDoc: (_projectId, id) => docs.get(id) ?? '',
    writeTaskDoc: vi.fn((_projectId: number, id: number, content: string) => void docs.set(id, content)),
    deleteTaskArchive: vi.fn((_projectId: number, id: number) => void docs.delete(id)),
    ...overrides,
  };
  return { deps, tasks, docs };
}

const INPUT = { title: 'Fix settings page crash', spec: '## Goal\nThe settings page loads.' };

describe('appendFollowUp', () => {
  const ref = { id: 51, title: 'Fix crash' };

  it('adds the section at the end when missing', () => {
    expect(appendFollowUp('## Goal\nX\n', ref)).toBe('## Goal\nX\n\n## Follow-up tasks\n\n- Fix crash (task #51)\n');
  });

  it('starts the doc with the section when it is empty', () => {
    expect(appendFollowUp('', ref)).toBe('## Follow-up tasks\n\n- Fix crash (task #51)\n');
  });

  it('appends to an existing section in the middle of the doc', () => {
    const doc = '## Follow-up tasks\n\n- First (task #50)\n\n## Verification guide\nSteps\n';
    expect(appendFollowUp(doc, ref)).toBe(
      '## Follow-up tasks\n\n- First (task #50)\n- Fix crash (task #51)\n\n## Verification guide\nSteps\n',
    );
  });

  it('keeps a blank line before the next heading of an empty section', () => {
    const doc = '## Follow-up tasks\n## Open issues\n- x\n';
    expect(appendFollowUp(doc, ref)).toBe('## Follow-up tasks\n\n- Fix crash (task #51)\n\n## Open issues\n- x\n');
  });

  it('round-trips through parseFollowUps', () => {
    const doc = appendFollowUp(appendFollowUp('## Goal\n', { id: 50, title: 'A' }), ref);
    expect(parseFollowUps(doc)).toEqual([50, 51]);
  });
});

describe('buildFollowUpDoc', () => {
  it('has no dependencies and names the milestone it was raised in', () => {
    const doc = buildFollowUpDoc('## Goal\nX', { id: 10, title: '4. Milestone: Sign in' });
    expect(parseDependsOn(doc)).toEqual([]);
    expect(doc).toContain('## Depends on\n\n- None\n');
    expect(doc).toContain('## Raised in\n\n- 4. Milestone: Sign in (task #10)\n');
  });
});

describe('createFollowUpTask', () => {
  it('creates the task in the milestone project, branched from the milestone branch, and links both docs', async () => {
    const { deps, docs } = fakeDeps();
    const result = await createFollowUpTask(MILESTONE.id, INPUT, deps);

    expect(result).toEqual({
      ok: true,
      task: { id: 50, title: 'Fix settings page crash' },
      baseRef: 'task/10-milestone-sign-in',
      milestone: { id: 10, title: MILESTONE.title },
    });
    expect(deps.createTask).toHaveBeenCalledWith(3, 'Fix settings page crash', 7);
    expect(deps.createWorktree).toHaveBeenCalledWith('/repo', 50, 'Fix settings page crash', null, 'task/10-milestone-sign-in');
    expect(docs.get(50)).toContain('The settings page loads.');
    expect(docs.get(50)).toContain(`(task #${MILESTONE.id})`);
    expect(parseFollowUps(docs.get(MILESTONE.id)!)).toEqual([50]);
    expect(docs.get(MILESTONE.id)).toContain('## Goal\nVerify sign-in.');
  });

  it('strips a level prefix and milestone marker from the title', async () => {
    const { deps } = fakeDeps();
    const result = await createFollowUpTask(MILESTONE.id, { ...INPUT, title: '5. Milestone: Polish' }, deps);
    expect(result.ok && result.task.title).toBe('Polish');
  });

  it('falls back to the default branch when the milestone has no branch', async () => {
    const { deps } = fakeDeps({ getTaskBranch: vi.fn(async () => null) });
    const result = await createFollowUpTask(MILESTONE.id, INPUT, deps);
    expect(result.ok && result.baseRef).toBe('origin/main');
  });

  it('creates no worktree outside a git repository', async () => {
    const { deps } = fakeDeps({ isGitRepository: vi.fn(async () => false) });
    const result = await createFollowUpTask(MILESTONE.id, INPUT, deps);
    expect(result.ok).toBe(true);
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing task', 99, 'Task 99 not found'],
    ['a task that is not a milestone', 50, 'is not a milestone task'],
  ])('rejects %s', async (_label, id, message) => {
    const { deps, tasks } = fakeDeps();
    tasks.set(50, { ...MILESTONE, id: 50, title: '2. Sign-in' });
    const result = await createFollowUpTask(id, INPUT, deps);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join()).toContain(message);
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('rejects a completed milestone', async () => {
    const { deps, tasks } = fakeDeps();
    tasks.set(MILESTONE.id, { ...MILESTONE, status: 'completed' });
    const result = await createFollowUpTask(MILESTONE.id, INPUT, deps);
    expect(!result.ok && result.errors.join()).toContain('already completed');
  });

  it('reports every invalid field', async () => {
    const { deps } = fakeDeps();
    const result = await createFollowUpTask(MILESTONE.id, { title: ' ' }, deps);
    expect(!result.ok && result.errors).toHaveLength(2);
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('rolls back the task, worktree and doc and leaves the milestone doc alone on failure', async () => {
    const { deps, tasks, docs } = fakeDeps();
    const before = docs.get(MILESTONE.id);
    deps.writeTaskDoc = vi.fn((_projectId: number, id: number, content: string) => {
      if (id === MILESTONE.id) throw new Error('disk full');
      docs.set(id, content);
    });
    const result = await createFollowUpTask(MILESTONE.id, INPUT, deps);

    expect(result).toEqual({ ok: false, errors: ['disk full'] });
    expect(deps.removeWorktree).toHaveBeenCalledWith('/repo', 50);
    expect(tasks.has(50)).toBe(false);
    expect(docs.has(50)).toBe(false);
    expect(docs.get(MILESTONE.id)).toBe(before);
  });

  it('removes the task when its worktree cannot be created', async () => {
    const { deps, tasks } = fakeDeps({ createWorktree: vi.fn(async () => ({ success: false, error: 'exists' })) });
    const result = await createFollowUpTask(MILESTONE.id, INPUT, deps);
    expect(!result.ok && result.errors[0]).toContain('exists');
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(tasks.has(50)).toBe(false);
  });
});

describe('listFollowUpTasks', () => {
  it('lists follow-ups with their status and counts the open ones', async () => {
    const { deps, tasks } = fakeDeps();
    await createFollowUpTask(MILESTONE.id, INPUT, deps);
    await createFollowUpTask(MILESTONE.id, { ...INPUT, title: 'Second' }, deps);
    await createFollowUpTask(MILESTONE.id, { ...INPUT, title: 'Third' }, deps);
    tasks.set(50, { ...tasks.get(50)!, status: 'completed' });
    tasks.delete(52);

    const result = listFollowUpTasks(MILESTONE.id, deps);
    expect(result).toEqual({
      ok: true,
      open: 1,
      tasks: [
        { id: 50, title: 'Fix settings page crash', status: 'completed' },
        { id: 51, title: 'Second', status: 'pending' },
        { id: 52, title: null, status: 'deleted' },
      ],
    });
  });

  it('still lists a completed milestone', () => {
    const { deps, tasks } = fakeDeps();
    tasks.set(MILESTONE.id, { ...MILESTONE, status: 'completed' });
    expect(listFollowUpTasks(MILESTONE.id, deps)).toEqual({ ok: true, tasks: [], open: 0 });
  });
});

describe('syncMilestoneWorktree', () => {
  const getTask = (id: number) => (id === MILESTONE.id ? MILESTONE : undefined);

  it('merges the default branch into the milestone worktree', async () => {
    const updateWorktreeFromDefault = vi.fn(async () => ({ success: true, baseRef: 'origin/main' }));
    const result = await syncMilestoneWorktree(MILESTONE.id, {
      getTask,
      worktreeExists: async () => true,
      updateWorktreeFromDefault,
    });
    expect(result).toEqual({ ok: true, baseRef: 'origin/main' });
    expect(updateWorktreeFromDefault).toHaveBeenCalledWith('/repo', MILESTONE.id);
  });

  it('reports a failed merge', async () => {
    const result = await syncMilestoneWorktree(MILESTONE.id, {
      getTask,
      worktreeExists: async () => true,
      updateWorktreeFromDefault: async () => ({ success: false, error: 'conflict' }),
    });
    expect(result).toEqual({ ok: false, errors: ['conflict'] });
  });

  it('requires a worktree', async () => {
    const result = await syncMilestoneWorktree(MILESTONE.id, {
      getTask,
      worktreeExists: async () => false,
      updateWorktreeFromDefault: vi.fn(),
    });
    expect(!result.ok && result.errors[0]).toContain('has no worktree');
  });
});

describe('parseMilestoneTaskArgs', () => {
  it('parses each command', () => {
    expect(parseMilestoneTaskArgs(['create', '10', 'x.json'])).toEqual({
      ok: true,
      command: 'create',
      milestoneTaskId: 10,
      jsonPath: 'x.json',
    });
    expect(parseMilestoneTaskArgs(['list', '10'])).toEqual({ ok: true, command: 'list', milestoneTaskId: 10 });
    expect(parseMilestoneTaskArgs(['sync', '10'])).toEqual({ ok: true, command: 'sync', milestoneTaskId: 10 });
  });

  it.each([[[]], [['delete', '10']], [['list', 'x']], [['create', '10']]])('rejects %j', (argv) => {
    expect(parseMilestoneTaskArgs(argv).ok).toBe(false);
  });
});
