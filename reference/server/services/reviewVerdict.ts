/**
 * Did a review run leave a verdict? (core/orchestration-loop.md)
 *
 * Every verdict rewrites Review Findings in the task doc: READY and BLOCKED
 * also run a script, and NEEDS_WORK / IN_PROGRESS just rewrite the section. A
 * review that ends its turn early, for example waiting on a background
 * command that never wakes it, writes nothing. If the loop sent that to
 * implementation, implementation would find no work and hand the same commit
 * to another review.
 *
 * The check is a file fact, not a reading of the agent's prose: the doc's
 * mtime when the review started vs. when it ended. Nothing else writes the
 * task doc while a review runs (one agent per task at a time). Kept in memory:
 * a server restart fails the running review anyway, so it never chains.
 */

import fs from 'fs';
import { getTaskDocPath } from './documentation.js';

/** agent run id → task doc mtime (ms) at start; null when the doc didn't exist. */
const mtimeAtStart = new Map<number, number | null>();

function docMtime(projectId: number, taskId: number): number | null {
  try {
    return fs.statSync(getTaskDocPath(projectId, taskId)).mtimeMs;
  } catch {
    return null;
  }
}

/** Remember the task doc's state as a review run starts. */
export function recordReviewStart(agentRunId: number, projectId: number, taskId: number): void {
  mtimeAtStart.set(agentRunId, docMtime(projectId, taskId));
}

/**
 * True when the review run left the task doc untouched. Unknown runs (no
 * recorded start) count as having a verdict, which keeps the old behaviour.
 * Consumes the record.
 */
export function reviewLeftNoVerdict(agentRunId: number, projectId: number, taskId: number): boolean {
  if (!mtimeAtStart.has(agentRunId)) return false;
  const before = mtimeAtStart.get(agentRunId) ?? null;
  mtimeAtStart.delete(agentRunId);
  return docMtime(projectId, taskId) === before;
}
