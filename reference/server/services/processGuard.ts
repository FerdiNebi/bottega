// Keeps agents from killing Bottega itself, editing its files, or printing
// credentials into their transcript.
//
// Agents share the machine with the Bottega server. When an app under
// development wants the same port (3001 is a common default), an agent that
// hits EADDRINUSE tends to "free the port" — which force-kills Bottega and
// every agent run with it. A forced kill (Stop-Process, taskkill /F,
// kill -9) leaves no log behind, so the guard has to stop the command before
// it runs: a PreToolUse hook for the Claude harness, plus a warning in every
// task's context prompt for all harnesses.

import path from 'path';
import { fileURLToPath } from 'url';
import { logServerEvent } from './serverLifecycleLog.js';

export interface ProtectedProcesses {
  /** Bottega's API port and the Vite dev-server port. */
  ports: number[];
  /** The server process and its parent (pnpm / concurrently). */
  pids: number[];
}

export function getProtectedProcesses(): ProtectedProcesses {
  const ports = [Number(process.env.PORT || 7531), Number(process.env.VITE_PORT || 7530)];
  const pids = [process.pid, process.ppid];
  return {
    ports: [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0))],
    pids: [...new Set(pids.filter((p) => Number.isInteger(p) && p > 1))],
  };
}

// Anything that stops a process. `kill` also covers `xargs kill -9`.
export const KILL_VERB = /\b(?:stop-process|spps|taskkill|kill|pkill|killall|kill-port|fuser)\b|\.kill\s*\(/i;

// Killing processes by name: every node / tsx process includes Bottega.
const KILL_BY_NAME = new RegExp(
  [
    String.raw`stop-process\b[^|;\n]*-name\s+['"]?(?:node|tsx)\b`,
    String.raw`get-process\s+(?:-name\s+)?['"]?(?:node|tsx)\b[^\n]*\|\s*(?:stop-process|spps)\b`,
    String.raw`taskkill\b[^|;\n]*[/-]im\s+['"]?(?:node|tsx)(?:\.exe)?\b`,
    // The name must be the whole argument: `pkill -f "tsx watch app.ts"` is fine.
    String.raw`\b(?:pkill|killall)(?:\s+-\S+)*\s+(?:"(?:node|node\.exe|tsx)"|'(?:node|node\.exe|tsx)'|(?:node|node\.exe|tsx))(?=\s|$|[|;&])`,
  ].join('|'),
  'i',
);

function mentionsNumber(command: string, n: number): boolean {
  return new RegExp(String.raw`(?<!\d)${n}(?!\d)`).test(command);
}

/**
 * Why `command` would stop Bottega, or null when it looks safe. Deliberately
 * coarse: a kill command that mentions a protected port or PID anywhere is
 * refused, since the agent can always pick another port for its own app.
 */
export function findProtectedKill(
  command: string,
  protectedProcesses: ProtectedProcesses = getProtectedProcesses(),
): string | null {
  if (!KILL_VERB.test(command)) return null;
  if (KILL_BY_NAME.test(command)) {
    return 'it stops every node/tsx process by name, and Bottega is one of them';
  }
  for (const port of protectedProcesses.ports) {
    if (mentionsNumber(command, port)) {
      return `it targets port ${port}, which belongs to Bottega`;
    }
  }
  for (const pid of protectedProcesses.pids) {
    if (mentionsNumber(command, pid)) {
      return `it targets PID ${pid}, which is Bottega`;
    }
  }
  return null;
}

export function protectedKillDenyMessage(reason: string): string {
  const { ports } = getProtectedProcesses();
  return (
    `Blocked: this command would stop Bottega, the app running you — ${reason}. ` +
    `Never stop processes you didn't start, and never touch ports ${ports.join(' / ')}. ` +
    `If the app you're working on wants one of those ports, start it on a different port ` +
    `(for example PORT=<your dev server port>) instead of freeing it.`
  );
}

// Credentials agents could print into their transcript. Agents run as the
// same OS user as the person who installed Bottega, so they can read that
// user's GitHub login and the per-user harness tokens; one PR agent ran
// `git credential fill` and pasted the PAT into curl. They never need the raw
// values — `gh` and `git` authenticate themselves.
const TOKEN_VAR = String.raw`(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|\w*_API_KEY|\w*_OAUTH_TOKEN|\w*_AUTH_TOKEN|\w*_ACCESS_TOKEN)\b`;
const EXE_END = String.raw`(?:\.exe)?['"]?`;
const GIT_CREDENTIALS_FILE = /\.git-credentials\b/i;
const BOTTEGA_CREDENTIAL_FILES = /bottega[\\/]+users\b|\boauth_token\b/i;

const CREDENTIAL_READS: Array<[RegExp, string]> = [
  [new RegExp(String.raw`\bgh${EXE_END}\s+auth\s+token\b`, 'i'), '`gh auth token` prints your GitHub token'],
  [
    new RegExp(String.raw`\bgh${EXE_END}\s+auth\s+status\b[^|;\n]*(?:\s-t\b|--show-token)`, 'i'),
    '`gh auth status --show-token` prints your GitHub token',
  ],
  [
    new RegExp(
      String.raw`\bgit${EXE_END}\s[^|;\n]*\bcredential(?:-[\w-]+)?\s+(?:fill|get)\b|\bgit-credential-[\w-]+${EXE_END}\s+get\b`,
      'i',
    ),
    'it asks git for your stored password/token',
  ],
  [GIT_CREDENTIALS_FILE, '~/.git-credentials holds your Git password/token in plain text'],
  [BOTTEGA_CREDENTIAL_FILES, "it reads Bottega's per-user credential files"],
  [
    new RegExp(
      String.raw`(?:\$\{?|\$env:|%)${TOKEN_VAR}|\bprintenv\s+${TOKEN_VAR}|GetEnvironmentVariable\s*\(\s*['"]${TOKEN_VAR}`,
      'i',
    ),
    'it prints a token environment variable',
  ],
  [
    new RegExp(
      [
        String.raw`(?:^|[|;&(]\s*)(?:env|printenv|set|export\s+-p|declare\s+-x)\s*(?=$|[|;&>)])`,
        String.raw`/c\s+set\s*(?=$|[|;&>"')])`,
        String.raw`\b(?:get-childitem|gci|dir|ls|get-item|gi)\s+(?:-path\s+)?env:(?:\*|\\)?(?=\s|$|[|;)])`,
        String.raw`GetEnvironmentVariables\s*\(`,
        String.raw`/proc/\S*environ\b`,
      ].join('|'),
      'im',
    ),
    'it dumps the whole environment, tokens included',
  ],
];

/** Why `command` would print a credential, or null when it looks safe. */
export function findCredentialRead(command: string): string | null {
  for (const [pattern, reason] of CREDENTIAL_READS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

export function credentialReadDenyMessage(reason: string): string {
  return (
    `Blocked: this command would print a credential into the conversation — ${reason}. ` +
    `You never need raw tokens: \`gh\` and \`git\` are already logged in, so run them directly. ` +
    `If they fail to authenticate, say so in your reply and stop instead of looking for credentials.`
  );
}

interface PreToolUseInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
}

/** Bottega's own install folder (the reference app root). */
export const BOTTEGA_APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Whether a file-editing tool call would change Bottega's own code. Allowed
 * when the agent itself works inside Bottega (someone developing Bottega with
 * Bottega); refused otherwise — an agent working on another project once
 * "fixed" Bottega's scripts mid-task.
 */
export function editsBottegaFiles(filePath: string, cwd: string | undefined, appDir = BOTTEGA_APP_DIR): boolean {
  const base = cwd && path.isAbsolute(cwd) ? cwd : appDir;
  const target = path.resolve(base, filePath);
  if (!insidePath(appDir, target)) return false;
  return !(cwd && insidePath(appDir, path.resolve(cwd)));
}

function insidePath(dir: string, target: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(norm(dir), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function deny(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Claude Agent SDK PreToolUse hook (matcher `PROTECT_BOTTEGA_MATCHER`). Hooks
 * run in every permission mode, including bypassPermissions, and inside
 * sub-agents.
 */
export function protectBottegaHook(input: PreToolUseInput): Promise<Record<string, unknown>> {
  if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
  const toolInput = (input.tool_input ?? {}) as { command?: unknown; file_path?: unknown; notebook_path?: unknown };

  if (input.tool_name === 'Read') {
    const filePath = toolInput.file_path;
    if (typeof filePath !== 'string') return Promise.resolve({});
    const credentialReason = GIT_CREDENTIALS_FILE.test(filePath)
      ? '~/.git-credentials holds your Git password/token in plain text'
      : BOTTEGA_CREDENTIAL_FILES.test(filePath)
        ? "it is one of Bottega's per-user credential files"
        : null;
    if (!credentialReason) return Promise.resolve({});
    logServerEvent('blocked-agent-credential-read', { tool: 'Read', cwd: input.cwd, reason: credentialReason, filePath });
    return Promise.resolve(deny(credentialReadDenyMessage(credentialReason)));
  }

  if (input.tool_name && EDIT_TOOLS.has(input.tool_name)) {
    const filePath = toolInput.file_path ?? toolInput.notebook_path;
    if (typeof filePath !== 'string' || !editsBottegaFiles(filePath, input.cwd)) return Promise.resolve({});
    logServerEvent('blocked-agent-edit', { tool: input.tool_name, cwd: input.cwd, filePath });
    return Promise.resolve(
      deny(
        `Blocked: ${filePath} is part of Bottega, the app running you, not the project you are working on. ` +
          `Never change Bottega's files. If Bottega itself needs a change, say so in your reply instead.`,
      ),
    );
  }

  const command = toolInput.command;
  if (typeof command !== 'string') return Promise.resolve({});

  const credentialReason = findCredentialRead(command);
  if (credentialReason) {
    logServerEvent('blocked-agent-credential-read', {
      tool: input.tool_name,
      cwd: input.cwd,
      reason: credentialReason,
      command: command.slice(0, 500),
    });
    return Promise.resolve(deny(credentialReadDenyMessage(credentialReason)));
  }

  const reason = findProtectedKill(command);
  if (!reason) return Promise.resolve({});

  logServerEvent('blocked-agent-command', {
    tool: input.tool_name,
    cwd: input.cwd,
    reason,
    command: command.slice(0, 500),
  });
  return Promise.resolve(deny(protectedKillDenyMessage(reason)));
}

export const PROTECT_BOTTEGA_MATCHER = 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Read';

