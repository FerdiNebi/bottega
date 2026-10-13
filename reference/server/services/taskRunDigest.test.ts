import { describe, it, expect } from 'vitest';
import { buildRunDigest, redactSecrets, type DigestRunInput } from './taskRunDigest.js';

const t = (minute: number) => `2026-10-07T10:${String(minute).padStart(2, '0')}:00.000Z`;

function assistant(minute: number, blocks: unknown[]) {
  return { timestamp: t(minute), message: { role: 'assistant', content: blocks } };
}
function user(minute: number, blocks: unknown[]) {
  return { timestamp: t(minute), message: { role: 'user', content: blocks } };
}
function bash(id: string, command: string, extra: Record<string, unknown> = {}) {
  return { type: 'tool_use', id, name: 'Bash', input: { command, ...extra } };
}
function result(id: string, content: string, isError = false) {
  return { type: 'tool_result', tool_use_id: id, content, is_error: isError };
}

function run(overrides: Partial<DigestRunInput>): DigestRunInput {
  return {
    agentType: 'implementation',
    status: 'completed',
    createdAt: '2026-10-07 10:00:00',
    completedAt: '2026-10-07 10:30:00',
    model: 'opus',
    entries: [],
    ...overrides,
  };
}

describe('buildRunDigest', () => {
  it('lists every run with its status, duration and model', () => {
    const digest = buildRunDigest([run({}), run({ agentType: 'review', status: 'failed', completedAt: null })]);
    expect(digest).toContain('- implementation (completed, 30.0 min, opus) — transcript not available');
    expect(digest).toContain('- review (failed, opus)');
  });

  it('groups failed commands, dropping the leading cd, and keeps the error lines', () => {
    const entries = [
      assistant(0, [bash('a', 'cd D:/w/task-1 && pnpm --filter @app/db generate')]),
      user(1, [result('a', 'Exit code 1\n> prisma generate\nError: Could not find schema.prisma', true)]),
      assistant(2, [bash('b', 'cd D:/w/task-1 && pnpm --filter @app/db generate')]),
      user(3, [result('b', 'Exit code 1\nError: Could not find schema.prisma', true)]),
      assistant(4, [bash('c', 'pnpm test')]),
      user(5, [result('c', 'Tests 12 passed')]),
    ];
    const digest = buildRunDigest([run({ entries })]);
    expect(digest).toContain('- 2x, implementation: `pnpm --filter @app/db generate` — Error: Could not find schema.prisma');
    expect(digest).not.toContain('pnpm test`');
  });

  it("uses the findings a review wrote to the task doc for its verdict", () => {
    const entries = [
      assistant(0, [
        {
          type: 'tool_use',
          id: 'e',
          name: 'Edit',
          input: { new_string: '## Review Findings\n\n**Status:** NEEDS_WORK\n\n### Issues to Address\n- Import schemas from `@app/shared/schemas`' },
        },
      ]),
      user(1, [{ type: 'tool_result', tool_use_id: 'e', content: 'ok' }]),
      assistant(2, [{ type: 'text', text: 'Findings documented in the task doc.' }]),
    ];
    const digest = buildRunDigest([run({ agentType: 'review', entries })]);
    expect(digest).toContain('- NEEDS_WORK — Issues to Address - Import schemas from `@app/shared/schemas`');
  });

  it('reports blocked commands and slow waits on background commands', () => {
    const entries = [
      assistant(0, [bash('s', 'sleep 30 && gh pr checks')]),
      user(0, [result('s', '<tool_use_error>Blocked: sleep 30 followed by: gh pr checks</tool_use_error>', true)]),
      assistant(1, [bash('bg', 'pnpm test', { run_in_background: true })]),
      user(1, [result('bg', 'Command running in background with ID: b123. Output is being written to: x')]),
      assistant(1, [{ type: 'tool_use', id: 'w', name: 'TaskOutput', input: { task_id: 'b123', block: true } }]),
      user(9, [result('w', '<status>completed</status>')]),
    ];
    const digest = buildRunDigest([run({ agentType: 'review', entries })]);
    expect(digest).toContain('- 1x: `sleep 30 && gh pr checks`');
    expect(digest).toContain('- 8.0 min — review: waiting on pnpm test');
    expect(digest).not.toContain('Failed commands');
  });

  it('redacts credentials from commands and output', () => {
    const entries = [
      assistant(0, [bash('a', 'export GH_TOKEN="github_pat_11ABCDEFGHIJKLMNOPQRSTUV" && gh pr create')]),
      user(1, [result('a', 'Exit code 4\nbad token ghp_abcdefghijklmnopqrstuvwx', true)]),
    ];
    const digest = buildRunDigest([run({ entries })]);
    expect(digest).not.toMatch(/github_pat_|ghp_/);
    expect(digest).toContain('<redacted>');
  });

  it('says so when there were no earlier runs', () => {
    expect(buildRunDigest([])).toBe('No earlier agent runs were recorded for this task.');
  });
});

describe('redactSecrets', () => {
  it('hides token-like values and secret assignments', () => {
    expect(redactSecrets('sk-ant-api03-abcdefghijklmnop')).toBe('<redacted>');
    expect(redactSecrets('API_KEY=abc123 next')).toBe('API_KEY=<redacted> next');
    expect(redactSecrets('pnpm test')).toBe('pnpm test');
  });
});
