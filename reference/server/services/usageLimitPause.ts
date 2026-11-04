// Usage-limit pause (extra/parallel-runs.md §1). An agent run whose turn ended
// on the provider's usage limit is not a finished turn: chaining from it would
// ping-pong implementation ↔ review in seconds until the iteration cap blocks
// the task. Instead the run is marked failed, the task records when to resume,
// and a timer starts a fresh run of the same agent type after the reset.
//
// `startAgentRun` is imported dynamically: agentRunner imports
// startConversation, which imports this module.

import { agentRunsDb, projectsDb, tasksDb } from '../database/db.js';
import { isAutopilotProject } from './autopilotFlag.js';
import type { UsageLimitHit } from './conversation/runStreamingLoop.js';
import type {
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';

/** Resume this long after the reported reset, so the limit has surely lifted. */
export const RESET_GRACE_MS = 2 * 60 * 1000;
/** Resume delay when the harness reported no reset time. */
export const UNKNOWN_RESET_DELAY_MS = 30 * 60 * 1000;
/** A pause that is already due at startup resumes this long after boot. */
const OVERDUE_RESUME_DELAY_MS = 5 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface UsageLimitResumeDeps {
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
}

interface PauseContext extends UsageLimitResumeDeps {
  conversationId: number;
  taskId?: number | null | undefined;
  userId?: number | undefined;
}

// Server-wide broadcast functions, set at startup, for resumes scheduled
// without a streaming context (restored after a restart).
let defaultDeps: UsageLimitResumeDeps = {};
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function configureUsageLimitResume(deps: UsageLimitResumeDeps): void {
  defaultDeps = deps;
}

export function computeResumeAt(resetsAt: number | null, now: number = Date.now()): Date {
  if (resetsAt === null) return new Date(now + UNKNOWN_RESET_DELAY_MS);
  return new Date(Math.max(resetsAt, now) + RESET_GRACE_MS);
}

// Autopilot board message (extra/autopilot.md), written directly: importing
// autopilot.ts here would close an import cycle through agentRunner.
function setAutopilotMessage(projectId: number, message: string): void {
  console.log(`[Autopilot] project ${projectId}: ${message}`);
  projectsDb.setAutopilotMessage(projectId, message);
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Pause the agent run linked to `ctx.conversationId` if it is still running.
 * Returns true when a run was paused (the caller's completion handler then
 * sees status 'failed' and doesn't chain).
 */
export function pauseRunForUsageLimit(ctx: PauseContext, hit: UsageLimitHit): boolean {
  const { taskId, conversationId } = ctx;
  if (!taskId) return false;
  const run = agentRunsDb.getByTask(taskId).find((r) => r.conversation_id === conversationId);
  if (!run || run.status !== 'running') return false;

  agentRunsDb.updateStatus(run.id, 'failed');
  // The run did no work, so it must not count toward the iteration cap.
  tasksDb.decrementRunCount(taskId);
  const resumeAt = computeResumeAt(hit.resetsAt);
  tasksDb.setUsageLimitPause(taskId, resumeAt.toISOString(), run.agent_type);
  console.log(
    `[UsageLimit] Agent run ${run.id} (${run.agent_type}) for task ${taskId} hit the usage limit; resuming at ${resumeAt.toISOString()}`,
  );

  ctx.broadcastToTaskSubscribersFn?.(taskId, {
    type: 'agent-run-updated',
    agentRun: {
      id: run.id,
      status: 'failed',
      agent_type: run.agent_type,
      conversation_id: conversationId,
    },
  });
  ctx.broadcastToTaskSubscribersFn?.(taskId, {
    type: 'task-usage-limit',
    resumeAt: resumeAt.toISOString(),
    agentType: run.agent_type,
  });

  const task = tasksDb.getById(taskId);
  if (task && isAutopilotProject(task.project_id)) {
    setAutopilotMessage(task.project_id, `Paused: task #${taskId} hit the usage limit; resumes at ${formatTime(resumeAt)}.`);
  }

  scheduleResume(taskId, resumeAt, ctx.userId, {
    broadcastFn: ctx.broadcastFn ?? defaultDeps.broadcastFn,
    broadcastToTaskSubscribersFn: ctx.broadcastToTaskSubscribersFn ?? defaultDeps.broadcastToTaskSubscribersFn,
  });
  return true;
}

function scheduleResume(
  taskId: number,
  resumeAt: Date,
  userId: number | undefined,
  deps: UsageLimitResumeDeps,
): void {
  clearTimer(taskId);
  const delay = Math.max(resumeAt.getTime() - Date.now(), 0);
  // setTimeout fires at once for delays past 2^31-1 ms (~24 days); wait in
  // chunks instead.
  const timer = setTimeout(() => {
    timers.delete(taskId);
    if (delay > MAX_TIMER_MS) {
      scheduleResume(taskId, resumeAt, userId, deps);
      return;
    }
    void resumeTask(taskId, userId, deps);
  }, Math.min(delay, MAX_TIMER_MS));
  // Don't keep the process (or a test run) alive just for a pending resume.
  timer.unref?.();
  timers.set(taskId, timer);
}

function clearTimer(taskId: number): void {
  const timer = timers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(taskId);
  }
}

/** Exported for tests. */
export async function resumeTask(
  taskId: number,
  userId: number | undefined,
  deps: UsageLimitResumeDeps,
): Promise<void> {
  const task = tasksDb.getById(taskId);
  const agentType = task?.usage_limit_agent_type;
  if (!task || !agentType) return;
  tasksDb.clearUsageLimitPause(taskId);
  broadcastPauseCleared(taskId, deps);

  if (task.status === 'completed' || task.workflow_blocked) {
    console.log(`[UsageLimit] Task ${taskId} is ${task.workflow_blocked ? 'blocked' : 'completed'}; not resuming`);
    return;
  }
  if (agentRunsDb.getByTask(taskId).some((r) => r.status === 'running')) {
    console.log(`[UsageLimit] Task ${taskId} already has a running agent; not resuming`);
    return;
  }

  console.log(`[UsageLimit] Resuming task ${taskId} with a fresh ${agentType} run`);
  try {
    const { startAgentRun } = await import('./agentRunner.js');
    await startAgentRun(taskId, agentType, {
      broadcastFn: deps.broadcastFn,
      broadcastToTaskSubscribersFn: deps.broadcastToTaskSubscribersFn,
      userId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[UsageLimit] Failed to resume task ${taskId}:`, err);
    if (isAutopilotProject(task.project_id)) {
      setAutopilotMessage(task.project_id, `Stopped: task #${taskId}: could not resume ${agentType} after the usage limit: ${message}`);
    }
  }
}

/** Starting a run by hand supersedes the pause. */
export function cancelUsageLimitPause(taskId: number): void {
  clearTimer(taskId);
  if (!tasksDb.getById(taskId)?.usage_limit_resume_at) return;
  tasksDb.clearUsageLimitPause(taskId);
  console.log(`[UsageLimit] Cancelled the usage-limit pause of task ${taskId}`);
  broadcastPauseCleared(taskId, defaultDeps);
}

function broadcastPauseCleared(taskId: number, deps: UsageLimitResumeDeps): void {
  deps.broadcastToTaskSubscribersFn?.(taskId, { type: 'task-usage-limit', resumeAt: null, agentType: null });
}

/** Server startup: schedule every pause recorded before the restart. */
export function restoreUsageLimitPauses(): number {
  const paused = tasksDb.getUsageLimitPaused();
  for (const task of paused) {
    const at = Date.parse(task.usage_limit_resume_at ?? '');
    const resumeAt = Number.isNaN(at) || at <= Date.now() ? new Date(Date.now() + OVERDUE_RESUME_DELAY_MS) : new Date(at);
    scheduleResume(task.id, resumeAt, undefined, defaultDeps);
  }
  if (paused.length > 0) {
    console.log(`[UsageLimit] Restored ${paused.length} usage-limit pause(s): ${paused.map((t) => `#${t.id}`).join(', ')}`);
  }
  return paused.length;
}
