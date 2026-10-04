# Extra — Autopilot

## What it adds

> I've written a PRD and an ARD and created the initial tasks. I tick
> **Autopilot** on the board and press **Start**. Bottega picks the first task
> whose dependencies are done, takes it through planning, implementation,
> review and the PR, merges it when the tests pass, and moves on to the next
> task. Nobody asks me anything. It stops only when a task can't make it
> through on its own, and tells me which one and why.

It is the fast path from a freshly bootstrapped project
([`project-bootstrap.md`](./project-bootstrap.md)) to a working MVP. It works
the same way on any project's pending tasks, whatever created them.

## Why it's an extra

Core stops at two human gates on purpose: after planning (a person reads the
plan) and after the PR (a person merges). Autopilot removes both and lets the
agents' own answers stand in for the questions they would have asked. That is a
deliberate trade of oversight for speed that some teams want and others won't.

## The switch

Autopilot is a per-project setting, `projects.autopilot_enabled` (0/1, default
0), shown as an **Autopilot** checkbox in the board header next to the project
docs buttons. It is hidden for projects that aren't git repositories.

- Toggle: `PUT /api/projects/:id/autopilot` with `{ enabled: boolean }`.
- Start: `POST /api/projects/:id/autopilot/start` (only while enabled).
- Status: `GET /api/projects/:id/autopilot` (see [Status](#status)).

The flag is read **at every decision point**, not once at Start. So:

- **Ticking it** changes nothing until something runs. Press **Start**, or press
  Run on any task: every run of every task in the project now follows the
  autopilot rules below.
- **Unticking it** mid-run lets the current agent finish its turn, after which
  the normal pipeline rules apply again (plan gate, no auto-merge, no next
  task). It is the "stop after this step" switch.

## Choosing the next task

A task is a **candidate** when it is

- `pending`; or
- `in_progress`, has at least one agent run, is not `workflow_blocked`, and has
  no running agent. This lets Start pick up a task that was interrupted (a Stop,
  a server restart). The project-bootstrap sessions are `in_progress` tasks with
  conversations but no agent runs, so they are never picked.

A candidate is **ready** when every task it depends on is `completed`.
Dependencies are the `(task #N)` references in the task doc's `## Depends on`
section, the format `create-tasks.ts` writes
([`project-bootstrap.md`](./project-bootstrap.md)). A doc without the section,
or with `- None`, has no dependencies. A reference to a task that no longer
exists counts as resolved: a deleted dependency can never complete and must not
block the rest forever. Dependencies are only checked for `pending` tasks; an
`in_progress` task already started, and its planning agent may have rewritten
the doc.

Among ready candidates the order is:

1. `in_progress` before `pending` (finish what was started);
2. the dependency level from the title prefix `N. `, lowest first; titles
   without a prefix come after all prefixed ones;
3. task id, lowest first.

Autopilot runs **one task at a time per project**. Each task starts from the
code the previous one merged, so tasks never race each other into merge
conflicts. Start returns 409 when any task in the project has a running agent.

## Starting a task

1. **Bring a `pending` task's worktree up to date.** The bootstrap creates every
   task's worktree up front, from the default branch as it was then, so a
   level-2 task would otherwise not see the code of the level-1 tasks it depends
   on. Merge the default branch into the task branch: `origin/<default>` after
   a `git fetch` when there is an `origin` remote (a failed fetch falls back to
   the local branch), else the local `<default>`. A task with no worktree gets
   one from that same base. A failed merge is aborted and stops autopilot.
   `in_progress` tasks are left alone; the PR agent and the final merge deal
   with drift.
2. **Pick the agent from the task's flags**, the same way the loop would have
   continued:

   | Task state | Next |
   |---|---|
   | `yolo_mode` and not `pr_agent_complete` | `yolo` |
   | `pr_agent_complete` | go straight to [Finishing a task](#finishing-a-task) |
   | `workflow_complete` | the finish pipeline (refinement → PR, see below) |
   | `planification_complete` | `implementation` |
   | otherwise | `planification` |

3. Start it through the normal `startAgentRun` entry point, as the user who
   pressed Start (or, when chaining, the user carried on the run's context).

## What changes inside a run

Every agent run of a task whose project has autopilot enabled gets:

- **No questions.** The ask-the-user tool (`AskUserQuestion`) is disallowed for
  the run, and an autopilot section is appended to the agent's message: nobody
  is watching; wherever the prompt says to ask, confirm or wait for the user,
  pick the option it would recommend and carry on; record each such choice in
  the task doc under `## Autopilot decisions` (question, choice, one-line why)
  so a human can audit it later. Harnesses without a disallow list still get the
  instruction, and the ask-the-user handler denies the call for conversations
  that belong to an agent run of an autopilot project, with the same instruction
  as its message. Manual chats, including the PRD/ARD interviews, are not agent
  runs and keep asking.
- **A stricter READY.** The review agent is told that its READY will be merged
  without a human looking: signal READY only when the project's full test suite
  passes, not just the tests it added.

The prompt text lives in
[`reference/server/constants/prompts/autopilot.md`](../reference/server/constants/prompts/autopilot.md).

## Chaining under autopilot

The completion handler ([`core/orchestration-loop.md`](../core/orchestration-loop.md))
keeps every core rule and adds these, all only while the project's autopilot is
enabled:

- **After planning:** if `planification_complete` is set, chain to
  implementation (the plan gate is skipped, as for non-technical users in
  [`auth-and-multi-user.md`](./auth-and-multi-user.md)). If the planner ended
  without completing the plan, stop.
- **Finish pipeline:** refinement runs as usual. Then, if the project has no
  `origin` remote, there is nowhere to open a PR: skip the PR agent and go to
  [Finishing a task](#finishing-a-task). Otherwise start the PR agent as usual.
- **After the PR agent or a `yolo` run** (both terminal in core): go to
  [Finishing a task](#finishing-a-task).
- **Blocked** (review ran `block-workflow`, or the iteration cap was hit):
  stop.

## Finishing a task

This replaces the human's merge click. It needs `pr_agent_complete` when the
task went through the PR agent or `yolo` (the agent's "the PR is green and
mergeable"), or `workflow_complete` when the PR agent was skipped for lack of a
remote. Then:

- **An open PR exists:** read its status (`getPullRequestStatus`). Merge it with
  `mergeAndCleanup` only when CI is `passed` (or `none`: the repository has no
  CI, and the review agent's full-suite run is the test gate) **and** it is
  `MERGEABLE`. Anything else (CI `failed`, `pending` or `unknown`, a conflict,
  mergeability still unknown) stops autopilot with the reason.
- **The PR is already merged** (someone merged it by hand): just remove the
  worktree.
- **No PR** (no remote, or the PR agent found nothing to submit): merge locally
  with `mergeLocally`, the "Merge without PR" path from
  [`core/task-and-workspace.md`](../core/task-and-workspace.md). It pushes the
  default branch when there is a remote. A failed merge stops autopilot; a
  failed push does not (the merge stands; the message says so).

On success: mark the task `completed`, switch the web server back to main if
this task's worktree was the active one, then choose and start the next ready
task after the usual ~1s settle delay.

A per-project in-memory lock makes finishing and starting single-flight: two
completion handlers racing for the same project cannot start two tasks.

## Stopping

Autopilot never deletes or reverts anything when it stops. It records why in
`projects.autopilot_message` and shows it on the board; the usual end-of-run
push notification still fires. The reasons:

- a task is blocked (review BLOCKED, or the iteration cap);
- planning, the PR agent or `yolo` ended without signalling completion;
- the user pressed Stop on a run;
- the PR's CI isn't green, or the PR isn't mergeable;
- a worktree update or a merge failed;
- an agent couldn't start (for example, missing provider credentials);
- no candidate is ready: `pending` tasks remain, but they all wait on a task that
  isn't completed (typically a blocked one);
- done: every task is completed.

To continue, fix the cause (resume the blocked task, merge or fix the PR), then
press **Start** again. Resuming a blocked task while autopilot is still enabled
also continues: the task finishes under autopilot and the next one follows.

A server restart orphans the running agent as usual (its run is swept to
`failed`); autopilot then sits idle until **Start** is pressed, which picks the
interrupted task up again because it is an `in_progress` candidate.

## Status

`GET /api/projects/:id/autopilot` returns:

```ts
{
  enabled: boolean;
  isGitRepository: boolean;
  running: { taskId: number; title: string | null; agentType: AgentType } | null;
  next: { taskId: number; title: string | null } | null;   // what Start would pick
  readyCount: number;     // ready candidates
  waitingCount: number;   // pending tasks with unresolved dependencies
  blockedCount: number;   // in_progress tasks with workflow_blocked
  message: string | null; // projects.autopilot_message
}
```

The board shows the checkbox (ticking it asks for confirmation, since it means
unreviewed merges into the default branch), a **Start** button (disabled while something is
running or nothing is ready, with a tooltip saying why) and a one-line status:
the running task and agent, or the last message. It re-reads the status every
few seconds while autopilot is enabled.

## What to build

- [ ] `projects.autopilot_enabled` and `projects.autopilot_message` columns.
- [ ] The three endpoints above (project access checked like the other project
      routes; zod-validated body).
- [ ] Candidate/ready selection and ordering, parsing `## Depends on`.
- [ ] Worktree refresh for `pending` tasks before their first run.
- [ ] The agent choice from the task flags.
- [ ] In `startAgentRun`: append the autopilot prompt and disallow
      `AskUserQuestion` when the project's autopilot is enabled; deny
      `AskUserQuestion` in the ask handler for those conversations.
- [ ] Completion-handler additions: planning auto-chain, PR skip without a
      remote, finish after PR/yolo, stop on block.
- [ ] Finishing: PR merge gate, local merge, mark completed, next task, the
      single-flight lock.
- [ ] Board UI: checkbox, Start, status line.

## Reference map

| Concern | File |
|---|---|
| Selection, start, finish, stop | `reference/server/services/autopilot.ts` |
| Routes | `reference/server/routes/projects.ts` (`/projects/:id/autopilot*`) |
| Prompt addendum + tool ban | `reference/server/services/agentRunner.ts`, `reference/server/constants/prompts/autopilot.md` |
| Chaining hooks | `reference/server/services/conversation/agentRunLifecycle.ts` |
| Worktree refresh | `reference/server/services/worktree.ts` (`updateWorktreeFromDefault`) |
| Board UI | `reference/src/components/Dashboard/AutopilotControls.tsx` |

## Boundaries (not in this spec)

- How the tasks and their `## Depends on` sections are created →
  [`project-bootstrap.md`](./project-bootstrap.md).
- The pipeline it drives → [`core/orchestration-loop.md`](../core/orchestration-loop.md).
- Running independent tasks in parallel. Autopilot is deliberately sequential;
  parallel runs would need conflict handling between sibling merges.
