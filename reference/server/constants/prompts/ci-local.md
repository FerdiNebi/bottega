This project uses **local CI**: GitHub runs CI only on the base branch after the merge, so YOU run the CI steps here, in this worktree, before the PR is ready. Do NOT wait for GitHub checks on the PR (`gh run list`, `gh run watch`, `gh pr checks`); any that appear are ignored.

**1. Find the steps.** Read the workflows in `.github/workflows/` (or the CI config the project uses) that run on a push to `{{baseBranch}}`, because those are the runs that will happen after the merge. List every job's `run:` steps in order, with the job's `working-directory` and its non-secret `env` values.
- Replace setup actions (`actions/checkout`, `setup-node`, caches, artifact uploads) with this machine's toolchain. Install dependencies with the workflow's own command (e.g. `npm ci`, `pnpm install --frozen-lockfile`).
- For service containers (e.g. Postgres), use an instance that is already reachable with the workflow's connection settings, or start one with Docker if `docker` is available. Stop any container you started when you are done.
- NEVER run deploy or publish work: skip workflows triggered by `workflow_run`, and anything that deploys, releases, publishes or pushes images, or needs a secret (`${{ secrets.* }}`).
- If there is no CI config, run the test and build commands that `CLAUDE.md` or the package manifest names. If there are none, treat CI as PASSED.

**2. Run them** one at a time, each in the foreground with the Bash tool's `timeout: 600000`. Do NOT use `run_in_background`: nothing wakes you when a background command finishes, and ending your turn ends this run. Never run two suites in parallel. If a step times out, split it (e.g. run the test suite in parts). A step whose pass at the current `HEAD` (`git rev-parse HEAD`) is recorded in the Verification Log of `{{taskDocPath}}` need not be re-run.

**3. Skips.** A step may be skipped ONLY when its tool or service cannot be provided on this machine (e.g. no Docker for an image build, the Playwright browser cannot be installed). Record the reason; GitHub CI on `{{baseBranch}}` will still run it. A step that ran and failed is a failure, never a skip.

**4. Handle the result.**

**If every step passed or was skipped:** post the results on the PR in one comment, then proceed to the merge-conflict check below:
```bash
gh pr comment --body "Local CI at <full HEAD sha>: <one line per step: name: passed | skipped (reason)>"
```

**If a step FAILED:**
1. Read its output and find the cause (test failures, build errors, lint issues)
2. Fix the issues in the codebase
3. Commit and push: `git add -A && git commit -m "Fix CI: <description>" && git push`
4. Re-run from the failed step, then the remaining steps (max 10 fix iterations)

**If max iterations reached:**
- Document the persistent failures
- Stop and let the user investigate
