// Per-task test resources (extra/parallel-runs.md §3): a port range and an id
// every agent process of a task gets, so tasks running side by side don't
// share test servers or databases.

const PORT_RANGE_START = 20000;
// 1200 ranges × 10 ports = 20000–31999, below the OS ephemeral ranges
// (Linux 32768+, Windows 49152+).
const PORT_RANGE_SLOTS = 1200;
export const TASK_PORT_COUNT = 10;

export interface TaskPortRange {
  base: number;
  /** Last port of the range (inclusive). */
  end: number;
}

export function taskPortRange(taskId: number): TaskPortRange {
  const base = PORT_RANGE_START + (taskId % PORT_RANGE_SLOTS) * TASK_PORT_COUNT;
  return { base, end: base + TASK_PORT_COUNT - 1 };
}

/** Environment variables added to every harness process of the task. */
export function buildTaskEnv(taskId: number, projectId: number): Record<string, string> {
  return {
    BOTTEGA_TASK_ID: String(taskId),
    BOTTEGA_PROJECT_ID: String(projectId),
    BOTTEGA_PORT_BASE: String(taskPortRange(taskId).base),
    BOTTEGA_PORT_COUNT: String(TASK_PORT_COUNT),
  };
}
