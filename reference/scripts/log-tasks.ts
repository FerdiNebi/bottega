#!/usr/bin/env node

/**
 * CLI script any task conversation runs to log new tasks from what it found
 * (extra/task-logging.md).
 *
 * Usage:
 *   tsx scripts/log-tasks.ts create <sourceTaskId> <jsonPath>
 *   tsx scripts/log-tasks.ts list <sourceTaskId>
 *
 * create: the JSON is an array of { key, title, dependsOn, spec, kind?,
 * autopilotCanStart?, autopilotCanWork? }; dependsOn holds batch keys or ids
 * of existing tasks in the project. Tasks are created in the source task's
 * project, owned by its owner, titled "<level>. <title>", and listed under the
 * source doc's `## Logged tasks`. On any error nothing is left behind and the
 * script exits non-zero.
 * list: the logged tasks and their status.
 */

import fs from 'fs';
import { tasksDb, initializeDatabase } from '../server/database/db.js';
import { readTaskDoc, writeTaskDoc, deleteTaskArchive } from '../server/services/documentation.js';
import {
  createWorktree,
  isGitRepository,
  removeWorktree,
  resolveBootstrapBase,
} from '../server/services/worktree.js';
import { listLoggedTasks, logTasks, parseLogTasksArgs } from '../server/services/taskLogging.js';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const USAGE = `Usage:
  tsx scripts/log-tasks.ts create <sourceTaskId> <jsonPath>
  tsx scripts/log-tasks.ts list <sourceTaskId>`;

function fail(heading: string, errors: string[]): never {
  console.error(`${colors.red}Error:${colors.reset} ${heading}`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

const getTask = (id: number) => tasksDb.getWithProject(id);

async function create(sourceTaskId: number, jsonPath: string): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail('No tasks were created.', [`Could not read JSON from ${jsonPath}: ${message}`]);
  }

  const result = await logTasks(sourceTaskId, input, {
    getTask,
    isGitRepository,
    resolveBaseRef: async (repoPath) => (await resolveBootstrapBase(repoPath)).baseRef,
    createTask: (projectId, title, userId, autopilot) => tasksDb.create(projectId, title, false, userId, autopilot),
    deleteTask: (id) => tasksDb.delete(id),
    // Detached, so the script exits as soon as the tasks exist instead of
    // waiting for node_modules to finish copying.
    createWorktree: (repoPath, taskId, title, subprojectPath, baseRef) =>
      createWorktree(repoPath, taskId, title, subprojectPath, baseRef, { detachDependencyCopy: true }),
    removeWorktree,
    readTaskDoc,
    writeTaskDoc,
    deleteTaskArchive,
  });
  if (!result.ok) fail('No tasks were created.', result.errors);

  console.log('');
  console.log(`${colors.green}${colors.bright}Created ${result.created.length} task(s)${colors.reset}`);
  console.log('');
  console.log(`${colors.cyan}ID\tTitle\tDepends on\tAutopilot${colors.reset}`);
  for (const task of result.created) {
    const deps = task.dependsOn.map((dep) => `#${dep.id}`).join(', ') || '-';
    const autopilot = !task.autopilotCanWork ? 'manual' : task.autopilotCanStart ? 'yes' : 'manual start';
    console.log(`${task.id}\t${task.title}\t${deps}\t${autopilot}`);
  }
  console.log('');
  if (result.baseRef) console.log(`${colors.cyan}Branched from:${colors.reset} ${result.baseRef}`);
  console.log(`${colors.cyan}Listed under:${colors.reset} ## Logged tasks of task #${result.source.id}`);
  console.log('They are in Pending, ready to start from their Task Detail (or with autopilot Start).');
}

function list(sourceTaskId: number): void {
  const result = listLoggedTasks(sourceTaskId, { getTask, readTaskDoc });
  if (!result.ok) fail('Could not list logged tasks.', result.errors);

  if (result.tasks.length === 0) {
    console.log(`Task #${sourceTaskId} has no logged tasks.`);
    return;
  }
  console.log(`${colors.cyan}ID\tStatus\tTitle${colors.reset}`);
  for (const task of result.tasks) {
    console.log(`${task.id}\t${task.status}\t${task.title ?? '-'}`);
  }
  console.log('');
  console.log(`${result.open} of ${result.tasks.length} logged task(s) still open.`);
}

// Initialize database (ensures schema and migrations are run)
await initializeDatabase();

const args = parseLogTasksArgs(process.argv.slice(2));
if (!args.ok) {
  console.error(`${colors.red}Error:${colors.reset} ${args.error}`);
  console.log(`\n${USAGE}`);
  process.exit(1);
}
if (args.command === 'create') await create(args.sourceTaskId, args.jsonPath);
else list(args.sourceTaskId);
