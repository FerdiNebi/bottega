import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getServerLogPath,
  logServerEvent,
  readServerState,
  startServerLifecycleLog,
} from './serverLifecycleLog.js';

let root: string;
let handlers: Record<string, ((...args: unknown[]) => void)[]>;

function readLog(): Array<Record<string, unknown>> {
  return fs
    .readFileSync(getServerLogPath(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-lifecycle-'));
  vi.stubEnv('BOTTEGA_ARCHIVE_ROOT', root);
  handlers = {};
  // Capture instead of installing real process handlers.
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: (...args: unknown[]) => void) => {
    (handlers[event] ??= []).push(fn);
    return process;
  }) as typeof process.on);
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('serverLifecycleLog', () => {
  it('records the start, keeps a heartbeat, and marks a clean exit', () => {
    startServerLifecycleLog({ port: 3001 });

    const start = readLog().find((e) => e.event === 'start')!;
    expect(start).toMatchObject({ pid: process.pid, port: 3001 });
    const first = readServerState()!;
    expect(first).toMatchObject({ pid: process.pid, cleanExit: false });

    vi.advanceTimersByTime(16_000);
    expect(Date.parse(readServerState()!.lastAliveAt)).toBeGreaterThan(Date.parse(first.lastAliveAt));

    handlers.exit![0]!(0);
    expect(readServerState()).toMatchObject({ cleanExit: true, exitCode: 0 });
    expect(readLog().at(-1)).toMatchObject({ event: 'exit', code: 0 });
  });

  it('reports a previous run that died without a clean exit, with agent kill commands from then', () => {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'logs', 'server-state.json'),
      JSON.stringify({ pid: 21920, startedAt: '2026-10-07T07:00:00.000Z', lastAliveAt: '2026-10-07T07:56:50.000Z', cleanExit: false }),
    );
    const suspect = { at: '2026-10-07T07:56:53.923Z', taskId: 23, conversationId: 99, command: 'Stop-Process -Id 21920 -Force' };
    const findKillCommands = vi.fn(() => [suspect]);

    startServerLifecycleLog({ port: 3001, findKillCommands });

    expect(findKillCommands).toHaveBeenCalledWith('2026-10-07T07:55:50.000Z', '2026-10-07T07:57:20.000Z');
    expect(readLog()[0]).toMatchObject({
      event: 'previous-run-ended-abruptly',
      previousPid: 21920,
      lastAliveAt: '2026-10-07T07:56:50.000Z',
      agentKillCommands: [suspect],
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/task #23 conversation #99 ran: Stop-Process -Id 21920/));
  });

  it('stays quiet after a clean exit', () => {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'logs', 'server-state.json'),
      JSON.stringify({ pid: 1, startedAt: 'x', lastAliveAt: 'x', cleanExit: true, exitCode: 0 }),
    );
    const findKillCommands = vi.fn(() => []);

    startServerLifecycleLog({ port: 3001, findKillCommands });

    expect(findKillCommands).not.toHaveBeenCalled();
    expect(readLog().map((e) => e.event)).toEqual(['start']);
  });

  it('logs uncaught exceptions with their stack', () => {
    startServerLifecycleLog({ port: 3001 });

    handlers.uncaughtExceptionMonitor![0]!(new Error('boom'), 'uncaughtException');

    expect(readLog().at(-1)).toMatchObject({
      event: 'uncaught-exception',
      origin: 'uncaughtException',
      message: 'boom',
      stack: expect.stringContaining('boom'),
    });
  });

  it('logServerEvent never throws', () => {
    vi.stubEnv('BOTTEGA_ARCHIVE_ROOT', path.join(root, 'file-not-dir'));
    fs.writeFileSync(path.join(root, 'file-not-dir'), 'x');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logServerEvent('x')).not.toThrow();
  });
});
