import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A real SQLite file: the lease rules live in SQL (one write transaction), so
// mocking the DB would test nothing. Set before db.ts is first imported.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-test-slots-'));
process.env.DATABASE_PATH = path.join(dbDir, 'test.db');

const { initializeDatabase, db, userDb, projectsDb, tasksDb, agentRunsDb, testSlotsDb } = await import(
  '../database/db.js'
);
const { acquireTestSlot, releaseTestSlot, LEASE_STALE_MS } = await import('./testSlots.js');

let projectId: number;
let otherProjectId: number;

function newTask(project = projectId, running = true): number {
  const task = tasksDb.create(project, 'T');
  if (running) {
    const run = agentRunsDb.create(task.id, 'review');
    agentRunsDb.updateStatus(run.id, 'running');
  }
  return task.id;
}

// No waiting in tests: a fake clock that sleep() advances.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

beforeAll(async () => {
  await initializeDatabase();
});

beforeEach(() => {
  db.exec('DELETE FROM test_slot_leases; DELETE FROM task_agent_runs; DELETE FROM tasks; DELETE FROM project_members; DELETE FROM projects; DELETE FROM users;');
  const user = userDb.createUser(`u${Date.now()}${Math.random()}`, 'x');
  projectId = projectsDb.create(user.id, 'P', path.join(dbDir, `p${Math.random()}`)).id;
  otherProjectId = projectsDb.create(user.id, 'Q', path.join(dbDir, `q${Math.random()}`)).id;
});

describe('test slots', () => {
  it('defaults to two slots per project', () => {
    expect(projectsDb.getByIdAdmin(projectId)?.test_slots).toBe(2);
  });

  it('gives out the project slots, then reports the holders when full', async () => {
    const [a, b, c] = [newTask(), newTask(), newTask()];
    const clock = fakeClock();
    expect((await acquireTestSlot(a, clock)).status).toBe('acquired');
    expect((await acquireTestSlot(b, clock)).status).toBe('acquired');

    const busy = await acquireTestSlot(c, { ...clock, maxWaitMs: 20_000, pollMs: 5_000 });
    expect(busy).toMatchObject({ status: 'busy', holders: [a, b] });
  });

  it('counts slots per project', async () => {
    projectsDb.update(projectId, projectsDb.getByIdAdmin(projectId)!.user_id, { test_slots: 1 });
    const a = newTask();
    const other = newTask(otherProjectId);
    expect((await acquireTestSlot(a, fakeClock())).status).toBe('acquired');
    expect((await acquireTestSlot(other, fakeClock())).status).toBe('acquired');
  });

  it('renews the lease when the holder acquires again', async () => {
    const a = newTask();
    expect(await acquireTestSlot(a, fakeClock())).toMatchObject({ status: 'acquired', renewed: false });
    expect(await acquireTestSlot(a, fakeClock(2_000_000))).toMatchObject({ status: 'acquired', renewed: true });
    const row = db.prepare('SELECT acquired_at FROM test_slot_leases WHERE task_id = ?').get(a) as {
      acquired_at: number;
    };
    expect(row.acquired_at).toBe(2_000_000);
  });

  it('waits until a holder releases', async () => {
    projectsDb.update(projectId, projectsDb.getByIdAdmin(projectId)!.user_id, { test_slots: 1 });
    const [a, b] = [newTask(), newTask()];
    const clock = fakeClock();
    await acquireTestSlot(a, clock);

    let polls = 0;
    const outcome = await acquireTestSlot(b, {
      ...clock,
      sleep: async (ms) => {
        polls++;
        await clock.sleep(ms);
        if (polls === 2) releaseTestSlot(a);
      },
    });
    expect(outcome).toMatchObject({ status: 'acquired', renewed: false });
    expect(outcome.waitedMs).toBeGreaterThan(0);
  });

  it('drops leases older than the stale limit', async () => {
    projectsDb.update(projectId, projectsDb.getByIdAdmin(projectId)!.user_id, { test_slots: 1 });
    const [a, b] = [newTask(), newTask()];
    await acquireTestSlot(a, fakeClock(1_000));
    const outcome = await acquireTestSlot(b, fakeClock(1_000 + LEASE_STALE_MS + 1));
    expect(outcome.status).toBe('acquired');
  });

  it('drops leases of tasks with no running agent run', async () => {
    projectsDb.update(projectId, projectsDb.getByIdAdmin(projectId)!.user_id, { test_slots: 1 });
    const a = newTask();
    await acquireTestSlot(a, fakeClock());
    for (const run of agentRunsDb.getByTask(a)) agentRunsDb.updateStatus(run.id, 'completed');

    const b = newTask();
    expect((await acquireTestSlot(b, fakeClock())).status).toBe('acquired');
  });

  it('release reports whether the task held a slot', async () => {
    const a = newTask();
    expect(releaseTestSlot(a)).toBe(false);
    await acquireTestSlot(a, fakeClock());
    expect(releaseTestSlot(a)).toBe(true);
  });

  it('releaseAll clears every lease', async () => {
    await acquireTestSlot(newTask(), fakeClock());
    await acquireTestSlot(newTask(otherProjectId), fakeClock());
    expect(testSlotsDb.releaseAll()).toBe(2);
  });

  it('fails for an unknown task', async () => {
    await expect(acquireTestSlot(999_999, fakeClock())).rejects.toThrow('Task 999999 not found');
  });
});
