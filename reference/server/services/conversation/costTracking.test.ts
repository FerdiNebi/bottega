import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../database/db.js', () => ({
  conversationsDb: {
    recordCost: vi.fn(),
    getTaskCost: vi.fn(),
  },
}));

import { conversationsDb } from '../../database/db.js';
import { recordConversationCost } from './costTracking.js';
import type { StreamingContext } from './types.js';

function ctx(overrides: Partial<StreamingContext> = {}): StreamingContext {
  return {
    conversationId: 12,
    taskId: 7,
    claudeSessionId: 'sess',
    isNewSession: true,
    broadcastToTaskSubscribersFn: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordConversationCost', () => {
  it('stores the total and broadcasts the conversation and task totals', () => {
    vi.mocked(conversationsDb.recordCost).mockReturnValue(2.5);
    vi.mocked(conversationsDb.getTaskCost).mockReturnValue(6.75);
    const c = ctx();

    recordConversationCost(c, 2.5);

    expect(conversationsDb.recordCost).toHaveBeenCalledWith(12, 2.5);
    expect(conversationsDb.getTaskCost).toHaveBeenCalledWith(7);
    expect(c.broadcastToTaskSubscribersFn).toHaveBeenCalledWith(7, {
      type: 'task-cost-updated',
      conversationId: 12,
      conversationCostUsd: 2.5,
      taskCostUsd: 6.75,
    });
  });

  it('does not broadcast for a conversation without a task', () => {
    vi.mocked(conversationsDb.recordCost).mockReturnValue(1);
    const c = ctx({ taskId: null });

    recordConversationCost(c, 1);

    expect(conversationsDb.recordCost).toHaveBeenCalledWith(12, 1);
    expect(c.broadcastToTaskSubscribersFn).not.toHaveBeenCalled();
  });

  it('swallows database errors so the turn still completes', () => {
    vi.mocked(conversationsDb.recordCost).mockImplementation(() => {
      throw new Error('locked');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => recordConversationCost(ctx(), 1)).not.toThrow();
    errorSpy.mockRestore();
  });
});
