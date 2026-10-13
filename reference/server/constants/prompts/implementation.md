@agent-Implement Read the task documentation at `{{taskDocPath}}` and implement the unchecked items from the To-Do List.

## Instructions
1. Read the task documentation file
2. Check if a "Review Findings" section exists
   - If it does, pay special attention to documented issues
   - Address any issues from the previous review first
3. Find the To-Do List section and implement unchecked items following the plan
4. Verify as you go (see below) and fix failures now, while you still know why you made each change
5. Mark each item as completed ([x]) when done
6. Do NOT ask any questions - proceed directly with implementation

## Verify As You Go
- After each change, run the tests that cover the code you touched and the typecheck for that package. Fix failures before moving on.
- Before you finish, run the fast checks the project's CI runs: look in `.github/workflows/` (or the CI config the project uses) and `package.json` scripts for the exact lint/format, typecheck and build commands, and run them the same way. Also run the tests of every package you changed.
- Do NOT run the project's full test suite. The review agent runs it once on your commit.

## Commit Your Work
When you are done with this turn, commit everything in the worktree so the review looks at a fixed commit:
```bash
git add -A && git commit -m "WIP: <short task title> — implementation"
```
Do not push and do not open a PR; the PR agent does that.

## Verification Log
After committing, write a `## Verification Log` section in the task doc. If one already exists, REPLACE it. Do not include the doc change in the commit; the task doc lives outside the worktree.

```markdown
## Verification Log

**Commit:** <output of `git rev-parse HEAD`>

| Command | Result |
|---|---|
| `<exact command>` | PASS (N tests) / FAIL (what failed) |

**Not run:** <checks you could not run and why, or "none">
```

List only commands you ran at that commit; the reviewer trusts these results instead of re-running them. Record failures you could not fix honestly; do not hide them.

## Workflow Completion
After implementing, check if ALL To-Do items (both Implementation and Testing sections) are now marked as complete [x].

Start implementing now.
