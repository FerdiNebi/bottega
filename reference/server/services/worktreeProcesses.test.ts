import { describe, it, expect } from 'vitest';
import { findProcessesInDir, type ProcessInfo } from './worktreeProcesses.js';

// What task 23's agents left behind on 2026-10-07: background `pnpm dev`
// shells (cwd set via `cd <worktree>`), the pnpm process they spawned (no path
// in its command line), and the tsx dev server it ran.
const win: ProcessInfo[] = [
  { pid: 100, ppid: 1, commandLine: '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "cd D:/Projects/App-worktrees/task-23 && pnpm --filter @app/api dev &"' },
  { pid: 101, ppid: 100, commandLine: 'node pnpm.cjs --filter @app/api dev' },
  { pid: 102, ppid: 101, commandLine: 'node "D:\\Projects\\App-worktrees\\task-23\\apps\\api\\node_modules\\.bin\\..\\tsx\\dist\\cli.mjs" watch src/server.ts' },
  { pid: 200, ppid: 1, commandLine: 'node "D:\\Projects\\App-worktrees\\task-24\\node_modules\\vite\\bin\\vite.js"' },
  { pid: 300, ppid: 1, commandLine: 'node server/index.ts' },
];

describe('findProcessesInDir', () => {
  it('finds processes pointing into the worktree, with their descendants', () => {
    const pids = findProcessesInDir(win, 'D:\\Projects\\App-worktrees\\task-23');
    expect(pids.sort()).toEqual([100, 101, 102]);
  });

  it("does not match another task whose id starts with the same digits", () => {
    expect(findProcessesInDir(win, 'D:\\Projects\\App-worktrees\\task-2')).toEqual([]);
  });

  it('matches the directory itself at the end of a command line', () => {
    const procs = [{ pid: 5, ppid: 1, commandLine: 'code /repo-worktrees/task-7' }];
    expect(findProcessesInDir(procs, '/repo-worktrees/task-7/')).toEqual([5]);
  });

  it('never includes Bottega itself', () => {
    const procs = [
      { pid: 10, ppid: 1, commandLine: 'bash -c "cd /repo-worktrees/task-7 && node /bottega/server/index.ts"' },
      { pid: 11, ppid: 10, commandLine: 'node /bottega/server/index.ts' },
    ];
    expect(findProcessesInDir(procs, '/repo-worktrees/task-7', [11, 10])).toEqual([]);
  });
});

describe('stopProcessesInDir', () => {
  it('lists this machine\'s processes and stops nothing for a folder no process uses', async () => {
    const { stopProcessesInDir } = await import('./worktreeProcesses.js');
    expect(await stopProcessesInDir('/no/such/worktree-dir/task-999999')).toEqual([]);
  }, 30_000);
});
