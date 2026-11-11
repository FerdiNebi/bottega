// Turn limit (core/execution-loop.md, "Has a turn budget"). A run whose turn
// ended on its `maxTurns` budget has not finished: chaining from it would send
// the task through review's early return into another capped run. Instead the
// run is marked failed, so the completion handler doesn't chain, and the
// autopilot stop reason names the limit.

import { agentRunsDb } from '../../database/db.js';
import type { StreamingContext } from './types.js';

/**
 * Stop the agent run linked to `ctx.conversationId` if it is still running.
 * Returns true when a run was stopped.
 */
export function stopRunForTurnLimit(ctx: StreamingContext, maxTurns: number | undefined): boolean {
  const { taskId, conversationId } = ctx;
  if (!taskId) return false;
  const run = agentRunsDb.getByTask(taskId).find((r) => r.conversation_id === conversationId);
  if (!run || run.status !== 'running') return false;

  agentRunsDb.updateStatus(run.id, 'failed');
  const limit = maxTurns !== undefined ? `${maxTurns}-turn` : 'turn';
  ctx.stopReason = `the ${run.agent_type} run hit its ${limit} limit.`;
  console.log(`[TurnLimit] Agent run ${run.id} (${run.agent_type}) for task ${taskId} hit its ${limit} limit`);

  ctx.broadcastToTaskSubscribersFn?.(taskId, {
    type: 'agent-run-updated',
    agentRun: {
      id: run.id,
      status: 'failed',
      agent_type: run.agent_type,
      conversation_id: conversationId,
    },
  });
  return true;
}
