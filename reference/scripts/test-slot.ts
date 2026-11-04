#!/usr/bin/env node

/**
 * CLI script to take or free one of a project's test slots, so that only a
 * few tasks run heavy test suites at the same time (extra/parallel-runs.md).
 * Used by Claude agents before and after a full / E2E test run.
 *
 * Usage: tsx scripts/test-slot.ts acquire <taskId>
 *        tsx scripts/test-slot.ts release <taskId>
 *
 * Exit codes: 0 = done, 1 = usage error, 3 = all slots still busy after
 * waiting (run acquire again).
 */

import { initializeDatabase } from '../server/database/db.js';
import { acquireTestSlot, releaseTestSlot, ACQUIRE_MAX_WAIT_MS } from '../server/services/testSlots.js';

const EXIT_BUSY = 3;

function usage(message: string): never {
  console.error(`Error: ${message}`);
  console.log('\nUsage: tsx scripts/test-slot.ts <acquire|release> <taskId>');
  process.exit(1);
}

const [command, rawTaskId] = process.argv.slice(2);
if (command !== 'acquire' && command !== 'release') usage('command must be "acquire" or "release"');
const taskId = parseInt(rawTaskId ?? '', 10);
if (isNaN(taskId)) usage('Task ID must be a number');

await initializeDatabase();

if (command === 'release') {
  const released = releaseTestSlot(taskId);
  console.log(released ? `Test slot of task ${taskId} released.` : `Task ${taskId} held no test slot.`);
  process.exit(0);
}

try {
  const outcome = await acquireTestSlot(taskId, {
    onWait: (holders) =>
      console.log(
        `All test slots are taken (tasks ${holders.join(', ')}); waiting up to ${ACQUIRE_MAX_WAIT_MS / 60000} minutes...`,
      ),
  });
  if (outcome.status === 'acquired') {
    const waited = outcome.waitedMs > 0 ? ` after ${Math.round(outcome.waitedMs / 1000)}s` : '';
    console.log(`Test slot ${outcome.renewed ? 'renewed' : 'acquired'} for task ${taskId}${waited}.`);
    process.exit(0);
  }
  console.log(
    `All test slots busy (held by tasks ${outcome.holders.join(', ')}). Run this command again to keep waiting.`,
  );
  process.exit(EXIT_BUSY);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
