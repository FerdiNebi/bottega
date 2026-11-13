## Logging New Tasks

You can add new tasks to this project's board — for example, when the human wants the outcome of this conversation turned into work. **Only do this when the human asks for it in this conversation**; never log tasks on your own initiative. If you think something deserves a task, suggest it and let them decide.

1. **Write each task** as a small spec for an agent that has never seen this conversation. One task per change; split a request that bundles several.

   ```markdown
   ## Goal
   One or two sentences.

   ## Findings
   What this conversation learned: how to reproduce, what happens vs. what should happen, the cause, the files involved. Leave out secrets.

   ## References
   PRD/ARD sections, related tasks, docs.

   ## Acceptance criteria
   - …

   ## QA scenarios
   At least one exercises the change in the running app, not only through mocked unit tests.

   ## Out of scope
   - …
   ```

2. **Decide the order.** A task that needs another one's code depends on it. Dependencies are other tasks of this batch (by `key`) or existing tasks of the project (by their numeric id). Tasks are numbered by dependency level, like the initial task list: no dependencies → level 1; otherwise one more than the highest level it depends on. Autopilot runs them in that order.

3. **Show the full list first** and wait for the human to confirm, each line with its level and dependencies:

   ```
   1. Cart schema
   2. Persist the cart          (depends on: Cart schema, task #412)
   1. Checkout copy fixes       — autopilot: manual start
   ```

   Each task has two autopilot switches, both on unless the human says otherwise: `autopilotCanStart` (autopilot may start it from Pending; off = it waits until the human presses Run) and `autopilotCanWork` (autopilot may work on it at all; off = every step is manual). Adjust the list until the human confirms it.

4. **Create them.** Write the confirmed list as a JSON array to a temporary file outside the repository, then run:

   ```bash
   {{tsx}} {{scriptsDir}}/log-tasks.ts create {{taskId}} <path-to-json>
   ```

   ```json
   [
     { "key": "schema", "title": "Cart schema", "dependsOn": [], "spec": "## Goal\n…" },
     { "key": "persist", "title": "Persist the cart", "dependsOn": ["schema", 412], "spec": "…" },
     { "key": "copy", "title": "Checkout copy fixes", "dependsOn": [], "spec": "…", "autopilotCanStart": false }
   ]
   ```

   Titles get their level prefix from the script; don't number them yourself. Run the command exactly as written, from any directory, without changing `PATH` or the Node version. It prints `Created N task(s)` with their ids within seconds — that means the tasks exist; do not run it again. If it reports errors, nothing was created: fix the JSON and run it again.

5. **Report** the ids and titles. The tasks are in Pending and listed under `## Logged tasks` in this task's doc. To see them and their status later:

   ```bash
   {{tsx}} {{scriptsDir}}/log-tasks.ts list {{taskId}}
   ```
