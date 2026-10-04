import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentRunRow, ProjectRow, TaskRow } from '../../shared/types/db.js';

// In-memory stand-ins for the three tables autopilot reads.
const state = vi.hoisted(() => ({
  project: null as unknown as ProjectRow,
  tasks: [] as TaskRow[],
  runs: [] as AgentRunRow[],
  docs: {} as Record<number, string>,
}));

vi.mock('../database/db.js', () => ({
  projectsDb: {
    getByIdAdmin: vi.fn((id: number) => (state.project.id === id ? state.project : undefined)),
    setAutopilotMessage: vi.fn((_id: number, message: string | null) => {
      state.project.autopilot_message = message;
    }),
  },
  tasksDb: {
    getByProject: vi.fn(() => state.tasks),
    getById: vi.fn((id: number) => state.tasks.find((t) => t.id === id)),
    getWithProject: vi.fn((id: number) => {
      const task = state.tasks.find((t) => t.id === id);
      return task ? { ...task, repo_folder_path: state.project.repo_folder_path, subproject_path: null } : undefined;
    }),
    update: vi.fn((id: number, updates: Partial<TaskRow>) => {
      const task = state.tasks.find((t) => t.id === id);
      if (task) Object.assign(task, updates);
      return task;
    }),
  },
  agentRunsDb: {
    getByTask: vi.fn((taskId: number) => state.runs.filter((r) => r.task_id === taskId)),
  },
}));

vi.mock('./agentRunner.js', () => ({ startAgentRun: vi.fn() }));
vi.mock('./documentation.js', () => ({
  readTaskDoc: vi.fn((_projectId: number, taskId: number) => state.docs[taskId] ?? ''),
}));
vi.mock('./webServerManager.js', () => ({ switchWorktree: vi.fn() }));
vi.mock('./worktree.js', () => ({
  createWorktree: vi.fn(),
  getPullRequestStatus: vi.fn(),
  hasOriginRemote: vi.fn(),
  isGitRepository: vi.fn(),
  mergeAndCleanup: vi.fn(),
  mergeLocally: vi.fn(),
  removeWorktree: vi.fn(),
  resolveBootstrapBase: vi.fn(),
  updateWorktreeFromDefault: vi.fn(),
  worktreeExists: vi.fn(),
}));

import { startAgentRun } from './agentRunner.js';
import { switchWorktree } from './webServerManager.js';
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
import { ProviderCredentialsMissingError } from './credentials/types.js';
import {
  getAutopilotStatus,
  nextStepForTask,
  onAutopilotLoopStopped,
  onAutopilotRunCompleted,
  parseDependsOn,
  parseLevel,
  planAutopilot,
  shouldSkipPrAgent,
  startNextAutopilotTask,
  type AutopilotTaskInfo,
} from './autopilot.js';

function task(id: number, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    project_id: 1,
    user_id: 5,
    title: `Task ${id}`,
    status: 'pending',
    workflow_complete: 0,
    workflow_blocked: 0,
    workflow_run_count: 0,
    planification_complete: 0,
    pr_agent_complete: 0,
    refinement_complete: 0,
    yolo_mode: 0,
    completed_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function run(taskId: number, overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: taskId * 100,
    task_id: taskId,
    agent_type: 'implementation',
    status: 'completed',
    conversation_id: null,
    provider: 'anthropic',
    created_at: '',
    updated_at: '',
    ...overrides,
  } as AgentRunRow;
}

function info(t: TaskRow, overrides: Partial<AutopilotTaskInfo> = {}): AutopilotTaskInfo {
  return { task: t, hasAgentRuns: false, runningAgentType: null, dependsOn: [], ...overrides };
}

const ctx = { userId: 5 };

beforeEach(() => {
  vi.clearAllMocks();
  state.project = {
    id: 1,
    user_id: 5,
    name: 'P',
    repo_folder_path: '/repo',
    subproject_path: null,
    active_worktree_task_id: null,
    serve_symlink_path: null,
    systemd_service_name: null,
    app_url: null,
    autopilot_enabled: 1,
    autopilot_message: null,
    created_at: '',
    updated_at: '',
  };
  state.tasks = [];
  state.runs = [];
  state.docs = {};
  vi.mocked(hasOriginRemote).mockResolvedValue(true);
  vi.mocked(worktreeExists).mockResolvedValue(true);
  vi.mocked(isGitRepository).mockResolvedValue(true);
  vi.mocked(updateWorktreeFromDefault).mockResolvedValue({ success: true, baseRef: 'origin/main' });
  vi.mocked(startAgentRun).mockResolvedValue({} as never);
});

describe('parseDependsOn', () => {
  it('reads task ids from the Depends on section only', () => {
    const doc = [
      'Build the menu (see task #99 for context).',
      '',
      '## Depends on',
      '',
      '- 1. Project scaffold (task #3)',
      '- 2. Authentication (task #4)',
      '',
      '## Notes',
      '- unrelated task #42',
    ].join('\n');
    expect(parseDependsOn(doc)).toEqual([3, 4]);
  });

  it('treats a missing section or "- None" as no dependencies', () => {
    expect(parseDependsOn('Just a spec')).toEqual([]);
    expect(parseDependsOn('Spec\r\n\r\n## Depends on\r\n\r\n- None\r\n')).toEqual([]);
  });

  it('stops at the next heading and dedupes', () => {
    expect(parseDependsOn('## Depends on\n- a (task #2)\n- b (task #2)\n# Next\n- c (task #9)')).toEqual([2]);
  });
});

describe('parseLevel', () => {
  it('reads the "N. " title prefix', () => {
    expect(parseLevel('2. Authentication')).toBe(2);
    expect(parseLevel('Authentication')).toBeNull();
    expect(parseLevel('2.Authentication')).toBeNull();
    expect(parseLevel(null)).toBeNull();
  });
});

describe('planAutopilot', () => {
  it('orders ready tasks: started first, then by level (unprefixed last), then id', () => {
    const plan = planAutopilot([
      info(task(1, { title: 'Manual follow-up' })),
      info(task(2, { title: '2. Auth' })),
      info(task(3, { title: '1. Scaffold' })),
      info(task(4, { title: '1. Docs' })),
      info(task(5, { title: '3. Menu', status: 'in_progress' }), { hasAgentRuns: true }),
    ]);
    expect(plan.ready.map((t) => t.id)).toEqual([5, 3, 4, 2, 1]);
  });

  it('holds pending tasks until every dependency is completed', () => {
    const plan = planAutopilot([
      info(task(1, { status: 'completed' })),
      info(task(2)),
      info(task(3), { dependsOn: [1] }),
      info(task(4), { dependsOn: [1, 2] }),
      // A deleted dependency doesn't block.
      info(task(5), { dependsOn: [77] }),
    ]);
    expect(plan.ready.map((t) => t.id)).toEqual([2, 3, 5]);
    expect(plan.waiting.map((t) => t.id)).toEqual([4]);
  });

  it('skips bootstrap sessions, blocked and running tasks', () => {
    const plan = planAutopilot([
      // In progress with conversations but no agent runs: a PRD/ARD session.
      info(task(1, { status: 'in_progress', title: 'Refine PRD' })),
      info(task(2, { status: 'in_progress', workflow_blocked: 1 }), { hasAgentRuns: true }),
      info(task(3, { status: 'in_progress' }), { hasAgentRuns: true, runningAgentType: 'review' }),
      info(task(4, { status: 'completed' }), { hasAgentRuns: true }),
    ]);
    expect(plan.ready).toEqual([]);
    expect(plan.blocked.map((t) => t.id)).toEqual([2]);
    expect(plan.running).toEqual({ task: expect.objectContaining({ id: 3 }), agentType: 'review' });
  });
});

describe('nextStepForTask', () => {
  it('continues from the task flags', () => {
    expect(nextStepForTask(task(1), true)).toBe('planification');
    expect(nextStepForTask(task(1, { planification_complete: 1 }), true)).toBe('implementation');
    expect(nextStepForTask(task(1, { workflow_complete: 1 }), true)).toBe('refinement');
    expect(nextStepForTask(task(1, { workflow_complete: 1, refinement_complete: 1 }), true)).toBe('pr');
    expect(nextStepForTask(task(1, { workflow_complete: 1, refinement_complete: 1 }), false)).toBe('finish');
    expect(nextStepForTask(task(1, { yolo_mode: 1 }), true)).toBe('yolo');
    expect(nextStepForTask(task(1, { pr_agent_complete: 1 }), true)).toBe('finish');
  });
});

describe('startNextAutopilotTask', () => {
  it('refreshes a pending task worktree and starts planning', async () => {
    state.tasks = [task(1, { status: 'completed' }), task(2, { title: '2. Auth' })];
    state.docs[2] = '## Depends on\n- 1. Scaffold (task #1)';

    const result = await startNextAutopilotTask(1, ctx);

    expect(result).toEqual({ status: 'started', taskId: 2, step: 'planification' });
    expect(updateWorktreeFromDefault).toHaveBeenCalledWith('/repo', 2);
    expect(startAgentRun).toHaveBeenCalledWith(2, 'planification', ctx);
    expect(state.project.autopilot_message).toMatch(/Running task #2 "2\. Auth" \(planification\)/);
  });

  it('creates a missing worktree from the fetched base', async () => {
    state.tasks = [task(2)];
    vi.mocked(worktreeExists).mockResolvedValue(false);
    vi.mocked(resolveBootstrapBase).mockResolvedValue({ defaultBranch: 'main', baseRef: 'origin/main', stale: false });
    vi.mocked(createWorktree).mockResolvedValue({ success: true } as never);

    await startNextAutopilotTask(1, ctx);

    expect(createWorktree).toHaveBeenCalledWith('/repo', 2, 'Task 2', null, 'origin/main');
    expect(startAgentRun).toHaveBeenCalled();
  });

  it('stops without starting when the worktree update fails', async () => {
    state.tasks = [task(2)];
    vi.mocked(updateWorktreeFromDefault).mockResolvedValue({ success: false, error: 'CONFLICT in app.ts' });

    const result = await startNextAutopilotTask(1, ctx);

    expect(result.status).toBe('failed');
    expect(startAgentRun).not.toHaveBeenCalled();
    expect(state.project.autopilot_message).toBe('Stopped: task #2 "Task 2": CONFLICT in app.ts');
  });

  it('resumes an interrupted task without touching its worktree', async () => {
    state.tasks = [task(3, { status: 'in_progress', planification_complete: 1 })];
    state.runs = [run(3, { agent_type: 'planification', status: 'failed' })];

    const result = await startNextAutopilotTask(1, ctx);

    expect(result).toEqual({ status: 'started', taskId: 3, step: 'implementation' });
    expect(updateWorktreeFromDefault).not.toHaveBeenCalled();
  });

  it('refuses while another task is running, or when autopilot is off', async () => {
    state.tasks = [task(1, { status: 'in_progress' }), task(2)];
    state.runs = [run(1, { status: 'running', agent_type: 'review' })];
    expect((await startNextAutopilotTask(1, ctx)).status).toBe('running');

    state.runs = [];
    state.project.autopilot_enabled = 0;
    expect((await startNextAutopilotTask(1, ctx)).status).toBe('disabled');
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('reports done, or why the remaining tasks wait', async () => {
    state.tasks = [task(1, { status: 'completed' })];
    expect(await startNextAutopilotTask(1, ctx)).toEqual({ status: 'idle', message: 'Done: no tasks left to run.' });

    state.tasks = [task(1, { status: 'in_progress', workflow_blocked: 1 }), task(2)];
    state.runs = [run(1)];
    state.docs[2] = '## Depends on\n- (task #1)';
    const result = await startNextAutopilotTask(1, ctx);
    expect(result.status).toBe('idle');
    expect(state.project.autopilot_message).toMatch(/task #1 "Task 1" blocked; 1 task\(s\) waiting/);
  });

  it('records the failure and rethrows missing credentials for the route', async () => {
    state.tasks = [task(2)];
    vi.mocked(startAgentRun).mockRejectedValue(new ProviderCredentialsMissingError('anthropic', 'no token'));

    await expect(startNextAutopilotTask(1, ctx)).rejects.toBeInstanceOf(ProviderCredentialsMissingError);
    expect(state.project.autopilot_message).toMatch(/^Stopped: could not start task #2/);
  });
});

describe('finishing a task (onAutopilotRunCompleted after PR / yolo)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const openPr = (overrides: Record<string, unknown> = {}) =>
    vi.mocked(getPullRequestStatus).mockResolvedValue({
      success: true,
      exists: true,
      url: 'https://github.com/o/r/pull/9',
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      ciStatus: { status: 'passed', checks: [] },
      ...overrides,
    } as never);

  it('merges a green, mergeable PR, completes the task and starts the next', async () => {
    state.tasks = [task(1, { status: 'in_progress', pr_agent_complete: 1 }), task(2)];
    state.runs = [run(1, { agent_type: 'pr' })];
    openPr();
    vi.mocked(mergeAndCleanup).mockResolvedValue({ success: true });

    expect(await onAutopilotRunCompleted(1, 'pr', ctx)).toBe(true);

    expect(mergeAndCleanup).toHaveBeenCalledWith('/repo', 1);
    expect(state.tasks[0]!.status).toBe('completed');
    expect(state.project.autopilot_message).toMatch(/Merged task #1 "Task 1" \(merged https:.*pull\/9\)/);

    await vi.advanceTimersByTimeAsync(1000);
    expect(startAgentRun).toHaveBeenCalledWith(2, 'planification', ctx);
  });

  it.each([
    [{ ciStatus: { status: 'failed', checks: [] } }, /CI is failed/],
    [{ ciStatus: { status: 'pending', checks: [] } }, /CI is pending/],
    [{ mergeable: 'CONFLICTING' }, /not mergeable \(CONFLICTING\)/],
    [{ state: 'CLOSED' }, /the PR is closed/],
  ])('stops instead of merging when the PR is %o', async (pr, reason) => {
    state.tasks = [task(1, { status: 'in_progress', pr_agent_complete: 1 }), task(2)];
    openPr(pr);

    await onAutopilotRunCompleted(1, 'pr', ctx);

    expect(mergeAndCleanup).not.toHaveBeenCalled();
    expect(state.tasks[0]!.status).toBe('in_progress');
    expect(state.project.autopilot_message).toMatch(reason);
    await vi.advanceTimersByTimeAsync(1000);
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('merges a repository without CI ("none") when the PR is mergeable', async () => {
    state.tasks = [task(1, { status: 'in_progress', pr_agent_complete: 1 })];
    openPr({ ciStatus: { status: 'none', checks: [] } });
    vi.mocked(mergeAndCleanup).mockResolvedValue({ success: true });

    await onAutopilotRunCompleted(1, 'yolo', ctx);

    expect(mergeAndCleanup).toHaveBeenCalled();
  });

  it('merges locally when there is no PR, and notes a failed push', async () => {
    state.tasks = [task(1, { status: 'in_progress', pr_agent_complete: 1 })];
    vi.mocked(hasOriginRemote).mockResolvedValue(false);
    vi.mocked(mergeLocally).mockResolvedValue({ success: true, pushed: false, pushError: 'rejected' });

    await onAutopilotRunCompleted(1, 'pr', ctx);

    expect(getPullRequestStatus).not.toHaveBeenCalled();
    expect(mergeLocally).toHaveBeenCalledWith('/repo', 1, 'Task 1');
    expect(state.tasks[0]!.status).toBe('completed');
    expect(state.project.autopilot_message).toMatch(/merged locally, push failed: rejected/);
  });

  it('switches the web server back to main when this task was served', async () => {
    state.tasks = [task(1, { status: 'in_progress', pr_agent_complete: 1 })];
    state.project.active_worktree_task_id = 1;
    state.project.serve_symlink_path = '/srv/app';
    vi.mocked(hasOriginRemote).mockResolvedValue(false);
    vi.mocked(mergeLocally).mockResolvedValue({ success: true, pushed: false });

    await onAutopilotRunCompleted(1, 'pr', ctx);

    expect(switchWorktree).toHaveBeenCalledWith(1, null, 5);
  });

  it('stops when the PR agent ended without signalling completion', async () => {
    state.tasks = [task(1, { status: 'in_progress' })];

    expect(await onAutopilotRunCompleted(1, 'pr', ctx)).toBe(true);

    expect(mergeAndCleanup).not.toHaveBeenCalled();
    expect(mergeLocally).not.toHaveBeenCalled();
    expect(state.project.autopilot_message).toMatch(/pr agent ended without signalling/);
  });

  it('does nothing when autopilot is off', async () => {
    state.tasks = [task(1, { status: 'in_progress', pr_agent_complete: 1 })];
    state.project.autopilot_enabled = 0;

    expect(await onAutopilotRunCompleted(1, 'pr', ctx)).toBe(false);
    expect(mergeLocally).not.toHaveBeenCalled();
  });
});

describe('completion-handler hooks', () => {
  it('stops after planning without a completed plan, lets a completed plan chain', async () => {
    state.tasks = [task(1, { status: 'in_progress' })];
    expect(await onAutopilotRunCompleted(1, 'planification', ctx)).toBe(true);
    expect(state.project.autopilot_message).toMatch(/planning ended without a completed plan/);

    state.tasks = [task(1, { status: 'in_progress', planification_complete: 1 })];
    expect(await onAutopilotRunCompleted(1, 'planification', ctx)).toBe(false);
    expect(await onAutopilotRunCompleted(1, 'review', ctx)).toBe(false);
  });

  it('skips the PR agent only for autopilot projects without a remote', async () => {
    state.tasks = [task(1)];
    vi.mocked(hasOriginRemote).mockResolvedValue(false);
    expect(await shouldSkipPrAgent(1, '/repo')).toBe(true);

    vi.mocked(hasOriginRemote).mockResolvedValue(true);
    expect(await shouldSkipPrAgent(1, '/repo')).toBe(false);

    vi.mocked(hasOriginRemote).mockResolvedValue(false);
    state.project.autopilot_enabled = 0;
    expect(await shouldSkipPrAgent(1, '/repo')).toBe(false);
  });

  it('records a stop reason only when autopilot is on', () => {
    state.tasks = [task(1)];
    onAutopilotLoopStopped(1, 'blocked by the review agent.');
    expect(state.project.autopilot_message).toBe('Stopped: task #1 "Task 1": blocked by the review agent.');

    state.project.autopilot_enabled = 0;
    state.project.autopilot_message = null;
    onAutopilotLoopStopped(1, 'whatever');
    expect(state.project.autopilot_message).toBeNull();
  });
});

describe('getAutopilotStatus', () => {
  it('summarises the plan for the board', async () => {
    state.project.autopilot_message = 'Merged task #1';
    state.tasks = [
      task(1, { status: 'completed' }),
      task(2, { status: 'in_progress' }),
      task(3, { title: '2. Menu' }),
      task(4),
    ];
    state.runs = [run(2, { status: 'running', agent_type: 'review' })];
    state.docs[4] = '## Depends on\n- (task #2)';

    expect(await getAutopilotStatus(state.project)).toEqual({
      enabled: true,
      isGitRepository: true,
      running: { taskId: 2, title: 'Task 2', agentType: 'review' },
      next: { taskId: 3, title: '2. Menu' },
      readyCount: 1,
      waitingCount: 1,
      blockedCount: 0,
      message: 'Merged task #1',
    });
  });
});
