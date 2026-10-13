// Stops processes an agent left running inside a task worktree.
//
// Agents start dev servers in the background (`pnpm dev &`) and their runs end
// without stopping them. Those orphans keep serving stale code on the app's
// port, and on Windows they hold the worktree's files open, so removing the
// worktree after a merge fails with EBUSY. Before a worktree is deleted, find
// every process whose command line points into it and kill it with its
// descendants.

import { runCommand } from './shell.js';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  commandLine: string;
}

function normalize(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * Processes whose command line references `dir` (or a path inside it),
 * plus all their descendants. Bottega's own process and parent are never
 * included. `task-2` does not match a command line about `task-23`.
 */
export function findProcessesInDir(processes: ProcessInfo[], dir: string, selfPids: number[] = []): number[] {
  const target = normalize(dir);
  const matched = new Set<number>();
  for (const p of processes) {
    const cmd = normalize(p.commandLine);
    let i = cmd.indexOf(target);
    while (i !== -1) {
      const next = cmd[i + target.length];
      if (next === undefined || /[/\s"']/.test(next)) {
        matched.add(p.pid);
        break;
      }
      i = cmd.indexOf(target, i + 1);
    }
  }

  const children = new Map<number, number[]>();
  for (const p of processes) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid)!.push(p.pid);
  }
  const queue = [...matched];
  while (queue.length) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (!matched.has(child)) {
        matched.add(child);
        queue.push(child);
      }
    }
  }

  for (const pid of selfPids) matched.delete(pid);
  return [...matched];
}

async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') {
    const { stdout } = await runCommand('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
    ]);
    const rows = JSON.parse(stdout || '[]') as { ProcessId: number; ParentProcessId: number; CommandLine: string | null }[];
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      commandLine: r.CommandLine ?? '',
    }));
  }
  const { stdout } = await runCommand('ps', ['-eo', 'pid=,ppid=,args=']);
  return stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), commandLine: m[3] ?? '' }));
}

/** Kill every process running from `dir`. Best effort: never throws. */
export async function stopProcessesInDir(dir: string): Promise<number[]> {
  try {
    const pids = findProcessesInDir(await listProcesses(), dir, [process.pid, process.ppid]);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (pids.length) console.warn(`[worktree] stopped ${pids.length} process(es) left running in ${dir}: ${pids.join(', ')}`);
    return pids;
  } catch (error) {
    console.warn(`[worktree] could not check for processes in ${dir}: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}
