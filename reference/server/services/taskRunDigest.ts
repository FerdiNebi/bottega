// A short digest of how a task's agent runs went, read from the stored
// transcripts. The learnings agent (extra/learnings-agent.md) runs in a fresh
// session and never saw the earlier runs; this tells it what failed, what was
// slow and what review said, so it can record lessons in CLAUDE.md.

import { agentRunsDb, conversationsDb, db } from '../database/db.js';

export interface DigestRunInput {
  agentType: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  model: string | null;
  /** Main-thread transcript entries, oldest first. Empty when unavailable. */
  entries: unknown[];
}

const MAX_FAILURES = 20;
const MAX_BLOCKED = 5;
const MAX_SLOW = 8;
const SLOW_MS = 2 * 60_000;
const MAX_DIGEST_CHARS = 12_000;

interface ToolUse {
  name: string;
  command: string;
  /** The background task a TaskOutput call waits on. */
  taskId: string;
  at: number;
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
}

/** Hide anything that looks like a credential before it reaches a prompt. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(github_pat_|ghp_|gho_|ghs_|ghu_|sk-ant-|sk-|xox[bp]-)[A-Za-z0-9_-]{10,}/g, '<redacted>')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=("?)[^\s"']+\2/g, '$1=<redacted>');
}

function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return redactSecrets(text.replace(/\u001b\[[0-9;]*m/g, ''));
}

/** A shell command reduced to what identifies it: no leading `cd`, one line. */
function commandKey(command: string): string {
  return clean(command)
    .replace(/^\s*cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof (c as ContentBlock)?.text === 'string' ? (c as ContentBlock).text : '')).join('\n');
  }
  return '';
}

/** The first few meaningful lines of a failed command's output. */
function errorExcerpt(text: string): string {
  const lines = clean(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Exit code \d+$/.test(l));
  const important = lines.filter((l) => /error|fail|not found|cannot|denied|refused|missing|invalid/i.test(l));
  return (important.length ? important : lines).slice(0, 3).join(' | ').slice(0, 300);
}

/**
 * A review's verdict and the issues it sent back. Each review overwrites the
 * previous Review Findings in the task doc, so the findings it wrote (its own
 * edit of that section) are preferred over its closing message.
 */
function reviewVerdict(findingsWritten: string, closingMessage: string): string {
  const source = clean(findingsWritten || closingMessage).replace(/\s+/g, ' ');
  const status = source.match(/\b(NEEDS_WORK|READY|BLOCKED|IN_PROGRESS)\b/)?.[1] ?? 'no verdict found';
  const issues = source.search(/Issues to Address|Root cause|Issues Found|Remaining Items/i);
  return `${status}${issues >= 0 ? ` — ${source.slice(issues, issues + 500)}` : ''}`;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : t;
}

/** Render the digest for a task's runs (pure; see buildTaskRunDigest). */
export function buildRunDigest(runs: DigestRunInput[]): string {
  if (runs.length === 0) return 'No earlier agent runs were recorded for this task.';

  const runLines: string[] = [];
  const reviewSummaries: string[] = [];
  const failures = new Map<string, { count: number; agents: Set<string>; excerpt: string }>();
  const blocked = new Map<string, number>();
  const slow: { ms: number; label: string }[] = [];

  for (const run of runs) {
    const start = parseTime(run.createdAt);
    const end = parseTime(run.completedAt);
    const duration = start !== null && end !== null ? `, ${minutes(end - start)}` : '';
    runLines.push(`- ${run.agentType} (${run.status}${duration}${run.model ? `, ${run.model}` : ''})`);

    const uses = new Map<string, ToolUse>();
    const backgroundCommands = new Map<string, string>();
    let lastText = '';
    let findingsWritten = '';

    for (const entry of run.entries) {
      const e = entry as { timestamp?: string; message?: { role?: string; content?: unknown } };
      const at = e.timestamp ? Date.parse(e.timestamp) : NaN;
      const content = Array.isArray(e.message?.content) ? (e.message.content as ContentBlock[]) : [];
      for (const block of content) {
        if (block.type === 'text' && e.message?.role === 'assistant' && block.text?.trim()) {
          lastText = block.text;
        }
        if (block.type === 'tool_use' && block.id) {
          const input = block.input ?? {};
          const written = input.new_string ?? input.content;
          if (typeof written === 'string' && written.includes('## Review Findings')) findingsWritten = written;
          uses.set(block.id, {
            name: block.name ?? '',
            command: typeof input.command === 'string' ? input.command : '',
            taskId: typeof input.task_id === 'string' ? input.task_id : '',
            at,
          });
          continue;
        }
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const use = uses.get(block.tool_use_id);
        if (!use) continue;
        const text = resultText(block.content);
        const elapsed = at - use.at;

        if (use.name === 'Bash' || use.name === 'PowerShell') {
          const key = commandKey(use.command);
          const bgId = text.match(/running in background with ID: (\w+)/)?.[1];
          if (bgId) {
            backgroundCommands.set(bgId, key);
            continue;
          }
          if (/^<tool_use_error>.*Blocked/.test(text)) {
            blocked.set(key, (blocked.get(key) ?? 0) + 1);
            continue;
          }
          const exit = text.match(/^Exit code (\d+)/)?.[1];
          if (block.is_error || (exit !== undefined && exit !== '0')) {
            const f = failures.get(key) ?? { count: 0, agents: new Set<string>(), excerpt: errorExcerpt(text) };
            f.count++;
            f.agents.add(run.agentType);
            failures.set(key, f);
          }
          if (elapsed >= SLOW_MS) slow.push({ ms: elapsed, label: `${run.agentType}: ${key}` });
        } else if (use.name === 'TaskOutput' && elapsed >= SLOW_MS) {
          slow.push({
            ms: elapsed,
            label: `${run.agentType}: waiting on ${backgroundCommands.get(use.taskId) ?? 'a background command'}`,
          });
        }
      }
    }

    if (run.agentType === 'review' && (findingsWritten || lastText)) {
      reviewSummaries.push(`- ${reviewVerdict(findingsWritten, lastText)}`);
    }
    if (run.entries.length === 0) runLines[runLines.length - 1] += ' — transcript not available';
  }

  const sections = [`### Runs (oldest first)\n${runLines.join('\n')}`];
  if (reviewSummaries.length) sections.push(`### Review verdicts\n${reviewSummaries.join('\n')}`);
  if (failures.size) {
    const top = [...failures.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_FAILURES);
    sections.push(
      `### Failed commands (count, stage: command — first error lines)\n${top
        .map(([cmd, f]) => `- ${f.count}x, ${[...f.agents].join('/')}: \`${cmd}\` — ${f.excerpt || 'no output'}`)
        .join('\n')}`,
    );
  }
  if (blocked.size) {
    const top = [...blocked.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_BLOCKED);
    sections.push(`### Commands the harness blocked\n${top.map(([cmd, n]) => `- ${n}x: \`${cmd}\``).join('\n')}`);
  }
  if (slow.length) {
    const top = slow.sort((a, b) => b.ms - a.ms).slice(0, MAX_SLOW);
    sections.push(`### Slowest commands\n${top.map((s) => `- ${minutes(s.ms)} — ${s.label}`).join('\n')}`);
  }

  const digest = sections.join('\n\n');
  return digest.length > MAX_DIGEST_CHARS ? `${digest.slice(0, MAX_DIGEST_CHARS)}\n… (digest truncated)` : digest;
}

/** The digest for every earlier run of a task, excluding learnings runs. */
export function buildTaskRunDigest(taskId: number): string {
  const runs = agentRunsDb
    .getByTask(taskId)
    .filter((r) => r.agent_type !== 'learnings')
    .sort((a, b) => a.id - b.id);
  const loadEntries = db.prepare(
    "SELECT entry_json FROM messages WHERE session_id = ? AND subpath = '' ORDER BY seq",
  );

  return buildRunDigest(
    runs.map((run) => {
      const conversation = run.conversation_id ? conversationsDb.getById(run.conversation_id) : undefined;
      const sessionId = conversation?.claude_conversation_id ?? conversation?.provider_session_id ?? null;
      const entries: unknown[] = [];
      if (sessionId) {
        for (const row of loadEntries.all(sessionId) as { entry_json: string | Buffer }[]) {
          try {
            entries.push(JSON.parse(row.entry_json.toString()));
          } catch {
            // skip unreadable entries
          }
        }
      }
      return {
        agentType: run.agent_type,
        status: run.status,
        createdAt: run.created_at,
        completedAt: run.completed_at,
        model: conversation?.model ?? null,
        entries,
      };
    }),
  );
}
