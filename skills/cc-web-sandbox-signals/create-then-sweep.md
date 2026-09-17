# Create-then-sweep: relay CI results as fresh PR comments

Use this when edits to a status comment by `github-actions[bot]` are not delivered by `subscribe_pr_activity`. Post a fresh comment every time (triggers the create event) and delete previous marker'd comments afterwards:

```bash
# The token goes in as a header line on stdin, not in curl's arguments.
auth() { printf 'Authorization: Bearer %s\n' "$GH_TOKEN"; }

# Snapshot old marker'd comments BEFORE creating the new one so the
# fresh one isn't accidentally deleted.
old_ids=$(auth | curl -fsS -H @- \
  "$api/issues/$PR/comments?per_page=100" \
  | jq -r --arg m '<!-- ci-status -->' \
      '.[] | select(.body | contains($m)) | .id')

auth | curl -fsS -X POST -H @- -H 'Content-Type: application/json' \
  -d "$payload" "$api/issues/$PR/comments" -o /dev/null

for id in $old_ids; do
  auth | curl -sS -X DELETE -H @- \
    "$api/issues/comments/$id" -o /dev/null || true
done
```

Gate on all required jobs passing with a separate `needs:` job rather than per-job, so you get one notification per green PR rather than per green job:

```yaml
notify-pr-green:
  needs: [check, e2e]            # skipped automatically when any fails
  if: github.event_name == 'pull_request'
  permissions:
    pull-requests: write           # only this job needs write
  runs-on: ubuntu-24.04
  steps:
    - ...                          # curl as above
```
