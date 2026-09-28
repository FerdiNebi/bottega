# Extra — Project bootstrap (PRD → ARD → initial tasks)

## What it adds

Three guided, interactive sessions that take a project from "an idea" to "a board
full of well-specified tasks the orchestration loop can run":

1. **Create / Refine PRD** — an agent interviews the human about the product
   until it is confident it understands what to build, then writes `PRD.md` at
   the repo root and links it from `CLAUDE.md`.
2. **Create / Refine ARD** — an agent acting as an architect *recommends* and
   confirms the architecture, stack, engineering patterns, project structure, and
   testing strategy, then writes `ARD.md` (Architecture Requirements Document) and
   links it from `CLAUDE.md`.
3. **Create initial tasks** — once both documents are merged, an agent breaks the
   PRD + ARD into PR-sized tasks, shows the list in chat, and — on confirmation —
   creates them as Bottega tasks whose titles encode their dependency level
   (`1.`, `2.`, `3.`, …).

Sessions 1 and 2 each run in their own task worktree, so their output ships as a
normal pull request the human reviews and merges.

## Why it's an extra (not core)

Core only needs a task row and its markdown doc
([`task-and-workspace.md`](../core/task-and-workspace.md)); it does not care how
either came to exist. This extra is simply a richer **task source** — a front
door, like the [Kanban board](./kanban-board.md) — plus two document-authoring
chats. It changes nothing in the state machine, adds no agent type, and adds no
column. Skip it and core still plans, implements, reviews, and ships tasks you
write by hand.

## The shape of a bootstrap session

All three sessions are the same composition of existing primitives — the same
one the board's **Ask Question** shortcut uses (create task, create
conversation, open the chat):

1. **Create a task** with a fixed title (`Create PRD`, `Refine PRD`,
   `Create ARD`, `Refine ARD`, `Create initial tasks`) and seed its doc with the
   human's input from the modal.
2. **Create its worktree from the freshly fetched remote default branch**
   (`origin/<default>`), not the local one — see
   [Freshness](#freshness-read-from-and-branch-from-the-remote-default-branch).
3. **Start a conversation** whose **first user message is a rendered prompt
   template** (`prd`, `ard`, or `task-breakdown`), with the usual task context as
   the system prompt.
4. **Return `{ taskId, conversationId }`** and open the chat.

From there it is an ordinary manual chat: the human answers questions, asks for
edits by typing, and — for sessions 1 and 2 — opens the PR from Task Detail's
existing **Create PR** action (commit → push → `gh pr create`; see
`createOrUpdatePR` in
[`../reference/server/services/prService.ts`](../reference/server/services/prService.ts)).

### Why the instructions live in the first message

The session's behavioral instructions must survive every turn of a long
interview. A conversation's custom system prompt is only applied on the turn
that **starts** the session — resumed turns (`sendMessage` in
[`../reference/server/services/conversation/startConversation.ts`](../reference/server/services/conversation/startConversation.ts))
do not pass it again. The first user message, by contrast, is part of the
transcript and is replayed on every resume. So the rendered template is the
first message, exactly like agent runs deliver their prompts. Do not move these
instructions into the system prompt.

### Why not a new agent type

These are human-in-the-loop chats, not pipeline agents: they never chain, never
set workflow flags, and never run unattended. Modeling them as agent types would
also require widening the `agent_type` `CHECK` constraint on `task_agent_runs`
(a table rebuild in SQLite). A task + conversation is the smaller, correct shape.

## Documents and `CLAUDE.md`

| Document | Location | Written by |
|---|---|---|
| Product requirements | `PRD.md` (repo root) | PRD session |
| Architecture requirements | `ARD.md` (repo root) | ARD session |
| Agent memory / index | `CLAUDE.md` (repo root) | PRD and ARD sessions (create or update) |

When a session writes its document it also **creates or updates a
`## Project documents` section in `CLAUDE.md`** so every future agent run —
planning, implementation, review — knows the documents exist:

```markdown
## Project documents

- Product requirements: [PRD.md](PRD.md) — read the relevant sections before planning or implementing a feature.
- Architecture requirements: [ARD.md](ARD.md) — follow its stack, structure, patterns, and testing strategy; flag any conflict instead of silently deviating.
```

Use **plain links, not `@PRD.md` imports.** An import inlines the whole document
into every agent's context on every turn; a PRD is easily tens of thousands of
tokens. A link plus an instruction lets agents read the sections they need. The
session edits only this section and leaves the rest of `CLAUDE.md` untouched.

## Freshness: read from and branch from the remote default branch

The human typically merges the PRD/ARD pull requests on GitHub, which leaves the
server's local default branch stale. Two rules keep bootstrap correct anyway:

- **Status is read from `origin/<default>`** after a `git fetch`. "PRD present"
  means `git cat-file -e origin/<default>:PRD.md` succeeds (likewise `ARD.md`).
  If the fetch fails (offline, no remote), fall back to the local default branch
  and report the status as possibly stale.
- **Bootstrap worktrees branch from `origin/<default>`** — the three sessions
  and every task created by session 3. Otherwise a freshly created task's
  worktree would not contain the PRD/ARD its agents are told to follow. This is
  an optional base ref on worktree creation; the board's normal "New Task" path is
  unchanged.

## Create vs Refine mode

Each document button has two modes, decided by the status check:

- **Create** — the document is not on `origin/<default>`. The modal asks for the
  initial idea (PRD, required) or constraints and preferences (ARD, optional).
  The agent interviews from scratch.
- **Refine** — the document already exists. The button reads **Refine PRD** /
  **Refine ARD**; the modal asks what should change (optional). The agent reads
  the existing document first and interviews only about gaps and the requested
  changes, then edits in place.

## The interview protocol (PRD and ARD sessions)

Both templates impose the same protocol; only the checklist differs.

1. **Ground first.** Read `CLAUDE.md` and any existing `PRD.md` / `ARD.md` in the
   worktree. The ARD session reads `PRD.md` (and warns, but continues, if it is
   missing — the ARD button is not gated on the PRD).
2. **Interview against a coverage checklist.** Ask in rounds using the
   structured-question tool (`AskUserQuestion`): at most 4 questions per call,
   multiple choice where possible, with a **recommended option listed first** and
   a one-line trade-off per option. The human can always answer free-form.
3. **Report understanding after every round** with a single line such as
   `Understanding: 85% — still unclear: pricing model, offline support`. The
   percentage is the agent's self-assessment against the checklist; it is a
   progress signal for the human, not a computed metric.
4. **Stop interviewing only at ≥ 99% with no critical item open.** Then ask for
   explicit confirmation (`Write PRD now` / `Keep refining`). Never write the
   document without that confirmation.
5. **Write the document and update `CLAUDE.md`** (see above), then post a short
   summary of what was written and invite corrections.
6. **Iterate.** The human requests edits by chatting; the agent edits the file in
   place. When the human is satisfied, they open the PR from Task Detail.

Hard constraints in both templates: **never commit, push, or open a PR** (the
Create PR action owns that); never touch files other than the document and the
`CLAUDE.md` section; never invent requirements the human did not confirm — record
unresolved items in an "Open questions" section instead.

### PRD coverage checklist

Problem and context · target users and personas · goals and **non-goals** · core
user journeys · functional requirements with priorities (P0/P1/P2) ·
non-functional requirements (performance, security, privacy, accessibility,
localization) · data, integrations, and external systems · constraints (budget,
timeline, compliance, platforms) · success metrics · MVP scope vs later releases
· risks, assumptions, and open questions.

### ARD coverage checklist

The ARD agent **recommends** — every question presents concrete options with
trade-offs and a recommended default derived from the PRD — rather than only
asking. Checklist: architectural style and system context · components/modules
and their responsibilities · technology stack with rationale **and rejected
alternatives** · project/directory structure (as a tree) · data model and storage
· APIs and integration contracts · authentication, authorization, and security ·
engineering patterns and coding conventions · **testing strategy** (test pyramid,
tools, what is covered by unit / integration / E2E, coverage gates, how QA
scenarios are run) · CI/CD, environments, and deployment · observability ·
performance and scalability · key decisions in ADR style (decision, context,
consequences) · risks and open questions.

## Creating the initial tasks

### Prerequisite

**Both `PRD.md` and `ARD.md` must be present on `origin/<default>`** — i.e. their
PRs are merged. Task worktrees branch from the default branch, so tasks created
before the documents are merged would be implemented without them. The button is
disabled until the status check passes (with a tooltip saying which document is
missing and a re-check action), and the start endpoint independently returns
**409** if called anyway.

### The session

The `task-breakdown` template instructs the agent to:

1. Read `PRD.md`, `ARD.md`, and `CLAUDE.md` from its worktree.
2. Decompose the work into **PR-sized vertical slices**. The first task(s) set up
   the project skeleton the ARD prescribes (structure, tooling, lint, test
   harness, CI), so later tasks have real conventions and tests to verify
   against.
3. Write each task as a small spec:

   ```markdown
   ## Goal
   One or two sentences.

   ## References
   - PRD: §6.4 Guest ordering (FR-080–FR-084)
   - ARD: §4.2 OrderService, §7 Testing strategy

   ## Acceptance criteria
   - …

   ## QA scenarios
   Scenarios the review agent must run to verify the goal.

   ## Out of scope
   - …
   ```

4. **Show the full list in chat before creating anything**, grouped by
   dependency level, each line with its dependencies:

   ```
   1. Project scaffold
   1. CI pipeline
   2. Authentication            (depends on: Project scaffold)
   2. Menu management           (depends on: Project scaffold)
   3. Guest meal selection      (depends on: Authentication, Menu management)
   ```

5. Ask for confirmation (`Create these N tasks` / `Adjust`) and iterate on the
   list until confirmed.
6. On confirmation, write the list as JSON and run the task-creation script
   (below). If the script reports validation errors, fix the JSON and run it
   again.

### The task-creation script

Task creation follows the same pattern as the completion scripts
(`complete-plan.ts` et al.): the agent signals intent by running a script; **the
UI never parses agent output**.

```
tsx {{scriptsDir}}/create-tasks.ts <sessionTaskId> <jsonPath>
```

Input — an array validated with a schema:

```json
[
  { "key": "scaffold", "title": "Project scaffold", "dependsOn": [], "spec": "## Goal\n…" },
  { "key": "auth", "title": "Authentication", "dependsOn": ["scaffold"], "spec": "…" }
]
```

The script:

- **Derives project and owner from the session task.** An agent can only create
  tasks in the project its own session belongs to, owned by the same user.
- **Validates** unique `key`s, known `dependsOn` references, no cycles, non-empty
  titles and specs. On any error it exits non-zero and prints every problem, so
  the agent can correct the JSON in one pass.
- **Computes dependency levels itself** — it never trusts a prefix from the
  model:

  ```
  level(t) = 1                                  if t has no dependencies
  level(t) = 1 + max(level(d) for d in deps(t)) otherwise
  ```

  So a task that depends on both a level-1 and a level-2 task is level 3.
- **Creates tasks in topological order**, titled `"<level>. <title>"` (e.g.
  `2. Authentication`). Each gets a worktree branched from `origin/<default>` and
  a task doc = the spec plus a `## Depends on` section that lists each dependency
  by **title and Bottega task id** (dependencies are created first, so their ids
  are known).
- **Is all-or-nothing.** If any creation fails, it deletes the tasks and
  worktrees it already created and exits non-zero.
- **Marks the session task `completed`** on success and prints a summary table.

The created tasks land in **Pending**. Nothing starts automatically; the human
runs planning per task as usual.

### Dependencies are advisory

The level prefix and the `## Depends on` section are the whole dependency model:
no table, no run gating. The operating rule is **merge a level before starting
the next** — each task branches from the default branch, so a task only sees its
dependencies' code once their PRs are merged. Enforced dependencies (a
`task_dependencies` table plus disabled Run buttons) are a possible follow-up
extra, deliberately out of scope here.

## Provider behavior

The interview relies on the structured-question tool, gated by
`supportsAskUserQuestion` in the capability matrix
([`../reference/shared/providers/capabilities.ts`](../reference/shared/providers/capabilities.ts)).
Harnesses without it (Codex, OpenCode) are instructed in the template to ask the
same questions **in plain text and end the turn**; the human answers through the
normal chat input. Everything else — writing files, running the script — works
the same on every harness.

## HTTP surface

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/projects/:id/bootstrap` | Status: `{ defaultBranch, prd: { onMain }, ard: { onMain }, stale }` (fetches first). |
| `POST` | `/api/projects/:id/bootstrap/:kind` | Start a session. `kind ∈ {prd, ard, tasks}`; body `{ input?, provider, model }`. Returns `201 { taskId, conversationId }`. |

Both are project-membership checked like every project route. `POST` returns
**409** when a prerequisite is missing (tasks without PRD+ARD on main) and **403**
`PROVIDER_CREDENTIALS_MISSING` when the chosen provider is not connected — the
same responses the board already handles. The `(provider, model)` pair is
explicit and validated like conversation creation (`isModelForProvider`); there is
no default model.

## UI

- The Board header gains a **Project docs** group next to **Ask Question**:
  **Create PRD** / **Refine PRD**, **Create ARD** / **Refine ARD**, and **Create
  initial tasks** (disabled with an explanatory tooltip until both documents are
  on the default branch). Labels and the disabled state come from the status
  endpoint.
- One modal serves all three, modeled on the Ask Question modal (provider/model
  picker, voice input). Its single textarea depends on the kind: *Describe your
  idea* (PRD, create — required), *What should change?* (refine — optional),
  *Constraints or preferences* (ARD — optional), *Guidance, e.g. "MVP only"*
  (tasks — optional).
- On success the modal navigates straight to the new chat. Answers go through the
  existing structured-question panel; edits through the normal chat input; the PR
  through Task Detail's **Create PR**.
- After task creation the board shows the new tasks on its next load (the script
  runs outside the server process, so there is no live push).

## Security notes

- Everything the human types is trusted input from an authenticated project
  member; there is no external/webhook entry point.
- The creation script is scoped by construction to the session task's project and
  owner. Agents already run with full shell access (see
  [`auth-and-multi-user.md`](./auth-and-multi-user.md)); this script adds no new
  privilege, only a structured way to express intent.
- The session templates forbid committing, pushing, and reading credentials; the
  PR is created by the server-side Create PR action.

## What to build

- [ ] Status check that fetches and reads `PRD.md` / `ARD.md` from
      `origin/<default>`, with a stale fallback.
- [ ] An optional base ref on worktree creation; bootstrap sessions and created
      tasks branch from `origin/<default>`.
- [ ] A session starter: create task (fixed title, seeded doc) + worktree +
      conversation whose **first message** is the rendered template; return ids.
- [ ] `GET /bootstrap` and `POST /bootstrap/:kind` with membership checks, 409 on
      missing prerequisites, 403 on missing credentials, explicit model.
- [ ] Three overridable prompt templates — `prd`, `ard`, `task-breakdown` —
      implementing the interview protocol, the checklists, the `CLAUDE.md`
      linking rule, create/refine modes, and the plain-text fallback for
      providers without structured questions.
- [ ] `create-tasks.ts`: schema validation, cycle/unknown-key detection, level
      computation, topological creation with `"<level>. "` titles and
      `## Depends on` docs, all-or-nothing rollback, session task marked
      completed.
- [ ] Board buttons (create/refine labels, gated tasks button) and a single
      bootstrap modal that opens the chat on success.

## Reference map

| Concern | File |
|---|---|
| Status check + session starter | `reference/server/services/projectBootstrap.ts` |
| Level computation + list validation | `reference/server/services/taskBreakdown.ts` |
| Task-creation script | `reference/scripts/create-tasks.ts` |
| HTTP routes | `reference/server/routes/projects.ts` (`/bootstrap`) |
| Request/response schemas | `reference/shared/schemas/projects.ts`, `reference/shared/api/projects.ts` |
| Worktree base ref | `reference/server/services/worktree.ts` (`createWorktree`) |
| Session prompts | `reference/server/constants/prompts/{prd,ard,task-breakdown}.md` |
| Prompt registry | `reference/server/services/promptRenderer.ts` (`PROMPT_DEFINITIONS`) |
| Board buttons | `reference/src/components/Dashboard/BoardView.tsx` |
| Bootstrap modal | `reference/src/components/BootstrapSessionModal.tsx` |
| Existing PR action reused | `reference/server/services/prService.ts` (`createOrUpdatePR`) |

## Boundaries (not in this spec)

- The task row, its doc, and worktree lifecycle →
  [`../core/task-and-workspace.md`](../core/task-and-workspace.md).
- What happens once a created task is run (planning → implement ⇄ review → PR) →
  [`../core/orchestration-loop.md`](../core/orchestration-loop.md).
- The board and the Ask Question shortcut this extra mirrors →
  [`./kanban-board.md`](./kanban-board.md).
- The commit/push/create-PR server helpers behind Task Detail's Create PR →
  [`../core/pull-request-agent.md`](../core/pull-request-agent.md).
- Prompt override mechanics and the model/effort picker →
  [`./prompt-and-model-customization.md`](./prompt-and-model-customization.md).
- The structured-question widget and the capability matrix →
  [`../core/harness-contract.md`](../core/harness-contract.md),
  [`./harnesses/overview.md`](./harnesses/overview.md).
- Other task sources (Jira, Notion) — same seam, different front door →
  [`./kanban-board.md`](./kanban-board.md#the-swap-it-out-seam-read-this-first).
