import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./serverLifecycleLog.js', () => ({ logServerEvent: vi.fn() }));

import path from 'path';
import { logServerEvent } from './serverLifecycleLog.js';
import {
  BOTTEGA_APP_DIR,
  editsBottegaFiles,
  findProtectedKill,
  getProtectedProcesses,
  protectBottegaHook,
  type ProtectedProcesses,
} from './processGuard.js';

const bottega: ProtectedProcesses = { ports: [3001, 5173], pids: [21920, 21448] };

describe('findProtectedKill', () => {
  // The commands an agent ran on 2026-10-07 while its app wanted port 3001.
  it.each([
    'lsof -ti:3001 | xargs kill -9 2>/dev/null; echo "stopped previous API attempt"',
    [
      '$owningPid = (Get-NetTCPConnection -LocalPort 3001 -State Listen).OwningProcess',
      'if ($owningPid) { Stop-Process -Id $owningPid -Force -ErrorAction SilentlyContinue }',
    ].join('\n'),
    'Stop-Process -Id 21920 -Force',
    'taskkill //PID 21920 //F',
    'npx kill-port 5173',
  ])('refuses a kill aimed at Bottega: %s', (command) => {
    expect(findProtectedKill(command, bottega)).toMatch(/port 3001|port 5173|PID 21920/);
  });

  it.each([
    'Get-Process node | Stop-Process -Force',
    'Stop-Process -Name node -Force',
    'taskkill /F /IM node.exe',
    'pkill -9 node',
    'killall node',
  ])('refuses killing node processes by name: %s', (command) => {
    expect(findProtectedKill(command, bottega)).toMatch(/every node\/tsx process/);
  });

  it.each([
    'kill $API_PID 2>/dev/null || true',
    'lsof -ti:3122 | xargs kill -9 2>/dev/null || true',
    'Stop-Process -Id 20508 -Force',
    'pkill -f "tsx watch src/server.ts"',
    'netstat -ano | grep :3001',
    'curl http://localhost:3001/healthz',
    'pnpm test --skill-level 3001',
  ])('allows commands that leave Bottega alone: %s', (command) => {
    expect(findProtectedKill(command, bottega)).toBeNull();
  });

  it('does not match a protected number inside a longer one', () => {
    expect(findProtectedKill('lsof -ti:13001 | xargs kill', bottega)).toBeNull();
    expect(findProtectedKill('kill 219200', bottega)).toBeNull();
  });
});

describe('getProtectedProcesses', () => {
  it('protects the configured ports and this process', () => {
    const p = getProtectedProcesses();
    expect(p.ports).toContain(Number(process.env.PORT || 7531));
    expect(p.ports).toContain(Number(process.env.VITE_PORT || 7530));
    expect(p.pids).toContain(process.pid);
  });
});

describe('protectBottegaHook', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies a Bash command that targets Bottega and logs it', async () => {
    const port = getProtectedProcesses().ports[0]!;
    const result = await protectBottegaHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `lsof -ti:${port} | xargs kill -9` },
      cwd: '/work/task-23',
    });

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/would stop Bottega[\s\S]*start it on a different port/),
      },
    });
    expect(logServerEvent).toHaveBeenCalledWith(
      'blocked-agent-command',
      expect.objectContaining({ tool: 'Bash', cwd: '/work/task-23' }),
    );
  });

  it('lets everything else through', async () => {
    expect(
      await protectBottegaHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } }),
    ).toEqual({});
    expect(await protectBottegaHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })).toEqual({});
    expect(logServerEvent).not.toHaveBeenCalled();
  });
});

describe('editsBottegaFiles', () => {
  const app = path.resolve('/opt/bottega/reference');

  it('refuses edits to Bottega files from an agent working elsewhere', () => {
    const cwd = path.resolve('/work/DentalBooking-worktrees/task-14');
    expect(editsBottegaFiles(path.join(app, 'scripts', 'complete-pr.ts'), cwd, app)).toBe(true);
    expect(editsBottegaFiles(path.join(app, 'server', '..', 'scripts', 'x.ts'), cwd, app)).toBe(true);
  });

  it('allows edits elsewhere, and inside Bottega when the agent works there', () => {
    const cwd = path.resolve('/work/DentalBooking-worktrees/task-14');
    expect(editsBottegaFiles(path.join(cwd, 'src', 'app.ts'), cwd, app)).toBe(false);
    expect(editsBottegaFiles('src/app.ts', cwd, app)).toBe(false);
    expect(editsBottegaFiles(path.resolve('/opt/bottega/reference-worktrees/task-3/x.ts'), cwd, app)).toBe(false);
    expect(editsBottegaFiles(path.join(app, 'scripts', 'x.ts'), app, app)).toBe(false);
  });
});

describe('protectBottegaHook on file edits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies writing a Bottega file from another project and logs it', async () => {
    const result = await protectBottegaHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(BOTTEGA_APP_DIR, 'scripts', 'complete-pr.ts'), content: 'x' },
      cwd: path.resolve('/work/DentalBooking-worktrees/task-14'),
    });

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/is part of Bottega[\s\S]*Never change Bottega's files/),
      },
    });
    expect(logServerEvent).toHaveBeenCalledWith('blocked-agent-edit', expect.objectContaining({ tool: 'Write' }));
  });

  it("allows edits to the project's own files", async () => {
    const cwd = path.resolve('/work/DentalBooking-worktrees/task-14');
    expect(
      await protectBottegaHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(cwd, 'src', 'server.ts') },
        cwd,
      }),
    ).toEqual({});
  });
});
