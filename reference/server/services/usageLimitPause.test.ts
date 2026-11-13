import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
  runs: [] as { id: number; task_id: number; agent_type: string; status: string; conversation_id: number }[],
  task: null as Record<string, unknown> | null,
  autopilot: false,
}));

vi.mock('../database/db.js', () => ({
  agentRunsDb: {
    getByTask: vi.fn(() => state.runs),
    updateStatus: vi.fn((id: number, status: string) => {
      const run = state.runs.find((r) => r.id === id);
      if (run) run.status = status;
    }),
  },
  tasksDb: {
    getById: vi.fn(() => state.task),
    decrementRunCount: vi.fn(),
    setUsageLimitPause: vi.fn((_id: number, at: string, type: string) => {
      state.task = { ...state.task, usage_limit_resume_at: at, usage_limit_agent_type: type };
    }),
    clearUsageLimitPause: vi.fn(() => {
      state.task = { ...state.task, usage_limit_resume_at: null, usage_limit_agent_type: null };
    }),
    getUsageLimitPaused: vi.fn(() => (state.task?.usage_limit_resume_at ? [state.task] : [])),
  },
  projectsDb: { setAutopilotMessage: vi.fn() },
}));

vi.mock('./autopilotFlag.js', () => ({
  isAutopilotTask: vi.fn(() => state.autopilot),
}));

vi.mock('./agentRunner.js', () => ({
  startAgentRun: vi.fn().mockResolvedValue({}),
}));

import { agentRunsDb, projectsDb, tasksDb } from '../database/db.js';
import { startAgentRun } from './agentRunner.js';
import {
  cancelUsageLimitPause,
  computeResumeAt,
  pauseRunForUsageLimit,
  restoreUsageLimitPauses,
  resumeTask,
  RESET_GRACE_MS,
  UNKNOWN_RESET_DELAY_MS,
} from './usageLimitPause.js';

const NOW = Date.parse('2026-11-03T17:14:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  state.runs = [{ id: 848, task_id: 171, agent_type: 'implementation', status: 'running', conversation_id: 886 }];
  state.task = { id: 171, project_id: 2, status: 'in_progress', workflow_blocked: 0, usage_limit_resume_at: null };
  state.autopilot = false;
});

afterEach(() => {
  cancelUsageLimitPause(171);
  vi.useRealTimers();
});

describe('computeResumeAt', () => {
  it('resumes shortly after the reported reset', () => {
    const resetsAt = NOW + 4 * 60 * 60 * 1000;
    expect(computeResumeAt(resetsAt, NOW).getTime()).toBe(resetsAt + RESET_GRACE_MS);
  });

  it('never resumes in the past', () => {
    expect(computeResumeAt(NOW - 1000, NOW).getTime()).toBe(NOW + RESET_GRACE_MS);
  });

  it('retries after a fixed delay when the reset time is unknown', () => {
    expect(computeResumeAt(null, NOW).getTime()).toBe(NOW + UNKNOWN_RESET_DELAY_MS);
  });
});

describe('pauseRunForUsageLimit', () => {
  const broadcastToTaskSubscribersFn = vi.fn();
  const ctx = { conversationId: 886, taskId: 171, userId: 5, broadcastToTaskSubscribersFn };

  it('fails the run, refunds the iteration and records the pause', () => {
    const resetsAt = NOW + 60 * 60 * 1000;
    expect(pauseRunForUsageLimit(ctx, { resetsAt })).toBe(true);

    expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(848, 'failed');
    expect(tasksDb.decrementRunCount).toHaveBeenCalledWith(171);
    const resumeAt = new Date(resetsAt + RESET_GRACE_MS).toISOString();
    expect(tasksDb.setUsageLimitPause).toHaveBeenCalledWith(171, resumeAt, 'implementation');
    expect(broadcastToTaskSubscribersFn).toHaveBeenCalledWith(171, {
      type: 'task-usage-limit',
      resumeAt,
      agentType: 'implementation',
    });
    expect(broadcastToTaskSubscribersFn).toHaveBeenCalledWith(
      171,
      expect.objectContaining({ type: 'agent-run-updated', agentRun: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('does nothing when the linked run is no longer running', () => {
    state.runs[0]!.status = 'failed';
    expect(pauseRunForUsageLimit(ctx, { resetsAt: null })).toBe(false);
    expect(tasksDb.setUsageLimitPause).not.toHaveBeenCalled();
  });

  it('does nothing for a conversation without an agent run', () => {
    expect(pauseRunForUsageLimit({ ...ctx, conversationId: 1 }, { resetsAt: null })).toBe(false);
    expect(pauseRunForUsageLimit({ ...ctx, taskId: null }, { resetsAt: null })).toBe(false);
  });

  it('sets the autopilot message on autopilot projects', () => {
    state.autopilot = true;
    pauseRunForUsageLimit(ctx, { resetsAt: null });
    expect(projectsDb.setAutopilotMessage).toHaveBeenCalledWith(
      2,
      expect.stringMatching(/^Paused: task #171 hit the usage limit; resumes at /),
    );
  });

  it('starts the same agent type again once the resume time passes', async () => {
    pauseRunForUsageLimit(ctx, { resetsAt: NOW + 10 * 60 * 1000 });
    state.runs[0]!.status = 'failed';

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(startAgentRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RESET_GRACE_MS);
    expect(startAgentRun).toHaveBeenCalledWith(171, 'implementation', expect.objectContaining({ userId: 5 }));
    expect(tasksDb.clearUsageLimitPause).toHaveBeenCalledWith(171);
  });

  it('a manual run cancels the pending resume', async () => {
    pauseRunForUsageLimit(ctx, { resetsAt: null });
    cancelUsageLimitPause(171);
    expect(state.task?.usage_limit_resume_at).toBeNull();

    await vi.advanceTimersByTimeAsync(UNKNOWN_RESET_DELAY_MS + 1000);
    expect(startAgentRun).not.toHaveBeenCalled();
  });
});

describe('resumeTask', () => {
  beforeEach(() => {
    state.runs[0]!.status = 'failed';
    state.task = { ...state.task, usage_limit_resume_at: new Date(NOW).toISOString(), usage_limit_agent_type: 'review' };
  });

  it('skips a task that got blocked meanwhile, but clears the pause', async () => {
    state.task = { ...state.task, workflow_blocked: 1 };
    await resumeTask(171, undefined, {});
    expect(startAgentRun).not.toHaveBeenCalled();
    expect(tasksDb.clearUsageLimitPause).toHaveBeenCalledWith(171);
  });

  it('skips a task that already has a running agent', async () => {
    state.runs.push({ id: 900, task_id: 171, agent_type: 'review', status: 'running', conversation_id: 9 });
    await resumeTask(171, undefined, {});
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('reports a failed restart on the autopilot board', async () => {
    state.autopilot = true;
    vi.mocked(startAgentRun).mockRejectedValueOnce(new Error('no credentials'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await resumeTask(171, undefined, {});
    expect(projectsDb.setAutopilotMessage).toHaveBeenCalledWith(2, expect.stringContaining('no credentials'));
  });
});

describe('restoreUsageLimitPauses', () => {
  it('resumes an overdue pause shortly after startup', async () => {
    state.runs[0]!.status = 'failed';
    state.task = { ...state.task, usage_limit_resume_at: new Date(NOW - 1000).toISOString(), usage_limit_agent_type: 'review' };
    expect(restoreUsageLimitPauses()).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(startAgentRun).toHaveBeenCalledWith(171, 'review', expect.anything());
  });
});
