// Per-conversation cost (estimated USD). The SDK's `result.total_cost_usd` is
// cumulative for the session, across resumes, so each result overwrites the
// stored total instead of adding to it. A task's cost is the sum over its
// conversations; a step's cost is the sum over its runs' conversations.

import { conversationsDb } from '../../database/db.js';
import type { StreamingContext } from './types.js';

/** Store the conversation's new total and tell the task's subscribers. */
export function recordConversationCost(ctx: StreamingContext, totalCostUsd: number): void {
  const { conversationId, taskId } = ctx;
  try {
    const conversationCostUsd = conversationsDb.recordCost(conversationId, totalCostUsd);
    if (conversationCostUsd === null || !taskId) return;
    const taskCostUsd = conversationsDb.getTaskCost(taskId) ?? conversationCostUsd;
    ctx.broadcastToTaskSubscribersFn?.(taskId, {
      type: 'task-cost-updated',
      conversationId,
      conversationCostUsd,
      taskCostUsd,
    });
  } catch (error) {
    // Cost is informational; never let it break a turn.
    console.error(`[CostTracking] Failed to record cost for conversation ${conversationId}:`, error);
  }
}
