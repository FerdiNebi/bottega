# Extra — Parallel runs

## What it adds

> I start four tasks of the same project at once and walk away. When my Claude
> subscription runs out halfway, the agents wait and pick up again when the limit
> resets, instead of burning through the iteration cap. Their test suites don't
> fight over the same database, ports or CPU, so a red test means a real failure.

Three mechanisms, each useful alone:

1. [Usage-limit pause](#1-usage-limit-pause): a run that ends because the
   provider's usage limit was hit doesn't count as a finished turn. The task
   waits for the reset and then runs the same agent again.
2. [Test slots](#2-test-slots): at most N tasks of a project run heavy test
   suites at the same time. The rest wait their turn.
3. [Per-task test resources](#3-per-task-test-resources): every agent process
   gets its task's own port range and a name to build its test databases from,
   both as environment variables and in the prompt.

## Why it's an extra

Core runs one task at a time just fine, and its loop treats every ended turn the
same way: the next agent reads the transcript and decides. That stops working
once several tasks share one machine and one subscription. This is what a
single-user setup needs to run tasks side by side, not a rule every
implementation has to follow.

## 1. Usage-limit pause

### Detection

A harness reports that a turn ended on a **usage limit** rather than finishing.
For Claude (Agent SDK), that means:

- an `assistant` message with `error: 'rate_limit'` (the SDK's synthetic
  "You've hit your session limit · resets …" reply), and
- optionally, the reset time: the latest `rate_limit_event` with
  `rate_limit_info.status === 'rejected'` carries `resetsAt` (epoch seconds).

Other harnesses don't report usage limits yet. Their runs behave as before.

### What happens to the run

When an agent run's turn ends on a usage limit:

- The run is marked `failed`, so nothing chains from it.
- It doesn't count toward the iteration cap: the task's `workflow_run_count`
  goes back down by one.
- The task records the pause: `tasks.usage_limit_resume_at` (when to resume) and
  `tasks.usage_limit_agent_type` (which agent to run again).
- The resume time is the reset time plus 2 minutes. When the harness gave no
  reset time, it is 30 minutes from now.
- Under [autopilot](./autopilot.md), the board message says
  `Paused: <task> hit the usage limit; resumes at <time>.`

A manual chat that hits the limit gets no pause, since no loop is running in it.

### Resuming

At the resume time Bottega clears the pause and starts a **fresh run** of the
recorded agent type. That run reads the task doc and the worktree as any run
would, so it continues from the last commit and the unchecked To-Do items. If
the limit is still in force, the new run hits it at once and pauses again; that
costs nothing against the cap.

The resume is skipped (and the pause just cleared) when, by then, the task is
completed, blocked, or already has a running agent.

Pauses survive a server restart: at startup Bottega schedules every recorded
pause again, and one that is already due resumes a few seconds after boot.

Starting any agent run on the task by hand cancels its pause.

### UI

The task's agent panel shows `Paused: usage limit, resumes at <time>` while a
pause is recorded.

## 2. Test slots

A **test slot** is a lease that lets one task of a project run heavy test
suites (the full suite, end-to-end/browser suites, a production build plus
E2E). Each project has `projects.test_slots` slots (default 2, minimum 1), set
under **Edit Project → Parallel runs**.

Leases live in the `test_slot_leases` table (one row per task holding a slot:
`project_id`, `task_id`, `acquired_at`). The owner is the task, not a process,
so a lease can cover several commands.

Agents use one script:

```bash
{{tsx}} {{scriptsDir}}/test-slot.ts acquire <taskId>
{{tsx}} {{scriptsDir}}/test-slot.ts release <taskId>
```

- **acquire** takes a free slot and exits 0. If the task already holds one, it
  renews it. If all slots are held, it waits, checking every 5 seconds, for up to
  9 minutes (so it fits in one 10-minute Bash call). It then exits 3 and prints
  which tasks hold the slots; the agent runs it again.
- **release** frees the task's slot. Releasing without a lease is a no-op.

Before checking for a free slot, `acquire` drops stale leases: those older than
45 minutes, and those of tasks with no running agent run. When an agent run
ends (normally, stopped or failed), Bottega releases the task's lease, and at
startup it clears all leases.

Unit tests, typechecks, lint and single test files need no slot.

## 3. Per-task test resources

Every agent process of a task gets these environment variables (Claude and Codex
harnesses; OpenCode shares one server per user, so it gets only the prompt):

| Variable | Value |
|---|---|
| `BOTTEGA_TASK_ID` | the task id |
| `BOTTEGA_PROJECT_ID` | the project id |
| `BOTTEGA_PORT_BASE` | first port of the task's range: `20000 + (taskId mod 1200) × 10` |
| `BOTTEGA_PORT_COUNT` | `10` |

The range stays below the OS ephemeral port ranges (Linux 32768+, Windows
49152+). Two tasks get the same range only if their ids differ by a multiple of
1200.

Projects can build their test setup on these variables, for example a test
database named `myapp_test_task${BOTTEGA_TASK_ID}` and the E2E server on
`BOTTEGA_PORT_BASE`. Run outside Bottega, the variables are absent and the
project's defaults apply.

## The parallel-runs addendum

Every agent run except planification and learnings gets the
`parallel-runs` prompt (overridable like any other, see
[`prompt-and-model-customization.md`](./prompt-and-model-customization.md))
appended to its message. It gives the agent:

- the task's port range and test-resource name, and tells it to use them for
  every server, database or other shared resource its tests create, whatever
  the project's own defaults are;
- the `test-slot.ts` commands and when to use them: acquire before a heavy
  suite, release right after the last one of the turn.

Variables: `taskId`, `portBase`, `portEnd`, `testSlots`, plus the global
`scriptsDir` and `tsx`.
