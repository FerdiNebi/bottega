import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  runs: [] as { id: number; task_id: number; agent_type: string; status: string; conversation_id: number }[],
}));

vi.mock('../../database/db.js', () => ({
  agentRunsDb: {
    getByTask: vi.fn(() => state.runs),
    updateStatus: vi.fn((id: number, status: string) => {
      const run = state.runs.find((r) => r.id === id);
      if (run) run.status = status;
    }),
  },
}));

import { agentRunsDb } from '../../database/db.js';
import { stopRunForTurnLimit } from './turnLimit.js';
import type { StreamingContext } from './types.js';

function ctx(overrides: Partial<StreamingContext> = {}): StreamingContext {
  return {
    conversationId: 886,
    taskId: 171,
    claudeSessionId: 'sess',
    isNewSession: true,
    broadcastToTaskSubscribersFn: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  state.runs = [{ id: 848, task_id: 171, agent_type: 'implementation', status: 'running', conversation_id: 886 }];
});

describe('stopRunForTurnLimit', () => {
  it('marks the running run failed, records the stop reason and broadcasts it', () => {
    const c = ctx();

    expect(stopRunForTurnLimit(c, 150)).toBe(true);

    expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(848, 'failed');
    expect(c.stopReason).toBe('the implementation run hit its 150-turn limit.');
    expect(c.broadcastToTaskSubscribersFn).toHaveBeenCalledWith(171, {
      type: 'agent-run-updated',
      agentRun: { id: 848, status: 'failed', agent_type: 'implementation', conversation_id: 886 },
    });
  });

  it('does nothing when the run is no longer running', () => {
    state.runs[0]!.status = 'failed';
    const c = ctx();

    expect(stopRunForTurnLimit(c, 150)).toBe(false);
    expect(agentRunsDb.updateStatus).not.toHaveBeenCalled();
    expect(c.stopReason).toBeUndefined();
  });

  it('does nothing for a conversation without a task', () => {
    expect(stopRunForTurnLimit(ctx({ taskId: null }), 150)).toBe(false);
    expect(agentRunsDb.updateStatus).not.toHaveBeenCalled();
  });
});
