First make sure the PR doesn't conflict with its base branch. GitHub does not run CI on a conflicting PR, so its checks would stay pending forever:
```bash
gh pr view --json mergeable --jq .mergeable
```
If it prints `CONFLICTING`, go straight to the merge-conflict check below. Otherwise wait for CI with this exact command, as ONE Bash call:
```bash
sha=$(git rev-parse HEAD)
for i in 1 2 3 4 5 6; do ids=$(gh run list --commit "$sha" --json databaseId --jq '.[].databaseId'); [ -n "$ids" ] && break; sleep 10; done
if [ -z "$ids" ]; then echo "CI: none"; exit 0; fi
sleep 15; end=$((SECONDS + 480))
while :; do pending=$(gh run list --commit "$sha" --json status --jq '[.[] | select(.status != "completed")] | length'); { [ "$pending" = 0 ] || [ $SECONDS -ge $end ]; } && break; sleep 20; done
gh run list --commit "$sha" --json name,status,conclusion,databaseId --jq '.[] | [.name, .status, .conclusion, .databaseId] | @tsv'
if [ "$pending" != 0 ]; then echo "CI: still running"; exit 0; fi
failed=$(gh run list --commit "$sha" --json conclusion --jq '[.[] | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral")] | length')
[ "$failed" = 0 ] && echo "CI exit code: 0" || echo "CI exit code: 1"
```
Run it in the foreground with the Bash tool's `timeout: 600000`. Do NOT use `run_in_background`: nothing wakes you when a background command finishes, and ending your turn ends this run. The command returns within 10 minutes. If it prints `CI: still running`, run the same command again, at most 3 times in total (about 30 minutes); after that, report that CI is still pending and stop.

The command already waits for the runs, so do NOT write your own polling or `sleep` loop, and do NOT parse JSON with `python`/`python3` or `jq` (they may not exist on this machine); use `gh`'s built-in `--jq` instead. If the repository's CI is not GitHub Actions (no runs ever appear but the PR page shows checks), use `gh pr checks --watch --fail-fast` instead, also in the foreground with `timeout: 600000`.

**Handle the result:**

**If the output says `CI: none`:** the repository has no CI. Treat it as PASSED.

**If PASSED** (`CI exit code: 0`):
Proceed to the merge-conflict check below before completing.

**If FAILED** (`CI exit code: 1`):
1. Get failure details: `gh run view <run-id> --log-failed` for each failed run listed above
2. Analyze what's causing the failures (test failures, build errors, lint issues)
3. Fix the issues in the codebase
4. Commit and push: `git add -A && git commit -m "Fix CI: <description>" && git push`
5. Wait for CI again with the command above (max 10 fix iterations)

**If max iterations reached:**
- Document the persistent failures
- Stop and let the user investigate
