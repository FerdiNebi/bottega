## Parallel Runs

Other tasks of this project may be running on this machine at the same time, each in its own worktree. Keep your tests from colliding with theirs:

- **Ports:** this task owns ports {{portBase}}–{{portEnd}} (also in the environment: `BOTTEGA_PORT_BASE`, `BOTTEGA_PORT_COUNT`). Bind every server you or your tests start (dev server, E2E web server, mocks) to a port in that range, not to the project's default port.
- **Databases and other shared resources:** give anything your tests create on a shared service (a database on a shared Postgres/MySQL, a Redis key prefix, a bucket, a queue) a name that ends in `_task{{taskId}}` (the task id is also in `BOTTEGA_TASK_ID`), e.g. `myapp_test_task{{taskId}}`. Create it if it doesn't exist. Never drop, migrate or reset a resource without that suffix. If the project's test setup already derives its names and ports from `BOTTEGA_TASK_ID`/`BOTTEGA_PORT_BASE`, its defaults are fine as they are.
- **Test slots:** at most {{testSlots}} task(s) of this project may run heavy test suites at once. Before a heavy run (the full test suite, end-to-end or browser suites, a production build followed by E2E), take a slot:
  ```bash
  {{tsx}} {{scriptsDir}}/test-slot.ts acquire {{taskId}}
  ```
  Run it in the foreground with the Bash tool's `timeout: 600000`. It returns as soon as a slot is free. If it exits with code 3 ("all test slots busy"), run it again; do not run the heavy suite without a slot. Once you hold a slot, running the command again renews it. Right after your last heavy run of this turn, free the slot:
  ```bash
  {{tsx}} {{scriptsDir}}/test-slot.ts release {{taskId}}
  ```
  Unit tests, typechecks, lint and single test files need no slot.
- A test that fails only when the machine is busy (timeouts, slow steps) is not a reason to raise timeouts: re-run it once while holding the slot and record both runs.
