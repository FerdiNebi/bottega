// Test slots (extra/parallel-runs.md §2): at most `projects.test_slots` tasks
// of a project run heavy test suites at once. Agents take and free a slot with
// scripts/test-slot.ts; the lease belongs to the task, so it can span several
// commands, and Bottega frees it when the task's agent run ends.

import { projectsDb, tasksDb, testSlotsDb } from '../database/db.js';

/** A lease nobody renewed for this long is treated as abandoned. */
export const LEASE_STALE_MS = 45 * 60 * 1000;
/** acquire gives up after this long, so it fits in one 10-minute Bash call. */
export const ACQUIRE_MAX_WAIT_MS = 9 * 60 * 1000;
export const ACQUIRE_POLL_MS = 5 * 1000;
export const DEFAULT_TEST_SLOTS = 2;

export type AcquireOutcome =
  | { status: 'acquired'; renewed: boolean; waitedMs: number }
  | { status: 'busy'; holders: number[]; waitedMs: number };

export interface AcquireOptions {
  maxWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (holders: number[]) => void;
}

export function projectTestSlots(projectId: number): number {
  const slots = projectsDb.getByIdAdmin(projectId)?.test_slots ?? DEFAULT_TEST_SLOTS;
  return Math.max(1, slots);
}

/** Take a test slot for the task, waiting up to `maxWaitMs` for one to free up. */
export async function acquireTestSlot(taskId: number, options: AcquireOptions = {}): Promise<AcquireOutcome> {
  const {
    maxWaitMs = ACQUIRE_MAX_WAIT_MS,
    pollMs = ACQUIRE_POLL_MS,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    onWait,
  } = options;

  const task = tasksDb.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const slots = projectTestSlots(task.project_id);

  const start = now();
  let announced = false;
  for (;;) {
    const t = now();
    const result = testSlotsDb.acquire(task.project_id, taskId, slots, t, t - LEASE_STALE_MS);
    const waitedMs = t - start;
    if (result.acquired) {
      return { status: 'acquired', renewed: result.renewed, waitedMs };
    }
    if (waitedMs + pollMs > maxWaitMs) {
      return { status: 'busy', holders: result.holders, waitedMs };
    }
    if (!announced) {
      announced = true;
      onWait?.(result.holders);
    }
    await sleep(pollMs);
  }
}

export function releaseTestSlot(taskId: number): boolean {
  return testSlotsDb.release(taskId);
}
