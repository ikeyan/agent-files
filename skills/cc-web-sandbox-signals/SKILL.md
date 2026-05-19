---
name: cc-web-sandbox-signals
description: Cloud/WEB Claude Code sandbox (claude.ai/code) signaling & egress gotchas. NOT the local CLI sandbox — its egress differs (interactive per-host approval, real upstream TLS, no Anthropic MITM CA); for that use cc-cli-sandbox, do not apply these facts there. Use whenever a web/cloud session deals with external notifications, sandbox network egress, or webhook delivery — including CI result notifications ('why didn't Claude see my green CI?'), `subscribe_pr_activity` filter quirks (CI success silent, comment PATCH silent), 'Host not in allowlist' proxy errors, reachability questions for hosts like smee.io / webhook.site / httpbin.org / api.github.com, routing external events into the sandbox via GitHub as a relay, or `Monitor` setup for SSE / WebSocket streams. Trigger even when the skill isn't named — 'CI passed but nothing happened', 'sandbox can't reach X', 'how do I get a webhook into my session', 'upsert status comment silent', 'Anthropic TLS Inspection CA' are strong signals. Covers the event filter, the MITM egress allowlist, the create-then-sweep comment pattern, and Monitor streaming.
---

# Claude Code WEB sandbox: signaling and egress gotchas

> **Scope: the cloud/web sandbox (claude.ai/code).** The egress facts here — a silent TLS-inspecting MITM proxy (`O=Anthropic … TLS Inspection CA`), `Host not in allowlist` 403 bodies, the fixed reachability table — were **verified false for the local Claude Code CLI sandbox**, whose egress is instead an interactive per-host approval dialog with real upstream TLS and no MITM CA. For the local CLI sandbox use **cc-cli-sandbox**; do not apply the facts below there. (The signaling/relay/Monitor patterns are largely env-independent; the egress/proxy specifics are not.)

Context this skill captures, gathered from a long debugging run on `ikeyan/music-analyzer#15` (2026-04-23 / -24). If you're starting a fresh session and planning anything that depends on external notifications or arbitrary network egress, read this first.

## 1. `subscribe_pr_activity` only forwards a narrow slice of PR events

- **Does deliver**: CI *failure* conclusions, new PR/issue comments (`created`), PR review submissions.
- **Does NOT deliver**: CI *success* conclusions, comment *edits* (`PATCH /issues/comments/{id}` is silent for subscribers), label / status changes.
- Consequence: naive `upsert-a-status-comment` flows (create on first run, PATCH on subsequent runs) only notify the first run. Every later run is silent even though the comment is visibly updated in the GitHub UI.

### Pattern that works: create-then-sweep

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
- Relying on the subscribe_pr_activity tool itself — its filter isn't configurable from the tool side.

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

### No inbound, no tokens

- No public ingress: cannot receive arbitrary webhooks from GitHub / Slack / Stripe etc. directly. Anything that needs "external system pushes to the sandbox" has to ride on an allowlisted host.
- `GITHUB_TOKEN` / other creds are NOT in the sandbox env. The `mcp__github__*` tools have auth on the server side but don't expose a token to the session.
- `mcp__github__*` does NOT include workflow-run-log fetch. You can read PR / check-run metadata, but not step stdout. Falling back to having the user paste `gh run view --log-failed` output is often faster than fighting WebFetch.

### Pattern that works: route signals through GitHub

Use GitHub as the relay substrate (it's allowlisted):

- **CI success notifications** → PR comments (section 1).
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
