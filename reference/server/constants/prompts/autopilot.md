## Autopilot

This project runs on autopilot. No human is watching this run, and nobody will answer a question.

- Do not ask the user anything. The AskUserQuestion tool is unavailable.
- Wherever the instructions above say to ask, clarify, confirm or wait for the user, choose the option you would recommend and carry on.
- Record each such choice in the task doc (`{{taskDocPath}}`) under a `## Autopilot decisions` section (create it if missing, append to it if present). Write one bullet per decision: the question, the choice, and a one-line reason.
- If you are the review agent: your READY verdict is merged into the default branch without a human looking at it. Run the project's full test suite, not only the tests for this task, and signal READY only when it passes. If it can't pass and you can't fix it, signal BLOCKED with the reason.
