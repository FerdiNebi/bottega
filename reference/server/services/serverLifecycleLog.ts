// Server lifecycle log: `<archive root>/logs/server.log` (JSON lines).
//
// Records start, exit, uncaught errors, signals and blocked agent commands.
// A forced kill (Stop-Process, taskkill /F, kill -9) runs no handler at all,
// so a heartbeat keeps `server-state.json` up to date; on the next start, a
// state without a clean exit means the previous server died abruptly. Bottega
// then logs when it was last alive and any process-killing commands agents ran
// around that time, the usual culprit.

import fs from 'fs';
import os from 'os';
import path from 'path';

const HEARTBEAT_MS = 15_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface ServerState {
  pid: number;
  startedAt: string;
  lastAliveAt: string;
  cleanExit: boolean;
  exitCode?: number;
}

export interface AgentKillCommand {
  at: string;
  taskId: number | null;
  conversationId: number | null;
  command: string;
}

function logsDir(): string {
  const root = process.env.BOTTEGA_ARCHIVE_ROOT || path.join(os.homedir(), '.bottega');
  return path.join(root, 'logs');
}

export function getServerLogPath(): string {
  return path.join(logsDir(), 'server.log');
}

function statePath(): string {
  return path.join(logsDir(), 'server-state.json');
}

/** Append one event. Never throws: logging must not take the server down. */
export function logServerEvent(event: string, details: Record<string, unknown> = {}): void {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    const file = getServerLogPath();
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details });
    fs.appendFileSync(file, `${line}\n`);
  } catch (error) {
    console.error('[lifecycle] Could not write the server log:', error);
  }
}

export function readServerState(): ServerState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as ServerState;
  } catch {
    return null;
  }
}

function writeServerState(state: ServerState): void {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('[lifecycle] Could not write the server state:', error);
  }
}

function errorDetails(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

export interface StartLifecycleOptions {
  port: number | string;
  /** Agent commands that stop processes, between two ISO timestamps. */
  findKillCommands?: (fromIso: string, toIso: string) => AgentKillCommand[];
}

/**
 * Report how the previous server ended, then record this one: start event,
 * heartbeat, exit and uncaught-error hooks. Call once, at startup.
 */
export function startServerLifecycleLog({ port, findKillCommands }: StartLifecycleOptions): void {
  const previous = readServerState();
  if (previous && !previous.cleanExit && previous.pid !== process.pid) {
    const lastAlive = Date.parse(previous.lastAliveAt);
    let suspects: AgentKillCommand[] = [];
    if (findKillCommands && Number.isFinite(lastAlive)) {
      try {
        suspects = findKillCommands(
          new Date(lastAlive - 60_000).toISOString(),
          new Date(lastAlive + HEARTBEAT_MS + 15_000).toISOString(),
        );
      } catch (error) {
        console.error('[lifecycle] Could not search agent transcripts:', error);
      }
    }
    logServerEvent('previous-run-ended-abruptly', {
      previousPid: previous.pid,
      startedAt: previous.startedAt,
      lastAliveAt: previous.lastAliveAt,
      agentKillCommands: suspects,
    });
    console.warn(
      `[lifecycle] The previous server (PID ${previous.pid}) ended without a clean shutdown; last alive at ${previous.lastAliveAt}. ` +
        `It was killed by another process or crashed natively.`,
    );
    for (const s of suspects) {
      console.warn(
        `[lifecycle]   ${s.at} task #${s.taskId ?? '?'} conversation #${s.conversationId ?? '?'} ran: ${s.command.slice(0, 200)}`,
      );
    }
    console.warn(`[lifecycle] Details: ${getServerLogPath()}`);
  }

  const startedAt = new Date().toISOString();
  const state: ServerState = { pid: process.pid, startedAt, lastAliveAt: startedAt, cleanExit: false };
  writeServerState(state);
  logServerEvent('start', {
    ppid: process.ppid,
    port: Number(port),
    node: process.version,
    platform: process.platform,
    argv: process.argv.slice(1),
  });

  const heartbeat = setInterval(() => {
    state.lastAliveAt = new Date().toISOString();
    writeServerState(state);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // Monitor only: the default crash behavior (print + exit 1) still applies.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logServerEvent('uncaught-exception', { origin, ...errorDetails(error) });
  });

  process.on('exit', (code) => {
    logServerEvent('exit', { code });
    writeServerState({ ...state, lastAliveAt: new Date().toISOString(), cleanExit: true, exitCode: code });
  });
}
