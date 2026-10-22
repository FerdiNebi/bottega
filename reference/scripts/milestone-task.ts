#!/usr/bin/env node

/**
 * CLI script the milestone verification session runs to turn the changes the
 * human asks for into follow-up tasks (project-bootstrap extra, "Follow-up
 * tasks").
 *
 * Usage:
 *   tsx scripts/milestone-task.ts create <milestoneTaskId> <jsonPath>
 *   tsx scripts/milestone-task.ts list <milestoneTaskId>
 *   tsx scripts/milestone-task.ts sync <milestoneTaskId>
 *
 * create: the JSON is { title, spec }. The task is created in the milestone's
 * project, owned by its owner, branched from the milestone's branch, and
 * listed under the milestone doc's `## Follow-up tasks`. On any error nothing
 * is left behind and the script exits non-zero.
 * list: the follow-up tasks and their status.
 * sync: merge the default branch into the milestone's worktree.
 */

import fs from 'fs';
import { tasksDb, initializeDatabase } from '../server/database/db.js';
import { readTaskDoc, writeTaskDoc, deleteTaskArchive } from '../server/services/documentation.js';
import {
  createWorktree,
  getTaskBranch,
  isGitRepository,
  removeWorktree,
  resolveBootstrapBase,
  updateWorktreeFromDefault,
  worktreeExists,
} from '../server/services/worktree.js';
import {
  createFollowUpTask,
  listFollowUpTasks,
  parseMilestoneTaskArgs,
  syncMilestoneWorktree,
} from '../server/services/milestoneFollowUps.js';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const USAGE = `Usage:
  tsx scripts/milestone-task.ts create <milestoneTaskId> <jsonPath>
  tsx scripts/milestone-task.ts list <milestoneTaskId>
  tsx scripts/milestone-task.ts sync <milestoneTaskId>`;

function fail(heading: string, errors: string[]): never {
  console.error(`${colors.red}Error:${colors.reset} ${heading}`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

const getTask = (id: number) => tasksDb.getWithProject(id);

async function create(milestoneTaskId: number, jsonPath: string): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail('No task was created.', [`Could not read JSON from ${jsonPath}: ${message}`]);
  }

  const result = await createFollowUpTask(milestoneTaskId, input, {
    getTask,
    isGitRepository,
    getTaskBranch,
    resolveBaseRef: async (repoPath) => (await resolveBootstrapBase(repoPath)).baseRef,
    createTask: (projectId, title, userId) => tasksDb.create(projectId, title, false, userId),
    deleteTask: (id) => tasksDb.delete(id),
    createWorktree,
    removeWorktree,
    readTaskDoc,
    writeTaskDoc,
    deleteTaskArchive,
  });
  if (!result.ok) fail('No task was created.', result.errors);

  console.log('');
  console.log(`${colors.green}${colors.bright}Created task #${result.task.id}: ${result.task.title}${colors.reset}`);
  if (result.baseRef) console.log(`${colors.cyan}Branched from:${colors.reset} ${result.baseRef}`);
  console.log(`${colors.cyan}Listed under:${colors.reset} ## Follow-up tasks of task #${result.milestone.id}`);
  console.log('');
  console.log('It is in Pending, ready to start from its Task Detail (or with autopilot Start).');
}

function list(milestoneTaskId: number): void {
  const result = listFollowUpTasks(milestoneTaskId, { getTask, readTaskDoc });
  if (!result.ok) fail('Could not list follow-up tasks.', result.errors);

  if (result.tasks.length === 0) {
    console.log(`Milestone task #${milestoneTaskId} has no follow-up tasks.`);
    return;
  }
  console.log(`${colors.cyan}ID\tStatus\tTitle${colors.reset}`);
  for (const task of result.tasks) {
    console.log(`${task.id}\t${task.status}\t${task.title ?? '-'}`);
  }
  console.log('');
  console.log(`${result.open} of ${result.tasks.length} follow-up task(s) still open.`);
}

async function sync(milestoneTaskId: number): Promise<void> {
  const result = await syncMilestoneWorktree(milestoneTaskId, {
    getTask,
    worktreeExists,
    updateWorktreeFromDefault,
  });
  if (!result.ok) fail('The worktree was not updated.', result.errors);
  console.log(`${colors.green}Merged ${result.baseRef ?? 'the default branch'} into the milestone branch.${colors.reset}`);
}

// Initialize database (ensures schema and migrations are run)
await initializeDatabase();

const args = parseMilestoneTaskArgs(process.argv.slice(2));
if (!args.ok) {
  console.error(`${colors.red}Error:${colors.reset} ${args.error}`);
  console.log(`\n${USAGE}`);
  process.exit(1);
}
if (args.command === 'create') await create(args.milestoneTaskId, args.jsonPath);
else if (args.command === 'list') list(args.milestoneTaskId);
else await sync(args.milestoneTaskId);
