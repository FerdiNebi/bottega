import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  agentRunsWithCostIn,
  backfillConversationCosts,
  recordConversationCostIn,
  taskCostIn,
  tasksWithCostIn,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database;
let projectId: number;

function insert(sql: string, ...params: unknown[]): number {
  return Number(db.prepare(sql).run(...params).lastInsertRowid);
}

function addTask(title: string): number {
  return insert('INSERT INTO tasks (project_id, title) VALUES (?, ?)', projectId, title);
}

function addConversation(taskId: number, sessionId: string | null, cost: number | null = null): number {
  return insert(
    'INSERT INTO conversations (task_id, claude_conversation_id, cost_usd) VALUES (?, ?, ?)',
    taskId,
    sessionId,
    cost,
  );
}

let seq = 0;
function addEntry(sessionId: string, entry: Record<string, unknown>): void {
  seq += 1;
  db.prepare(
    `INSERT INTO messages (project_key, session_id, subpath, uuid, seq, mtime, entry_json)
     VALUES ('p', ?, '', ?, ?, 0, ?)`,
  ).run(sessionId, `u${seq}`, seq, JSON.stringify(entry));
}

function costOf(conversationId: number): number | null {
  return (db.prepare('SELECT cost_usd FROM conversations WHERE id = ?').get(conversationId) as {
    cost_usd: number | null;
  }).cost_usd;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8'));
  const userId = insert("INSERT INTO users (username, password_hash) VALUES ('u', 'h')");
  projectId = insert("INSERT INTO projects (user_id, name, repo_folder_path) VALUES (?, 'P', '/p')", userId);
});

describe('backfillConversationCosts', () => {
  it('sets each conversation to the highest cost-state total of its session', () => {
    const taskId = addTask('t');
    const a = addConversation(taskId, 'sess-a');
    const b = addConversation(taskId, 'sess-b');
    const none = addConversation(taskId, 'sess-none');
    addEntry('sess-a', { type: 'cost-state', totalCostUSD: 1.5 });
    addEntry('sess-a', { type: 'assistant', message: {} });
    addEntry('sess-a', { type: 'cost-state', totalCostUSD: 4.25 });
    addEntry('sess-b', { type: 'cost-state', totalCostUSD: 0.75 });
    addEntry('sess-none', { type: 'user', message: {} });

    expect(backfillConversationCosts(db)).toBe(2);

    expect(costOf(a)).toBe(4.25);
    expect(costOf(b)).toBe(0.75);
    expect(costOf(none)).toBeNull();
  });

  it('leaves conversations that already have a cost alone', () => {
    const c = addConversation(addTask('t'), 'sess', 9);
    addEntry('sess', { type: 'cost-state', totalCostUSD: 2 });

    backfillConversationCosts(db);

    expect(costOf(c)).toBe(9);
  });
});

describe('recordConversationCostIn', () => {
  it('stores the cumulative total and never lowers it', () => {
    const c = addConversation(addTask('t'), 'sess');

    expect(recordConversationCostIn(db, c, 1.2)).toBe(1.2);
    expect(recordConversationCostIn(db, c, 3.4)).toBe(3.4);
    // A crashed turn can report a lower (zeroed) total.
    expect(recordConversationCostIn(db, c, 0.1)).toBe(3.4);
    expect(costOf(c)).toBe(3.4);
  });

  it('returns null for an unknown conversation', () => {
    expect(recordConversationCostIn(db, 999, 1)).toBeNull();
  });
});

describe('task and run cost queries', () => {
  it('sums a task over all its conversations and leaves unknown costs null', () => {
    const costly = addTask('costly');
    const unknown = addTask('unknown');
    addConversation(costly, 's1', 1.25);
    addConversation(costly, 's2', 2.5);
    addConversation(costly, 's3', null);
    addConversation(unknown, 's4', null);

    expect(taskCostIn(db, costly)).toBe(3.75);
    expect(taskCostIn(db, unknown)).toBeNull();

    const byId = Object.fromEntries(tasksWithCostIn(db, projectId).map((t) => [t.id, t.cost_usd]));
    expect(byId[costly]).toBe(3.75);
    expect(byId[unknown]).toBeNull();
  });

  it("joins each agent run to its conversation's cost", () => {
    const taskId = addTask('t');
    const conv = addConversation(taskId, 's1', 2);
    const linked = insert(
      "INSERT INTO task_agent_runs (task_id, agent_type, status, conversation_id) VALUES (?, 'implementation', 'completed', ?)",
      taskId,
      conv,
    );
    const unlinked = insert(
      "INSERT INTO task_agent_runs (task_id, agent_type, status) VALUES (?, 'review', 'running')",
      taskId,
    );

    const runs = Object.fromEntries(agentRunsWithCostIn(db, taskId).map((r) => [r.id, r]));
    expect(runs[linked]!.cost_usd).toBe(2);
    expect(runs[linked]!.agent_type).toBe('implementation');
    expect(runs[unlinked]!.cost_usd).toBeNull();
  });
});
