import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./shell.js', () => ({ runCommand: vi.fn() }));

vi.mock('./worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worktree.js')>();
  return { ...actual, createWorktree: vi.fn(), removeWorktree: vi.fn() };
});

vi.mock('../database/db.js', () => ({
  tasksDb: { create: vi.fn(), delete: vi.fn(), updateStatus: vi.fn() },
  conversationsDb: { create: vi.fn(), delete: vi.fn() },
}));

vi.mock('./documentation.js', () => ({
  buildContextPrompt: vi.fn(() => 'context'),
  writeTaskDoc: vi.fn(),
  deleteTaskArchive: vi.fn(),
}));

vi.mock('./promptRenderer.js', () => ({
  renderPrompt: vi.fn((name: string) => `rendered:${name}`),
}));

vi.mock('./conversationAdapter.js', () => ({ startConversation: vi.fn() }));

const mockRead = vi.fn();
vi.mock('./credentials/registry.js', () => ({
  getCredentialStore: vi.fn(() => ({ read: mockRead })),
}));

import { runCommand } from './shell.js';
import { createWorktree, removeWorktree } from './worktree.js';
import { tasksDb, conversationsDb } from '../database/db.js';
import { writeTaskDoc } from './documentation.js';
import { renderPrompt } from './promptRenderer.js';
import { startConversation } from './conversationAdapter.js';
import { ProviderCredentialsMissingError } from './credentials/types.js';
import {
  BootstrapRequestError,
  getBootstrapMode,
  getBootstrapStatus,
  getBootstrapTaskTitle,
  startBootstrapSession,
} from './projectBootstrap.js';

interface GitState {
  isRepo?: boolean;
  fetchFails?: boolean;
  /** Files present at each ref, e.g. { 'origin/main': ['PRD.md'] }. */
  files?: Record<string, string[]>;
}

const mockRunCommand = vi.mocked(runCommand);

function mockGit({ isRepo = true, fetchFails = false, files = {} }: GitState): void {
  mockRunCommand.mockImplementation((_cmd, args) => {
    const ok = () => Promise.resolve({ stdout: '', stderr: '' });
    const fail = () => Promise.reject(new Error(`git ${args.join(' ')} failed`));
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') return isRepo ? ok() : fail();
    if (args[0] === 'symbolic-ref') return Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' });
    if (args[0] === 'fetch') return fetchFails ? fail() : ok();
    if (args[0] === 'cat-file') {
      const [ref, file] = String(args[2]).split(':');
      return files[ref!]?.includes(file!) ? ok() : fail();
    }
    return ok();
  });
}

const project = { id: 3, repo_folder_path: '/repo', subproject_path: null };
const baseParams = { project, userId: 7, provider: 'anthropic' as const, model: 'opus' };

describe('getBootstrapStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and reads both docs from origin/<default>', async () => {
    mockGit({ files: { 'origin/main': ['PRD.md', 'ARD.md'], main: [] } });

    const status = await getBootstrapStatus('/repo');

    expect(status).toEqual({
      defaultBranch: 'main',
      baseRef: 'origin/main',
      isGitRepository: true,
      prd: { onMain: true },
      ard: { onMain: true },
      stale: false,
    });
    expect(mockRunCommand).toHaveBeenCalledWith(
      'git',
      ['fetch', '--quiet', 'origin', 'main'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(mockRunCommand).toHaveBeenCalledWith('git', ['cat-file', '-e', 'origin/main:PRD.md'], {
      cwd: '/repo',
    });
  });

  it('reports a document that is missing on main', async () => {
    mockGit({ files: { 'origin/main': ['PRD.md'] } });

    const status = await getBootstrapStatus('/repo');

    expect(status.prd.onMain).toBe(true);
    expect(status.ard.onMain).toBe(false);
  });

  it('falls back to the local default branch and marks the status stale when fetch fails', async () => {
    mockGit({ fetchFails: true, files: { main: ['PRD.md'], 'origin/main': ['PRD.md', 'ARD.md'] } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const status = await getBootstrapStatus('/repo');

    expect(status.stale).toBe(true);
    expect(status.baseRef).toBe('main');
    expect(status.prd.onMain).toBe(true);
    expect(status.ard.onMain).toBe(false);
  });

  it('reports a non-git folder without running git reads', async () => {
    mockGit({ isRepo: false });

    const status = await getBootstrapStatus('/repo');

    expect(status.isGitRepository).toBe(false);
    expect(mockRunCommand.mock.calls.some((c) => c[1][0] === 'cat-file')).toBe(false);
  });
});

describe('getBootstrapMode / getBootstrapTaskTitle', () => {
  const status = {
    defaultBranch: 'main',
    isGitRepository: true,
    prd: { onMain: true },
    ard: { onMain: false },
    stale: false,
  };

  it('refines a document that is on main and creates one that is not', () => {
    expect(getBootstrapMode('prd', status)).toBe('refine');
    expect(getBootstrapMode('ard', status)).toBe('create');
    expect(getBootstrapMode('tasks', status)).toBe('create');
  });

  it('uses the fixed session titles', () => {
    expect(getBootstrapTaskTitle('prd', 'refine')).toBe('Refine PRD');
    expect(getBootstrapTaskTitle('ard', 'create')).toBe('Create ARD');
    expect(getBootstrapTaskTitle('tasks', 'create')).toBe('Create initial tasks');
  });
});

describe('startBootstrapSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRead.mockReturnValue({ token: 't', tokenPath: '/t' });
    vi.mocked(tasksDb.create).mockReturnValue({ id: 42 } as never);
    vi.mocked(conversationsDb.create).mockReturnValue({ id: 99 } as never);
    vi.mocked(createWorktree).mockResolvedValue({ success: true });
    vi.mocked(removeWorktree).mockResolvedValue({ success: true });
    vi.mocked(startConversation).mockResolvedValue({ conversationId: 99, claudeSessionId: 's' });
  });

  it('creates the task, a worktree from origin/<default>, and a conversation with the rendered prompt', async () => {
    mockGit({ files: { 'origin/main': [] } });

    const result = await startBootstrapSession({ ...baseParams, kind: 'prd', input: 'Meal ordering' });

    expect(result).toEqual({ taskId: 42, conversationId: 99, initialMessage: 'rendered:prd' });
    expect(tasksDb.create).toHaveBeenCalledWith(3, 'Create PRD', false, 7);
    expect(createWorktree).toHaveBeenCalledWith('/repo', 42, 'Create PRD', null, 'origin/main');
    expect(writeTaskDoc).toHaveBeenCalledWith(3, 42, expect.stringContaining('## Initial idea\n\nMeal ordering'));
    expect(renderPrompt).toHaveBeenCalledWith('prd', { mode: 'create', input: 'Meal ordering', taskId: 42 });
    expect(conversationsDb.create).toHaveBeenCalledWith(42, 'anthropic', 'opus', null);
    expect(startConversation).toHaveBeenCalledWith(
      42,
      'rendered:prd',
      expect.objectContaining({
        conversationId: 99,
        customSystemPrompt: 'context',
        provider: 'anthropic',
        model: 'opus',
        userId: 7,
      }),
    );
  });

  it('starts in refine mode when the document is already on main', async () => {
    mockGit({ files: { 'origin/main': ['ARD.md'] } });

    await startBootstrapSession({ ...baseParams, kind: 'ard' });

    expect(tasksDb.create).toHaveBeenCalledWith(3, 'Refine ARD', false, 7);
    expect(renderPrompt).toHaveBeenCalledWith('ard', { mode: 'refine', input: '(none)', taskId: 42 });
  });

  it('returns 409 for tasks unless both docs are on main', async () => {
    mockGit({ files: { 'origin/main': ['PRD.md'] } });

    const error = await startBootstrapSession({ ...baseParams, kind: 'tasks' }).catch((e: unknown) => e);
    expect((error as BootstrapRequestError).status).toBe(409);
    expect((error as Error).message).toMatch(/ARD\.md must be merged into main/);
    expect(tasksDb.create).not.toHaveBeenCalled();
  });

  it('starts the task breakdown when both docs are on main', async () => {
    mockGit({ files: { 'origin/main': ['PRD.md', 'ARD.md'] } });

    await startBootstrapSession({ ...baseParams, kind: 'tasks' });

    expect(tasksDb.create).toHaveBeenCalledWith(3, 'Create initial tasks', false, 7);
    expect(renderPrompt).toHaveBeenCalledWith('task-breakdown', expect.objectContaining({ mode: 'create' }));
  });

  it('requires an idea to create a PRD', async () => {
    mockGit({ files: {} });

    const error = await startBootstrapSession({ ...baseParams, kind: 'prd', input: '  ' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BootstrapRequestError);
    expect((error as BootstrapRequestError).status).toBe(400);
  });

  it('rejects a non-git project with 409', async () => {
    mockGit({ isRepo: false });

    await expect(startBootstrapSession({ ...baseParams, kind: 'ard' })).rejects.toMatchObject({ status: 409 });
  });

  it('throws ProviderCredentialsMissingError before creating anything', async () => {
    mockGit({ files: {} });
    mockRead.mockImplementation(() => {
      throw new Error('no token');
    });

    await expect(startBootstrapSession({ ...baseParams, kind: 'ard' })).rejects.toBeInstanceOf(
      ProviderCredentialsMissingError,
    );
    expect(tasksDb.create).not.toHaveBeenCalled();
  });

  it('cleans up the task, worktree, and conversation when the session fails to start', async () => {
    mockGit({ files: {} });
    vi.mocked(startConversation).mockRejectedValue(new Error('sdk down'));

    await expect(startBootstrapSession({ ...baseParams, kind: 'ard' })).rejects.toThrow('sdk down');

    expect(conversationsDb.delete).toHaveBeenCalledWith(99);
    expect(removeWorktree).toHaveBeenCalledWith('/repo', 42);
    expect(tasksDb.delete).toHaveBeenCalledWith(42);
  });

  it('deletes the task when the worktree cannot be created', async () => {
    mockGit({ files: {} });
    vi.mocked(createWorktree).mockResolvedValue({ success: false, error: 'bad ref' });

    await expect(startBootstrapSession({ ...baseParams, kind: 'ard' })).rejects.toThrow(/bad ref/);

    expect(removeWorktree).not.toHaveBeenCalled();
    expect(tasksDb.delete).toHaveBeenCalledWith(42);
    expect(startConversation).not.toHaveBeenCalled();
  });
});
