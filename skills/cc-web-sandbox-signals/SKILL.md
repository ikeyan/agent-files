---
name: cc-web-sandbox-signals
description: Cloud/WEB Claude Code sandbox (claude.ai/code) signaling & egress gotchas. NOT the local CLI sandbox — its egress differs (interactive per-host approval, real upstream TLS, no Anthropic MITM CA); for that use cc-cli-sandbox, do not apply these facts there. Use whenever a web/cloud session deals with external notifications, sandbox network egress, or webhook delivery — including CI result notifications ('why didn't Claude see my green CI?'), `subscribe_pr_activity` filter quirks (CI success only once per commit, no push or merge-conflict events), 'Host not in allowlist' proxy errors, reachability questions for hosts like smee.io / webhook.site / httpbin.org / api.github.com, routing external events into the sandbox via GitHub as a relay, or `Monitor` setup for SSE / WebSocket streams. Trigger even when the skill isn't named — 'CI passed but nothing happened', 'sandbox can't reach X', 'how do I get a webhook into my session', 'Anthropic TLS Inspection CA' are strong signals. Covers the event filter, the MITM egress allowlist, the create-then-sweep comment pattern, and Monitor streaming.
---

# Claude Code WEB sandbox: signaling and egress gotchas

> **Scope: the cloud/web sandbox (claude.ai/code).** The egress facts here — a silent TLS-inspecting MITM proxy (`O=Anthropic … TLS Inspection CA`), `Host not in allowlist` 403 bodies, the fixed reachability table — were **verified false for the local Claude Code CLI sandbox**, whose egress is instead an interactive per-host approval dialog with real upstream TLS and no MITM CA. For the local CLI sandbox use **cc-cli-sandbox**; do not apply the facts below there. (The signaling/relay/Monitor patterns are largely env-independent; the egress/proxy specifics are not.)

Context this skill captures, gathered from a long debugging run on `ikeyan/music-analyzer#15` (2026-04-23 / -24). If you're starting a fresh session and planning anything that depends on external notifications or arbitrary network egress, read this first.

## 1. `subscribe_pr_activity` only forwards a narrow slice of PR events

Measured on `ikeyan/agent-files#13` on 2026-09-16/17; details in `canon: facts/claude-code/subscribe-pr-activity-events`.

- **Does deliver**:
  - CI *failures*, as `check_run.completed`, once per failing check run and again on every repeat failure.
  - CI *success*, as a `check_suite.completed` rollup, **only once per `head_sha`** (measured on a repo with a single check suite; repos with several suites are unmeasured). The payload has no `conclusion`.
  - New PR/issue comments (`created`), per the 2026-04 observation. On 2026-09-16 new review-comment replies (`pull_request_review_comment.created`) written by your own account from another session were delivered too; a new plain issue comment was not exercised.
  - Comment *edits*, as `issue_comment.edited` (observed since 2026-09-12; before that, `PATCH /issues/comments/{id}` was silent).
  - PR review submissions, plus one `pull_request_review_comment.created` per inline finding.
  - Draft, ready-for-review, closed and reopened transitions. Only closing without merging was measured; whether a merge is delivered is unmeasured.
- **Does NOT deliver**: pushes (`synchronize`), label / assignee / milestone / body changes, merge-conflict transitions (the harness instructions say conflicts are notified; they were not), and any later green on a `head_sha` whose success had already been delivered, whether from a rerun or from a push back to that SHA (a first green after a failure on a `head_sha` is unmeasured).
- Consequences:
  - Do not wait on a success event to learn that CI is green. `check_suite.completed` has no `conclusion` and is only a cue to re-check the specific check you need: read that check by commit SHA over REST with a token (`commits/<sha>/check-runs?check_name=…`, every run with that name, all pages; `commits/<sha>/status` for CI that reports legacy commit statuses), taking the SHA you pushed from `git ls-remote`. MCP's `get_check_runs` cannot confirm the pushed commit: its results carry no commit SHA and can be the previous commit's runs right after a push, and cc-web's `get_status` returned no `sha`. If there is no token, report that CI could not be confirmed. Do not use the combined status's top-level `state` (it is `pending` when there are no statuses, even when every check run is green). The event does not cover legacy statuses, is not sent again for a SHA whose success was already delivered (a rerun, or a push back to it), and is unmeasured for a first green after a failure on the same SHA.
  - Instead of polling you can have CI PATCH a status comment on every run (edits are delivered). Whether an edit by `github-actions[bot]` is delivered has not been measured; if it is not, fall back to create-then-sweep below.
  - Detect pushes by re-reading the PR and comparing the head SHA. The `head_sha` of CI events is only a hint: a push that runs no CI, or a push back to a SHA whose success was already delivered, sends no event. Detect conflicts with `mergeable_state`.

### Fallback: create-then-sweep

Post a fresh comment every time (triggers the create event) and delete previous marker'd comments afterwards:

```bash
# Snapshot old marker'd comments BEFORE creating the new one so the
# fresh one isn't accidentally deleted.
old_ids=$(curl -fsS -H "Authorization: Bearer $GH_TOKEN" \
  "$api/issues/$PR/comments?per_page=100" \
  | jq -r --arg m '<!-- ci-status -->' \
      '.[] | select(.body | contains($m)) | .id')

curl -fsS -X POST -H "Authorization: Bearer $GH_TOKEN" -H 'Content-Type: application/json' \
  -d "$payload" "$api/issues/$PR/comments" -o /dev/null

for id in $old_ids; do
  curl -sS -X DELETE -H "Authorization: Bearer $GH_TOKEN" \
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

### What NOT to bother with

- Adding a dummy always-failing check to coerce a notification (noisy, breaks branch protection).
- Trying to configure what subscribe_pr_activity delivers — its filter isn't configurable from the tool side. Use it for what it delivers and cover the gaps in section 1 yourself.

## 2. The sandbox has a MITM egress allowlist

Outbound HTTPS is proxied through a TLS-intercepting gateway. You can see the proxy because every cert is signed by `O=Anthropic; CN=sandbox-egress-production TLS Inspection CA`.

### What's reachable

Verified by probing from the sandbox:

| Host                              | Status                    |
| --------------------------------- | ------------------------- |
| `api.github.com`                  | reachable (public, rate-limited to 60/hr anonymous) |
| `github.com` / `raw.githubusercontent.com` | reachable             |
| `registry.npmjs.org`              | reachable                 |
| `nodejs.org`, `binaries.prisma.sh`| reachable                 |
| `smee.io`                         | **403 "Host not in allowlist"** |
| `webhook.site`, `httpbin.org`     | **403 "Host not in allowlist"** |
| `example.com`, `cloudflare.com`   | **403 "Host not in allowlist"** |

Distinguish proxy rejection from target rejection by reading the body: `"Host not in allowlist"` is the proxy. A JSON error body with a `message` field is the target.

### No inbound; tokens vary by session

- No public ingress: cannot receive arbitrary webhooks from GitHub / Slack / Stripe etc. directly. Anything that needs "external system pushes to the sandbox" has to ride on an allowlisted host.
- Tokens: in the 2026-04 sessions no GitHub token was in the env. In a 2026-09-16 session the env had `GH_TOKEN` and `GITHUB_TOKEN` set, and `git push --dry-run` to the session's repo passed over HTTPS via `GIT_ASKPASS`; a real push to a protected ref is untested (`canon: facts/claude-code/cc-web-session-repo-scope`). Check the env of the current session instead of assuming either.
- Job logs: `mcp__github__get_job_logs` exists (2026-09-16). Call it with `run_id`, `failed_only=true` and a large `tail_lines`; with `job_id` and a small `tail_lines` you only see post-job cleanup. `get_check_run` returns the name, conclusion and URLs, but its `output` title / summary / text are empty for Actions jobs that write no annotations.

### Pattern that works: route signals through GitHub

Use GitHub as the relay substrate (it's allowlisted):

- **CI success** → poll the specific check you need, or relay it through a PR comment (section 1). Success events are only a cue to re-check.
- **External event → sandbox** → write it to an issue comment / gist from whatever source triggers it, poll from the sandbox via `mcp__github__*` or `curl api.github.com`.
- **Sandbox → external** → only if there's a GitHub-mediated hop.

## 3. `Monitor` tool notes, for streaming sources

Monitor treats every stdout line as a conversation event. It's the right tool for SSE / WebSocket / tail-f bridges:

- SSE via `curl -N --no-buffer`
- WebSocket via a Bun one-liner:

  ```ts
  // ws-to-lines.ts
  const ws = new WebSocket(process.argv[2]!);
  ws.addEventListener("message", (e) => console.log(String(e.data)));
  ws.addEventListener("close", () => process.exit(0));
  ws.addEventListener("error", (e) => { console.error(e); process.exit(1); });
  ```

- Line-buffer everything (`grep --line-buffered`) or events arrive in large batches when pipe buffering kicks in.

But `Monitor` doesn't help you if the host is blocked by the egress allowlist (section 2) — test the URL with `curl` first.

## 4. Persistence across sessions

Learnings from these facts don't survive unless captured. Put them here (SKILL.md) or in the repo's `CLAUDE.md`, not in chat-only recollection — the same sandbox behaviour will surprise the next session otherwise.
