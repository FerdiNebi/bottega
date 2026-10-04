// Project bootstrap (extra/project-bootstrap.md): the status check that reads
// PRD.md / ARD.md from the freshly fetched remote default branch, and the
// session starter that composes task + worktree + conversation whose first
// message is the rendered bootstrap prompt.

import { conversationsDb, tasksDb } from '../database/db.js';
import { runCommand } from './shell.js';
import {
  createWorktree,
  isGitRepository,
  removeWorktree,
  resolveBootstrapBase,
} from './worktree.js';
import { buildContextPrompt, deleteTaskArchive, writeTaskDoc } from './documentation.js';
import { renderPrompt } from './promptRenderer.js';
import { startConversation } from './conversationAdapter.js';
import { getCredentialStore } from './credentials/registry.js';
import { ProviderCredentialsMissingError } from './credentials/types.js';
import { CREATE_INITIAL_TASKS_TITLE } from './taskBreakdown.js';
import type { BroadcastFn } from '../../shared/websocket/messages.js';
import type { Provider } from '../../shared/providers/types.js';
import type {
  BootstrapKind,
  BootstrapMode,
  BootstrapStatusResponse,
  StartBootstrapResponse,
} from '../../shared/api/projects.js';

export const BOOTSTRAP_DOCS = { prd: 'PRD.md', ard: 'ARD.md' } as const;

const PROMPT_BY_KIND: Record<BootstrapKind, string> = {
  prd: 'prd',
  ard: 'ard',
  tasks: 'task-breakdown',
};

/** Thrown when a session's prerequisites or input are not met (HTTP 409 / 400). */
export class BootstrapRequestError extends Error {
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.name = 'BootstrapRequestError';
    this.status = status;
  }
}

async function fileExistsAtRef(repoPath: string, ref: string, file: string): Promise<boolean> {
  try {
    await runCommand('git', ['cat-file', '-e', `${ref}:${file}`], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

export interface BootstrapStatus extends BootstrapStatusResponse {
  baseRef: string;
}

export async function getBootstrapStatus(repoPath: string): Promise<BootstrapStatus> {
  if (!(await isGitRepository(repoPath))) {
    return {
      defaultBranch: null,
      baseRef: '',
      isGitRepository: false,
      prd: { onMain: false },
      ard: { onMain: false },
      stale: false,
    };
  }

  const { defaultBranch, baseRef, stale } = await resolveBootstrapBase(repoPath);
  const [prd, ard] = await Promise.all([
    fileExistsAtRef(repoPath, baseRef, BOOTSTRAP_DOCS.prd),
    fileExistsAtRef(repoPath, baseRef, BOOTSTRAP_DOCS.ard),
  ]);
  return {
    defaultBranch,
    baseRef,
    isGitRepository: true,
    prd: { onMain: prd },
    ard: { onMain: ard },
    stale,
  };
}

/** Create vs Refine is decided by whether the document is already on main. */
export function getBootstrapMode(kind: BootstrapKind, status: BootstrapStatusResponse): BootstrapMode {
  if (kind === 'tasks') return 'create';
  return status[kind].onMain ? 'refine' : 'create';
}

export function getBootstrapTaskTitle(kind: BootstrapKind, mode: BootstrapMode): string {
  if (kind === 'tasks') return CREATE_INITIAL_TASKS_TITLE;
  return `${mode === 'refine' ? 'Refine' : 'Create'} ${kind.toUpperCase()}`;
}

function buildSeedDoc(title: string, kind: BootstrapKind, mode: BootstrapMode, input: string): string {
  const heading =
    kind === 'tasks'
      ? 'Guidance'
      : mode === 'refine'
        ? 'Requested changes'
        : kind === 'prd'
          ? 'Initial idea'
          : 'Constraints and preferences';
  return `# ${title}\n\n## ${heading}\n\n${input || '_None given._'}\n`;
}

export interface StartBootstrapSessionParams {
  kind: BootstrapKind;
  project: {
    id: number;
    repo_folder_path: string;
    subproject_path?: string | null;
  };
  userId: number;
  input?: string | undefined;
  provider: Provider;
  model: string;
  broadcastFn?: BroadcastFn | undefined;
}

export type StartBootstrapSessionResult = StartBootstrapResponse;

/**
 * Start a PRD / ARD / task-breakdown session: task with a fixed title and a
 * seeded doc, a worktree branched from `origin/<default>`, and a conversation
 * whose first message is the rendered bootstrap prompt.
 */
export async function startBootstrapSession(
  params: StartBootstrapSessionParams,
): Promise<StartBootstrapSessionResult> {
  const { kind, project, userId, provider, model, broadcastFn } = params;
  const input = params.input?.trim() ?? '';
  const repoPath = project.repo_folder_path;

  const status = await getBootstrapStatus(repoPath);
  if (!status.isGitRepository) {
    throw new BootstrapRequestError(409, 'Project bootstrap requires a git repository');
  }
  if (kind === 'tasks' && !(status.prd.onMain && status.ard.onMain)) {
    const missing = [
      !status.prd.onMain && BOOTSTRAP_DOCS.prd,
      !status.ard.onMain && BOOTSTRAP_DOCS.ard,
    ].filter(Boolean);
    throw new BootstrapRequestError(
      409,
      `${missing.join(' and ')} must be merged into ${status.defaultBranch} before creating initial tasks`,
    );
  }

  const mode = getBootstrapMode(kind, status);
  if (kind === 'prd' && mode === 'create' && !input) {
    throw new BootstrapRequestError(400, 'Describe your idea to create a PRD');
  }

  try {
    getCredentialStore(provider).read(userId);
  } catch (err) {
    throw new ProviderCredentialsMissingError(
      provider,
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }

  const title = getBootstrapTaskTitle(kind, mode);
  const task = tasksDb.create(project.id, title, false, userId);
  let worktreeCreated = false;
  let conversationId: number | null = null;

  try {
    const worktree = await createWorktree(
      repoPath,
      task.id,
      title,
      project.subproject_path ?? null,
      status.baseRef,
    );
    if (!worktree.success) {
      throw new Error(`Failed to create worktree: ${worktree.error ?? 'unknown error'}`);
    }
    worktreeCreated = true;

    writeTaskDoc(project.id, task.id, buildSeedDoc(title, kind, mode, input));
    tasksDb.updateStatus(task.id, 'in_progress');

    const message = renderPrompt(PROMPT_BY_KIND[kind], {
      mode,
      input: input || '(none)',
      taskId: task.id,
    });

    conversationId = conversationsDb.create(task.id, provider, model, null).id;
    await startConversation(task.id, message, {
      broadcastFn,
      userId,
      customSystemPrompt: buildContextPrompt(project.id, task.id),
      permissionMode: 'bypassPermissions',
      conversationId,
      provider,
      model,
      effort: null,
    });

    return { taskId: task.id, conversationId, initialMessage: message };
  } catch (error) {
    if (conversationId !== null) conversationsDb.delete(conversationId);
    if (worktreeCreated) await removeWorktree(repoPath, task.id);
    try {
      deleteTaskArchive(project.id, task.id);
    } catch {
      /* best effort */
    }
    tasksDb.delete(task.id);
    throw error;
  }
}
