#!/usr/bin/env node

/**
 * CLI script the "Create initial tasks" session agent runs to create the
 * confirmed task breakdown as Bottega tasks (project-bootstrap extra).
 *
 * Usage: tsx scripts/create-tasks.ts <sessionTaskId> <jsonPath>
 *
 * The JSON is an array of { key, title, dependsOn, spec }. Tasks are created
 * in the session task's project, owned by its owner, titled "<level>. <title>".
 * On any error nothing is left behind and the script exits non-zero.
 */

import fs from 'fs';
import { tasksDb, initializeDatabase } from '../server/database/db.js';
import { writeTaskDoc, deleteTaskArchive } from '../server/services/documentation.js';
import {
  createWorktree,
  removeWorktree,
  isGitRepository,
  resolveBootstrapBase,
} from '../server/services/worktree.js';
import { createTasksFromBreakdown, parseCreateTasksArgs } from '../server/services/taskBreakdown.js';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function fail(errors: string[]): never {
  console.error(`${colors.red}Error:${colors.reset} No tasks were created.`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

async function createTasks(argv: string[]): Promise<void> {
  const args = parseCreateTasksArgs(argv);
  if (!args.ok) {
    console.error(`${colors.red}Error:${colors.reset} ${args.error}`);
    console.log(`\nUsage: tsx scripts/create-tasks.ts <sessionTaskId> <jsonPath>`);
    process.exit(1);
  }

  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(args.jsonPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail([`Could not read JSON from ${args.jsonPath}: ${message}`]);
  }

  const result = await createTasksFromBreakdown(args.sessionTaskId, input, {
    getSessionTask: (id) => tasksDb.getWithProject(id),
    isGitRepository,
    resolveBaseRef: async (repoPath) => (await resolveBootstrapBase(repoPath)).baseRef,
    createTask: (projectId, title, userId) => tasksDb.create(projectId, title, false, userId),
    deleteTask: (id) => tasksDb.delete(id),
    markTaskCompleted: (id) => tasksDb.update(id, { status: 'completed' }),
    createWorktree,
    removeWorktree,
    writeTaskDoc,
    deleteTaskArchive,
  });

  if (!result.ok) fail(result.errors);

  console.log('');
  console.log(`${colors.green}${colors.bright}Created ${result.created.length} tasks${colors.reset}`);
  console.log('');
  console.log(`${colors.cyan}ID\tTitle\tDepends on${colors.reset}`);
  for (const task of result.created) {
    const deps = task.dependsOn.map((dep) => `#${dep.id}`).join(', ') || '-';
    console.log(`${task.id}\t${task.title}\t${deps}`);
  }
  console.log('');
  console.log(`Session task ${args.sessionTaskId} marked as completed.`);
}

// Initialize database (ensures schema and migrations are run)
await initializeDatabase();

await createTasks(process.argv.slice(2));
