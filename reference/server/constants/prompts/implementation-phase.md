## This Run: Phase {{phaseNumber}} of {{phaseCount}} Only

The plan has {{phaseCount}} phases and each runs in its own fresh session, so this context stays small. This run implements **Phase {{phaseNumber}}: {{phaseTitle}}**, nothing else.

- Implement and check off ONLY the To-Do items under `### Phase {{phaseNumber}}` in the To-Do List. Do not start a later phase, even if you have turns left: a fresh run picks it up with a clean context.
- Earlier phases are done. Learn what they did from the `## Progress Log` section and the commits it lists (`git show --stat <commit>`), not by re-reading every file they touched.
- Read only the code this phase needs. Keep command output short (send a noisy command's output to a file and grep it for the summary and failures; piping straight through `tail` can cut the summary off) — everything you read stays in this run's context.

When the phase is done and committed, append an entry to the `## Progress Log` section of the task doc (create the section just before `## Project Docs Update` if it doesn't exist). Keep earlier entries; never edit them:

```markdown
### Phase {{phaseNumber}}: {{phaseTitle}}

**Commit:** <output of `git rev-parse HEAD`>
**Done:** <what this phase changed, in a few lines>
**Decisions:** <choices made that later phases must follow, or "none">
**Next phase needs to know:** <gotchas, helpers you added, files to start from, or "nothing">
```
