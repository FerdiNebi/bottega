// The autopilot switches (extra/autopilot.md), in their own module so the
// conversation layer can read them without importing agentRunner/autopilot
// (which would close an import cycle through startConversation).

import { agentRunsDb, projectsDb, tasksDb } from '../database/db.js';
import type { TaskRow } from '../../shared/types/db.js';

export function isAutopilotProject(projectId: number): boolean {
  return projectsDb.getByIdAdmin(projectId)?.autopilot_enabled === 1;
}

/**
 * A task's effective autopilot: the project's switch and the task's own
 * "Autopilot may work on this task" switch. Every per-task decision (prompt
 * addendum, question ban, chaining, finishing) reads this, not the project flag.
 */
export function isAutopilotTask(task: Pick<TaskRow, 'project_id' | 'autopilot_can_work'> | number | undefined | null): boolean {
  const row = typeof task === 'number' ? tasksDb.getById(task) : task;
  if (!row || row.autopilot_can_work === 0) return false;
  return isAutopilotProject(row.project_id);
}

/**
 * A human turned "Autopilot may work on this task" off. When autopilot is
 * running the task, say that it hands the task back after the current step.
 */
export function noteTaskSwitchedToManual(taskId: number): void {
  const task = tasksDb.getById(taskId);
  if (!task || !isAutopilotProject(task.project_id)) return;
  if (!agentRunsDb.getByTask(taskId).some((run) => run.status === 'running')) return;
  projectsDb.setAutopilotMessage(
    task.project_id,
    `Task #${taskId} switched to manual; autopilot stops after its current step.`,
  );
}
