# Extra — The learnings agent

## What it adds

One last pass per task, after the work is reviewed and refined and **before the
PR is opened**: a **learnings** agent writes down what the next task should
know about the project. It looks at what this task changed and at what went
wrong while doing it (failed commands, review rounds, slow steps), and folds
the lessons that apply beyond this task into a Bottega-managed section of the
project's `CLAUDE.md`. That file ships in the task's own PR, so the knowledge is
reviewed with the code, and every later task, which branches off the default
branch after the merge, starts with it loaded.

> Each task used to rediscover the codebase from scratch and repeat the same
> mistakes: the wrong test command, a missing generate step, a port clash. Now
> the pipeline keeps a running project notebook, and each task reads it.

## Why it's an extra (not core)

Shipping reviewed work as a PR doesn't depend on it. Remove this extra and the
finish pipeline is exactly what the refinement extra (or core) describes.

## Where it inserts

In the completion handler's `workflow_complete` branch
(`handleAgentChaining` in
[`../reference/server/services/conversation/agentRunLifecycle.ts`](../reference/server/services/conversation/agentRunLifecycle.ts)),
**after** the refinement check and **before** the PR check:

- `workflow_complete` and `refinement_complete` are set, the finishing agent
  was **not** learnings, and `learnings_complete` is **not** set → start the
  **learnings** agent and return.
- The finishing agent **was** learnings → `tasksDb.markLearningsComplete` (sets
  `learnings_complete`) and fall through to the PR check.

So the pipeline is review → refinement → learnings → PR. Like refinement, it is
gated on a persistent flag, so it runs **at most once** per task. Learnings is
chainable (it is in the `shouldChain` set). The flag lives on `tasks`
(`learnings_complete INTEGER DEFAULT 0 NOT NULL`); setting a task's
`workflow_complete` by hand marks it, clearing it resets it, the same as
`refinement_complete`. Under [autopilot](./autopilot.md), `nextStepForTask`
returns `learnings` between refinement and PR. YOLO tasks skip it.

## What the agent sees

Each run is a fresh session, so the learnings agent never saw the earlier runs
of its task. The server hands it a **run digest** built from the stored
transcripts, rendered into its prompt:

- every earlier run of the task: type, status, duration, model;
- for each review run, its closing summary (the verdict and why);
- shell commands that failed (non-zero exit or tool error), grouped by command,
  with a count and the first lines of the error;
- commands the harness blocked, and the slowest commands.

Secrets (tokens that look like GitHub/API keys) are redacted, and the digest is
size-capped. It also reads the task doc (plan, Review Findings, Verification
Log, Autopilot decisions) and the branch diff against the base branch. Runs on
providers whose transcripts are not in the Claude format still get the run list.

## What it writes

Only the **managed section** of `CLAUDE.md` at the worktree root, between
`<!-- bottega:learnings:start -->` and `<!-- bottega:learnings:end -->`. If the
markers are missing it appends them (creating `CLAUDE.md` if needed); text
outside them is never edited. The section has three parts:

- **Codebase map** — where things live, the modules and conventions a new task
  needs to find its way.
- **Commands & testing** — exact commands that work: setup, generate steps,
  running a single package's tests, the full suite, what CI runs.
- **Pitfalls & lessons** — what went wrong and what to do instead.

It **curates rather than appends**: it merges new facts into existing bullets,
corrects or removes bullets this task proved wrong, never keeps a per-task log
(no task numbers or dates), and keeps the section under about 150 lines. A
lesson goes in only if it would save a future task time and was seen in the
diff, the digest or the repo, not guessed. Facts about one machine (local
paths, its OS quirks) stay out; they are not true for everyone using the repo.
If nothing new was learned, it changes nothing.

It commits the `CLAUDE.md` change itself (`Update project knowledge in
CLAUDE.md`), touches no other file, asks no questions, and runs no completion
script — completion is implicit and the loop chains to PR.

## What to build

- [ ] `learnings_complete` on `tasks`, `learnings` in the agent-type enum, with
      migrations (a table rebuild for the CHECK constraint, keeping every
      column), and mark/reset helpers.
- [ ] Copy each existing user's refinement model setting to `learnings`, so
      saved settings stay complete.
- [ ] The run digest builder.
- [ ] The learnings prompt (`taskDocPath`, `taskId`, `runDigest`,
      `baseBranch`) and its agent-runner case.
- [ ] The chaining step, the autopilot step, the manual-complete flag handling.
- [ ] The UI step and its model setting.

## Reference map

| Concern | File |
|---|---|
| Prompt | `reference/server/constants/prompts/learnings.md` |
| Run digest | `reference/server/services/taskRunDigest.ts` |
| Chaining | `reference/server/services/conversation/agentRunLifecycle.ts` |
| Autopilot step | `reference/server/services/autopilot.ts` (`nextStepForTask`) |
| Flags + migrations | `reference/server/database/db.ts`, `reference/server/database/init.sql` |
