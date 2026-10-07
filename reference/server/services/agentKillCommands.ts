// Process-stopping commands agents ran, read from stored transcripts. Used
// at startup to explain an abrupt server death (see serverLifecycleLog.ts).

import { db } from '../database/db.js';
import { KILL_VERB } from './processGuard.js';
import type { AgentKillCommand } from './serverLifecycleLog.js';

interface TranscriptRow {
  entry_json: string;
  conversation_id: number | null;
  task_id: number | null;
}

/**
 * Process-stopping shell commands agents ran between two ISO timestamps,
 * read from the stored transcripts. Used to explain an abrupt server death.
 */
export function findAgentKillCommands(fromIso: string, toIso: string, limit = 20): AgentKillCommand[] {
  const rows = db
    .prepare(
      `SELECT m.entry_json, c.id AS conversation_id, c.task_id
       FROM messages m
       LEFT JOIN conversations c ON c.claude_conversation_id = m.session_id
       WHERE json_extract(m.entry_json, '$.timestamp') BETWEEN ? AND ?
         AND m.entry_json LIKE '%"tool_use"%'
       ORDER BY json_extract(m.entry_json, '$.timestamp')`,
    )
    .all(fromIso, toIso) as TranscriptRow[];

  const found: AgentKillCommand[] = [];
  for (const row of rows) {
    let entry: { timestamp?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(row.entry_json) as typeof entry;
    } catch {
      continue;
    }
    const content = Array.isArray(entry.message?.content) ? (entry.message.content as unknown[]) : [];
    for (const block of content) {
      const b = block as { type?: string; input?: { command?: unknown } };
      const command = b.type === 'tool_use' ? b.input?.command : undefined;
      if (typeof command !== 'string' || !KILL_VERB.test(command)) continue;
      found.push({
        at: entry.timestamp ?? '',
        taskId: row.task_id,
        conversationId: row.conversation_id,
        command: command.slice(0, 500),
      });
      if (found.length >= limit) return found;
    }
  }
  return found;
}
