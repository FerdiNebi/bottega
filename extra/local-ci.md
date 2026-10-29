# Extra — Local CI

A per-project switch that moves the PR's CI run off the hosted CI and onto the
machine Bottega runs on. The PR agent runs the project's CI steps itself in the
task's worktree, fixes whatever fails, and signals the PR ready. The hosted CI
then runs only on the default branch, after the merge.

## What it delivers

> Every PR used to run CI on GitHub twice: once on the PR and again when it was
> merged to `main`. That burned my monthly Actions minutes. Now I set a project
> to **Local CI**: the PR agent runs the same lint, typecheck, test and build
> steps locally before it says the PR is ready, and GitHub runs CI only on
> `main`.

## The setting

`projects.ci_mode` is `'github'` (the default, today's behaviour) or `'local'`.
It is edited on the project's settings page. It is project-wide, not per
member.

Bottega does not edit the project's workflow files. To stop the hosted run on
PRs, the project's CI workflow should trigger only on pushes to the default
branch (drop its `pull_request` trigger). The settings page says so next to the
switch. If the workflow still runs on PRs, those runs are ignored. They still
cost minutes.

## What changes in local mode

The CI step of every prompt that ends with a green PR changes: the PR agent
([`core/pull-request-agent.md`](../core/pull-request-agent.md)), YOLO's phase 5
([`yolo-mode.md`](./yolo-mode.md)) and the feedback re-run
([`pr-comment-retrigger.md`](./pr-comment-retrigger.md)). The server renders that
step from one of two prompts, `ci-github` or `ci-local`, and inlines it as
`{{ciCheckBlock}}`. The rest of the procedure is the same in both modes: create
or update the PR, rebase first, check for conflicts, and run the completion
script.

The local CI step:

1. **Find the steps.** Read the workflows under `.github/workflows/` (or the
   project's equivalent CI config) that run on a push to the base branch,
   because those are the runs that happen after the merge. Collect each job's
   `run:` steps in order, with the job's `working-directory` and its
   non-secret `env`.
2. **Map them to this machine.** Setup actions (`checkout`, `setup-node`,
   caches, artifact uploads) are replaced by the local toolchain. Service
   containers (e.g. Postgres) use an instance that is already reachable, or one
   started with Docker if Docker is available.
3. **Never run deploy or publish work.** Skip workflows that are triggered by
   `workflow_run`, deploy, release, publish or push images, and any step that
   needs a secret.
4. **Run each step in the foreground**, each with the Bash tool's 10-minute
   timeout, never in the background, one at a time. A step that records a pass
   at the current `HEAD` in the task doc's Verification Log need not be re-run.
5. **Fix failures** in the worktree, commit and push, then re-run from the
   failed step. This is bounded at 10 fix iterations, as in GitHub mode.
6. **Skips are allowed only for missing infrastructure.** A step whose tool or
   service cannot be provided on this machine (no Docker for an image build, no
   browser for an end-to-end suite) is recorded as skipped with the reason. It
   is not a failure: the default branch's hosted CI still runs it after the
   merge. A step that ran and failed is never "skipped".
7. **Report.** Post one PR comment (`gh pr comment`) with the head SHA and
   every step's result (passed / skipped + reason). Then go on to the conflict
   check. A conflict rebase changes `HEAD`, so it re-runs the local CI step.

If the project has no CI config, the local step runs the test and build
commands that `CLAUDE.md` / `package.json` name. If there are none, CI is
treated as passed, the same as `CI: none` in GitHub mode.

## Merge gates

- **Autopilot** ([`autopilot.md`](./autopilot.md)): in local mode the PR's
  hosted check status is not a merge gate. `pr_agent_complete` (the agent's
  "local CI passed") plus `MERGEABLE` is enough. In GitHub mode nothing
  changes.
- **The manual Merge button** is unchanged. It reads the PR's hosted checks.
  Once the workflow no longer runs on PRs, those are `none` and the button is
  green.

## Boundaries

- Nothing watches the default branch's CI after the merge, in either mode. A
  red run on `main` is noticed by the hosted CI's own notifications.
- Local CI runs on the Bottega host, in the worktree. It is only as faithful as
  that machine. OS-specific differences (e.g. Windows vs the runner's Linux)
  show up on `main`, not on the PR.

## Reference map

| Concern | File |
|---|---|
| Column + migration | `reference/server/database/db.ts` (`ci_mode`) |
| Setting UI | `reference/src/pages/ProjectEditPageWrapper.tsx` |
| CI step prompts | `reference/server/constants/prompts/ci-github.md`, `ci-local.md` |
| Prompt assembly | `reference/server/constants/agentPrompts.ts` (`buildCiCheckBlock`) |
| Autopilot gate | `reference/server/services/autopilot.ts` (`mergeTask`) |
