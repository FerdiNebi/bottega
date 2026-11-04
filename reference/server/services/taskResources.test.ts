import { describe, it, expect } from 'vitest';
import { buildTaskEnv, taskPortRange, TASK_PORT_COUNT } from './taskResources.js';

describe('taskPortRange', () => {
  it('gives each task 10 consecutive ports from 20000', () => {
    expect(taskPortRange(0)).toEqual({ base: 20000, end: 20009 });
    expect(taskPortRange(168)).toEqual({ base: 21680, end: 21689 });
    expect(taskPortRange(169).base - taskPortRange(168).base).toBe(TASK_PORT_COUNT);
  });

  it('stays below the ephemeral port ranges', () => {
    for (let id = 0; id < 5000; id++) {
      expect(taskPortRange(id).end).toBeLessThan(32768);
    }
  });

  it('wraps every 1200 tasks', () => {
    expect(taskPortRange(1368)).toEqual(taskPortRange(168));
  });
});

describe('buildTaskEnv', () => {
  it('exposes the task, project and port range', () => {
    expect(buildTaskEnv(168, 2)).toEqual({
      BOTTEGA_TASK_ID: '168',
      BOTTEGA_PROJECT_ID: '2',
      BOTTEGA_PORT_BASE: '21680',
      BOTTEGA_PORT_COUNT: '10',
    });
  });
});
