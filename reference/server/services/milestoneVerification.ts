// Milestone verification sessions (extra/project-bootstrap.md, "The
// verification session"): a manual chat on a milestone task whose first
// message is the rendered `milestone-verification` prompt. The agent makes the
// app run, writes a setup/run/verify guide, and helps the human verify the
// milestone by hand. Started by autopilot when a milestone is next, or from
// Task Detail.

import { conversationsDb, tasksDb } from '../database/db.js';
import {
  createWorktree,
  isGitRepository,
  resolveBootstrapBase,
  updateWorktreeFromDefault,
  worktreeExists,
} from './worktree.js';
import { buildContextPrompt, getTaskDocPath } from './documentation.js';
import { renderPrompt, toPromptPath } from './promptRenderer.js';
import { startConversation } from './conversationAdapter.js';
import { loadAgentModelSettings } from './agentModelSettings.js';
import { getCredentialStore } from './credentials/registry.js';
import { ProviderCredentialsMissingError } from './credentials/types.js';
import { isMilestoneTitle } from '../../shared/milestones.js';
import type { BroadcastFn } from '../../shared/websocket/messages.js';
import type { StartMilestoneSessionResponse } from '../../shared/api/tasks.js';

/** Thrown when the task can't have a verification session (HTTP 409). */
export class MilestoneSessionError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'MilestoneSessionError';
  }
}

export interface StartMilestoneSessionParams {
  taskId: number;
  userId: number;
  broadcastFn?: BroadcastFn | undefined;
}

/**
 * Bring the milestone task's worktree up to date with the default branch and
 * start its verification conversation with the user's review agent model.
 */
export async function startMilestoneSession(
  params: StartMilestoneSessionParams,
): Promise<StartMilestoneSessionResponse> {
  const { taskId, userId, broadcastFn } = params;
  const task = tasksDb.getWithProject(taskId);
  if (!task) throw new MilestoneSessionError(`Task ${taskId} not found`);
  if (!isMilestoneTitle(task.title)) {
    throw new MilestoneSessionError('Only milestone tasks have a verification session');
  }
  if (task.status === 'completed') {
    throw new MilestoneSessionError('This milestone is already completed');
  }

  const repoPath = task.repo_folder_path;
  if (!(await isGitRepository(repoPath))) {
    throw new MilestoneSessionError('Milestone verification requires a git repository');
  }

  // The review agent already knows how to run the project; use its model.
  const { provider, model, effort } = loadAgentModelSettings(userId).review;
  try {
    getCredentialStore(provider).read(userId);
  } catch (err) {
    throw new ProviderCredentialsMissingError(
      provider,
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }

  if (await worktreeExists(repoPath, taskId)) {
    const updated = await updateWorktreeFromDefault(repoPath, taskId);
    if (!updated.success) {
      throw new MilestoneSessionError(updated.error ?? 'Could not update the worktree');
    }
  } else {
    const { baseRef } = await resolveBootstrapBase(repoPath);
    const created = await createWorktree(repoPath, taskId, task.title, task.subproject_path ?? null, baseRef);
    if (!created.success) {
      throw new MilestoneSessionError(`Could not create the worktree: ${created.error ?? 'unknown error'}`);
    }
  }

  const message = renderPrompt('milestone-verification', {
    taskId,
    taskDocPath: toPromptPath(getTaskDocPath(task.project_id, taskId)),
  });

  const conversationId = conversationsDb.create(taskId, provider, model, null).id;
  try {
    await startConversation(taskId, message, {
      broadcastFn,
      userId,
      customSystemPrompt: buildContextPrompt(task.project_id, taskId),
      permissionMode: 'bypassPermissions',
      conversationId,
      provider,
      model,
      effort,
    });
  } catch (error) {
    conversationsDb.delete(conversationId);
    throw error;
  }
  if (task.status === 'pending') tasksDb.updateStatus(taskId, 'in_progress');

  return { taskId, conversationId, initialMessage: message };
}
