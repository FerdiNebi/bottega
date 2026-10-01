# Core — Task and workspace

This is the substrate the orchestration loop runs on. It defines the unit of
work the agents collaborate on, and the isolated place they do that work.

## What it delivers

A **task** is two things bound together:

1. a **markdown document** that defines the work (the request, then the plan), and
2. an **isolated git worktree** where the agents make their changes,

plus a small set of **workflow flags** (owned by
[`orchestration-loop.md`](./orchestration-loop.md)) that gate the loop.

The tool is deliberately agnostic about *how* the markdown comes to exist.
Authoring tasks through a board is an [extra](../extra/kanban-board.md); core
only requires that the document is present at a known path. That single
constraint is what lets a team point Bottega at Jira, Notion, or a plain file
instead.

## The domain model

Three tables, parent → child. The database stores **metadata only**; the work
itself lives on disk (the doc in an archive, the code in a worktree).

- **project** — points at a git repository on disk (`repo_folder_path`).
  Optional `subproject_path` for monorepos.
- **task** — belongs to a project. Carries `title`, `status`, and the workflow
  flags. Backed by a markdown doc and a worktree.
- **conversation** — belongs to a task. One streaming session, whether a manual
  chat or an agent run. See [`harness-contract.md`](./harness-contract.md).

Schema: [`reference/server/database/init.sql`](../reference/server/database/init.sql).

Task `status` moves `pending → in_progress → in_review → completed`. The loop
flips `pending → in_progress` on the first agent activity (see
[`orchestration-loop.md`](./orchestration-loop.md)).

## The markdown document — the source of truth for "what to build"

- **Location:** a central, per-user archive **outside the repo** —
  `~/.bottega/projects/{projectId}/tasks/task-{taskId}.md` (root overridable via
  `BOTTEGA_ARCHIVE_ROOT`).
- **Why outside the repo (the load-bearing decision):** the doc must survive the
  worktree being torn down when the task's PR merges. If it lived inside the
  worktree it would vanish with it. Keeping it in a separate archive means the
  plan, the to-do checklist, and the review history outlive any single
  worktree. See `getArchiveRoot` / `getTaskDocPath` in
  [`reference/server/services/documentation.ts`](../reference/server/services/documentation.ts).
- **Seeding:** created at task creation with the user's original request (the
  task description), or empty/title-only if there is none. The planning agent
  later rewrites it into a full plan but must quote the original request
  verbatim — see [`planning-agent.md`](./planning-agent.md).
- **Shared scratchpad:** the plan, the to-do list, and the "Review Findings"
  section all live in this one file. The implementation and review agents read
  and write it across iterations — see [`execution-loop.md`](./execution-loop.md).
- **Companions in the archive:** per-task **input files** (attachments) and the
  review **recording** (`recordings/task-{taskId}.webm`) live alongside the doc,
  for the same survive-the-merge reason.
- Helpers: `readTaskDoc` / `writeTaskDoc` / `deleteTaskDoc` / `deleteTaskArchive`
  in `documentation.ts`.

## The worktree — the isolated workspace

- **One git worktree per task**, at `{repo_folder_path}-worktrees/task-{taskId}/`
  — a sibling directory, never inside the repo itself.
- **Branch:** `task/{taskId}-{sanitized-title}`, cut from the repo's default
  branch (resolved via `origin/HEAD`, falling back to `main`/`master`).
- **Why a worktree, not a checkout:** every task gets a real, independent working
  directory, so concurrent tasks never collide on the filesystem and the user's
  main checkout is never disturbed.
- **Created at task creation** when the project path is a git repo; if worktree
  creation fails, the task row is rolled back (see the create handler in
  [`reference/server/routes/tasks.ts`](../reference/server/routes/tasks.ts)).
- **Create-time conveniences** so an agent can build and test immediately:
  symlink the repo's `.env*` files into the worktree, create gitignored dirs,
  and copy `node_modules` / `.venv` in the background. See `createWorktree` in
  [`reference/server/services/worktree.ts`](../reference/server/services/worktree.ts).
- **Effective working directory:** an agent runs with `cwd` = the worktree
  project path if the worktree exists, else the repo path (with
  `subproject_path` appended for monorepos). This resolution is done in
  `startAgentRun` — see [`orchestration-loop.md`](./orchestration-loop.md).
- **Per-task dev-server port:** `3100 + (taskId % 900)`, handed to the agent in
  its context so parallel tasks don't fight over ports (`getDevServerPort`).
- **Teardown:** `removeWorktree` (`git worktree remove --force` + delete the
  branch) plus `deleteTaskArchive` (doc + inputs + recording) on task delete.
  Merging the PR and cleaning up the worktree afterward is a separate action —
  see [`pull-request-agent.md`](./pull-request-agent.md). The pipeline never
  auto-deletes a worktree mid-flight.
- **Merge without PR:** for work that needs no review, and for projects without
  a remote. The target is `origin/HEAD`, or without a remote a local `main`,
  else `master`; it never falls back to whatever happens to be checked out. It
  refuses, leaving the worktree untouched, when the main checkout is not on that
  branch. Then:
  1. **Sync** (only with an `origin` remote): `git fetch origin <default>` and
     fast-forward the local default branch to it, so the push in step 4 isn't
     rejected because PRs were merged on GitHub meanwhile. If local and remote
     have diverged, it refuses before changing anything. A failed fetch
     (offline) is not fatal; the push then reports the problem.
  2. **Commit** any uncommitted worktree changes (message = task title),
     skipped when the session already committed everything.
  3. **Merge** with `git merge --no-ff` in the main checkout. On a failed merge
     (conflict, or local changes in the way) it aborts, keeps the worktree, and
     reports git's output (e.g. the conflicting files).
  4. **Push** the default branch to `origin` when there is one. A push failure
     does not undo the merge: the result reports `pushed: false` with git's
     message, and Task Detail shows it so the human can push by hand.
  5. **Clean up**: remove the worktree and branch.

  As with the PR merge action, Task Detail then marks the task completed and
  returns to the board. See `mergeLocally` in
  [`reference/server/services/worktree.ts`](../reference/server/services/worktree.ts).

## How the document becomes agent context

When an agent run starts, the orchestrator assembles a context system-prompt
from the archive (`buildContextPrompt` in `documentation.ts`). It:

- names the authoritative task-doc path and instructs the agent to **read it in
  full first**,
- lists any input files to read for additional context,
- includes the testing configuration (task id, the assigned dev-server port,
  and test-execution best practices).

The agent then reads and edits the doc directly with its own file tools. The doc
path in the prompt is authoritative — agents are told not to look elsewhere.

## What to build

- [ ] `projects` / `tasks` / `conversations` tables (metadata only) — see
      [`init.sql`](../reference/server/database/init.sql).
- [ ] A configurable archive root with this layout: `tasks/task-{id}.md`,
      `tasks/task-{id}/input_files/`, `recordings/task-{id}.webm`.
- [ ] Doc read/write/delete + whole-archive cleanup helpers.
- [ ] Worktree create / remove / status helpers wrapping `git worktree`: branch
      naming, default-branch detection, env-symlink and dependency-copy
      conveniences.
- [ ] Task create: insert row → create worktree (roll back the row on failure) →
      seed the doc with the original request.
- [ ] Task delete: remove worktree + branch → delete the archive.
- [ ] Merge without PR: fast-forward the default branch from `origin` → commit
      worktree changes → merge into the default branch in the main checkout
      (abort on failure, keep the worktree) → push the default branch when there
      is a remote (failure reported, merge kept) → remove worktree + branch.
- [ ] `buildContextPrompt` assembling the agent's task context.
- [ ] Effective-cwd resolution (worktree if present, else repo).

## Reference map

| Concern | File |
|---|---|
| Archive paths, doc I/O, context prompt | `reference/server/services/documentation.ts` |
| Worktree primitives (create/remove/status, PR, merge-and-cleanup) | `reference/server/services/worktree.ts` |
| Task CRUD + worktree/doc wiring | `reference/server/routes/tasks.ts` |
| Task access helpers | `reference/server/services/taskService.ts` |
| Tables | `reference/server/database/init.sql` |

## Boundaries (not in this spec)

- The workflow flags and the loop that reads them →
  [`orchestration-loop.md`](./orchestration-loop.md).
- How a conversation streams and persists its transcript →
  [`harness-contract.md`](./harness-contract.md).
- How tasks get authored (board UI, Jira/Notion import) →
  [`kanban-board.md`](../extra/kanban-board.md).
- Opening the PR and merging/cleaning up the worktree →
  [`pull-request-agent.md`](./pull-request-agent.md).
