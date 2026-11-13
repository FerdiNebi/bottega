# Extra — Logging tasks from any chat

## What it adds

> I open an Ask Question chat about the checkout flow. From the answer I see
> four changes worth making. I tell the agent "log these as tasks". It shows me
> the list with their order — "2. Persist the cart" depends on "1. Cart
> schema" — I confirm, and four numbered tasks appear in Pending. Autopilot runs
> them in that order, like the initial tasks.

A milestone verification chat can already turn changes into follow-up tasks
([`project-bootstrap.md`](./project-bootstrap.md#follow-up-tasks)). This extra
gives **every other task conversation** the same power, in the shape of the
initial task breakdown: a batch of tasks with dependencies, numbered by
dependency level, so [autopilot](./autopilot.md) knows the order to run them
in.

## Why it's an extra

Core tasks come from a human on the board. Letting an agent write tasks into
the project is another task source, like the bootstrap breakdown, and some
teams want every task authored by a person.

## Which conversations get it

Every task conversation — manual chats (Ask Question, a New Conversation on a
task) and agent runs — gets a **Logging new tasks** section in the context
prompt it already receives (task doc path, ports, the Bottega guard rails).
Left out:

- milestone tasks (`N. Milestone: …`) and `Create initial tasks` sessions,
  whose own instructions already create tasks (`milestone-task.ts`,
  `create-tasks.ts`);
- agent runs of a task whose effective autopilot is on
  ([`autopilot.md`](./autopilot.md#per-task-switches)): nobody is there to
  confirm a task list.

The section tells the agent:

- **Log tasks only when the human asks for it in this conversation**, never on
  its own initiative; it may suggest a task and let the human decide.
- Write each task as a small spec for an agent that has never seen this chat:
  `## Goal`, `## Findings` (what the conversation learned: steps, observed vs.
  expected, cause, files — no secrets), `## References`, `## Acceptance
  criteria`, `## QA scenarios` (at least one in the running app), `## Out of
  scope`.
- Decide the dependencies (on each other, or on existing tasks of the project
  by id), then **show the full list first**, each line with its level and
  dependencies, the way the breakdown session does, and create it only when
  the human confirms. One task per change.
- Run the script exactly as written, then report the ids and titles.

## The script

Same pattern as `create-tasks.ts`: the agent signals intent by running a
script; the UI never parses agent output.

```
{{tsx}} {{scriptsDir}}/log-tasks.ts create <sourceTaskId> <jsonPath>
{{tsx}} {{scriptsDir}}/log-tasks.ts list <sourceTaskId>
```

`<sourceTaskId>` is the task the conversation belongs to. The prompt section
renders both commands with the id filled in.

**`create`** takes an array:

```json
[
  { "key": "schema", "title": "Cart schema", "dependsOn": [], "spec": "## Goal\n…" },
  { "key": "persist", "title": "Persist the cart", "dependsOn": ["schema", 412], "spec": "…" },
  { "key": "copy", "title": "Checkout copy fixes", "dependsOn": [], "spec": "…",
    "autopilotCanStart": false }
]
```

- `dependsOn` entries are either a `key` of the same batch or the **id of an
  existing task in the same project** (a number). Unknown keys, unknown ids,
  ids from another project, self-dependencies, duplicates and cycles are
  errors; every problem is reported at once.
- `kind` is `"task"` (default) or `"milestone"`. A logged batch has no
  [milestone rules](./project-bootstrap.md#milestone-rules): a milestone is
  allowed but not required.
- `autopilotCanStart` and `autopilotCanWork` (both default `true`) set the
  task's [autopilot switches](./autopilot.md#per-task-switches). The agent
  sets them only when the human said so.

The script:

- requires the source task to exist and not be a milestone or a
  `Create initial tasks` session; the tasks go into the source task's project,
  owned by the source task's owner;
- **computes levels** like the breakdown: `level(t) = 1` with no dependencies,
  else `1 + max(level(d))`, where an existing task's level is its own `N. `
  title prefix (0 when it has none). Titles are `"<level>. <title>"` (or
  `"<level>. Milestone: <title>"`); a prefix the model put on a title is
  stripped first;
- creates the tasks in topological order, each with a worktree branched from
  `origin/<default>` (after a fetch; the local default branch without a
  remote) and a task doc = the spec, `## Depends on` listing each dependency
  by title and task id (`- None` when there are none), and `## Logged from`
  naming the source (`- <title> (task #S)`);
- appends `- <title> (task #N)` for each to a `## Logged tasks` section of the
  source task's doc (added at the end when missing);
- is all-or-nothing: on a failure it removes the tasks, worktrees and docs it
  created and leaves the source doc alone;
- exits as soon as the tasks exist (the worktrees' dependency copies run
  detached, like `create-tasks.ts`) and prints a table of id, title and
  dependencies.

Unlike `create-tasks.ts` it does **not** complete the source task: an Ask
Question chat stays open, and the same conversation may log more tasks later.

**`list`** prints the tasks under the source doc's `## Logged tasks` with id,
title and status, and how many are still open.

The tasks land in **Pending**. Autopilot's dependency reading
(`## Depends on`) and ordering (level prefix) apply to them unchanged.

## What to build

- [ ] `log-tasks.ts` with `create` and `list`, validation, levels across the
      batch and existing tasks, all-or-nothing creation, the two doc links.
- [ ] The per-task autopilot switches it sets (see
      [`autopilot.md`](./autopilot.md#per-task-switches)).
- [ ] The **Logging new tasks** section in the context prompt, skipped for
      milestone tasks and `Create initial tasks` sessions.

## Reference map

| Concern | File |
|---|---|
| Validation, levels, creation, list | `reference/server/services/taskLogging.ts` |
| CLI | `reference/scripts/log-tasks.ts` |
| Prompt section | `reference/server/constants/prompts/task-logging.md`, rendered by `buildContextPrompt` in `reference/server/services/documentation.ts` |

## Boundaries (not in this spec)

- The initial breakdown and milestone follow-ups →
  [`project-bootstrap.md`](./project-bootstrap.md).
- Running the tasks → [`autopilot.md`](./autopilot.md).
