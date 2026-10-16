import { describe, it, expect, beforeEach, vi } from 'vitest';

const task = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));

vi.mock('../database/db.js', () => ({
  tasksDb: {
    getWithProject: vi.fn(() => task.current),
    updateStatus: vi.fn(),
  },
  conversationsDb: {
    create: vi.fn(() => ({ id: 42 })),
    delete: vi.fn(),
  },
}));
vi.mock('./worktree.js', () => ({
  createWorktree: vi.fn(),
  isGitRepository: vi.fn(),
  resolveBootstrapBase: vi.fn(),
  updateWorktreeFromDefault: vi.fn(),
  worktreeExists: vi.fn(),
}));
vi.mock('./documentation.js', () => ({
  buildContextPrompt: vi.fn(() => 'context'),
  getTaskDocPath: vi.fn(() => '/archive/task-7.md'),
}));
vi.mock('./promptRenderer.js', () => ({
  renderPrompt: vi.fn(() => 'rendered prompt'),
  toPromptPath: vi.fn((p: string) => p),
}));
vi.mock('./conversationAdapter.js', () => ({ startConversation: vi.fn() }));
vi.mock('./agentModelSettings.js', () => ({
  loadAgentModelSettings: vi.fn(() => ({
    review: { provider: 'anthropic', model: 'opus', effort: 'high' },
  })),
}));
vi.mock('./credentials/registry.js', () => ({
  getCredentialStore: vi.fn(() => ({ read: vi.fn() })),
}));

import { conversationsDb, tasksDb } from '../database/db.js';
import {
  createWorktree,
  isGitRepository,
  resolveBootstrapBase,
  updateWorktreeFromDefault,
  worktreeExists,
} from './worktree.js';
import { renderPrompt } from './promptRenderer.js';
import { startConversation } from './conversationAdapter.js';
import { getCredentialStore } from './credentials/registry.js';
import { ProviderCredentialsMissingError } from './credentials/types.js';
import { MilestoneSessionError, startMilestoneSession } from './milestoneVerification.js';

const params = { taskId: 7, userId: 5 };

beforeEach(() => {
  vi.clearAllMocks();
  task.current = {
    id: 7,
    project_id: 1,
    title: '4. Milestone: Sign in and view settings',
    status: 'pending',
    repo_folder_path: '/repo',
    subproject_path: null,
  };
  vi.mocked(isGitRepository).mockResolvedValue(true);
  vi.mocked(worktreeExists).mockResolvedValue(true);
  vi.mocked(updateWorktreeFromDefault).mockResolvedValue({ success: true, baseRef: 'origin/main' });
  vi.mocked(startConversation).mockResolvedValue(undefined as never);
  vi.mocked(getCredentialStore).mockReturnValue({ read: vi.fn() } as never);
});

describe('startMilestoneSession', () => {
  it('refreshes the worktree and starts the verification chat with the review agent model', async () => {
    const result = await startMilestoneSession(params);

    expect(result).toEqual({ taskId: 7, conversationId: 42, initialMessage: 'rendered prompt' });
    expect(updateWorktreeFromDefault).toHaveBeenCalledWith('/repo', 7);
    expect(renderPrompt).toHaveBeenCalledWith('milestone-verification', {
      taskId: 7,
      taskDocPath: '/archive/task-7.md',
    });
    expect(conversationsDb.create).toHaveBeenCalledWith(7, 'anthropic', 'opus', null);
    expect(startConversation).toHaveBeenCalledWith(
      7,
      'rendered prompt',
      expect.objectContaining({ conversationId: 42, provider: 'anthropic', model: 'opus', effort: 'high', userId: 5 }),
    );
    expect(tasksDb.updateStatus).toHaveBeenCalledWith(7, 'in_progress');
  });

  it('creates a missing worktree from the fetched default branch', async () => {
    vi.mocked(worktreeExists).mockResolvedValue(false);
    vi.mocked(resolveBootstrapBase).mockResolvedValue({ defaultBranch: 'main', baseRef: 'origin/main', stale: false });
    vi.mocked(createWorktree).mockResolvedValue({ success: true });

    await startMilestoneSession(params);

    expect(createWorktree).toHaveBeenCalledWith('/repo', 7, '4. Milestone: Sign in and view settings', null, 'origin/main');
    expect(updateWorktreeFromDefault).not.toHaveBeenCalled();
  });

  it('refuses tasks that are not milestones, completed milestones, and non-git projects', async () => {
    task.current = { ...task.current, title: '2. Sign-in' };
    await expect(startMilestoneSession(params)).rejects.toBeInstanceOf(MilestoneSessionError);

    task.current = { ...task.current, title: '4. Milestone: Sign in', status: 'completed' };
    await expect(startMilestoneSession(params)).rejects.toThrow(/already completed/);

    task.current = { ...task.current, status: 'pending' };
    vi.mocked(isGitRepository).mockResolvedValue(false);
    await expect(startMilestoneSession(params)).rejects.toThrow(/git repository/);

    expect(startConversation).not.toHaveBeenCalled();
  });

  it('reports missing provider credentials before touching the worktree', async () => {
    vi.mocked(getCredentialStore).mockReturnValue({
      read: vi.fn(() => {
        throw new Error('no token');
      }),
    } as never);

    await expect(startMilestoneSession(params)).rejects.toBeInstanceOf(ProviderCredentialsMissingError);
    expect(updateWorktreeFromDefault).not.toHaveBeenCalled();
  });

  it('fails without starting a chat when the worktree update fails', async () => {
    vi.mocked(updateWorktreeFromDefault).mockResolvedValue({ success: false, error: 'CONFLICT in app.ts' });

    await expect(startMilestoneSession(params)).rejects.toThrow(/CONFLICT in app.ts/);
    expect(conversationsDb.create).not.toHaveBeenCalled();
    expect(tasksDb.updateStatus).not.toHaveBeenCalled();
  });

  it('removes the conversation when the chat fails to start', async () => {
    vi.mocked(startConversation).mockRejectedValue(new Error('boom'));

    await expect(startMilestoneSession(params)).rejects.toThrow('boom');
    expect(conversationsDb.delete).toHaveBeenCalledWith(42);
    expect(tasksDb.updateStatus).not.toHaveBeenCalled();
  });
});
