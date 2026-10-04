import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../database/db.js', () => ({
  agentRunsDb: { getByConversationId: vi.fn() },
  conversationsDb: { getById: vi.fn() },
  tasksDb: { getById: vi.fn() },
}));
vi.mock('../autopilotFlag.js', () => ({ isAutopilotProject: vi.fn() }));
vi.mock('../conversationContentStore.js', () => ({ resolveProjectKey: vi.fn() }));
vi.mock('../sqliteSessionStore.js', () => ({ sqliteSessionStore: {} }));
vi.mock('./startConversation.js', () => ({ sendMessage: vi.fn() }));

import { agentRunsDb, conversationsDb, tasksDb } from '../../database/db.js';
import { isAutopilotProject } from '../autopilotFlag.js';
import { AUTOPILOT_DENY_MESSAGE, buildCanUseTool, rejectPendingAskUserQuestion } from './askUserQuestion.js';

const input = { questions: [{ question: 'JWT or sessions?', header: 'Auth' }] };

describe('buildCanUseTool under autopilot (extra/autopilot.md)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(conversationsDb.getById).mockReturnValue({ id: 50, task_id: 7 } as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, project_id: 3 } as never);
    vi.mocked(isAutopilotProject).mockReturnValue(true);
  });

  it('denies AskUserQuestion for an agent run of an autopilot project', async () => {
    vi.mocked(agentRunsDb.getByConversationId).mockReturnValue({ id: 1 } as never);
    const canUseTool = buildCanUseTool({ conversationId: 50, broadcastFn: vi.fn() });

    const result = await canUseTool('AskUserQuestion', input, {});

    expect(result).toEqual({ behavior: 'deny', message: AUTOPILOT_DENY_MESSAGE });
    expect(isAutopilotProject).toHaveBeenCalledWith(3);
  });

  it('still asks in a manual chat (no agent run), e.g. the PRD interview', async () => {
    vi.mocked(agentRunsDb.getByConversationId).mockReturnValue(undefined);
    const broadcastFn = vi.fn();
    const canUseTool = buildCanUseTool({ conversationId: 50, broadcastFn });

    const pending = canUseTool('AskUserQuestion', input, {});
    // Parked waiting for the user, and the question was broadcast.
    expect(broadcastFn).toHaveBeenCalledWith(50, expect.objectContaining({ type: 'awaiting-user-answer' }));
    rejectPendingAskUserQuestion(50, 'test over');
    await expect(pending).rejects.toThrow(/test over/);
  });
});
