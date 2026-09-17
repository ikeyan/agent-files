---
name: cc-web-sandbox-signals
description: Use when a Claude Code on the web (claude.ai/code) session waits for PR events or CI results, relies on subscribe_pr_activity, needs a GitHub token or CI job logs, needs an external event or webhook to reach it, cannot reach an external host (a 403 such as "Host not in allowlist", or TLS certificate errors from the egress proxy), or streams events with Monitor. Not for the local CLI sandbox (use cc-cli-sandbox).
---

# Claude Code WEB sandbox: signaling and egress gotchas

> **Scope: the cloud/web sandbox (claude.ai/code).** The egress facts here — a silent TLS-inspecting MITM proxy (`O=Anthropic … TLS Inspection CA`), `Host not in allowlist` 403 bodies, the fixed reachability table — were **verified false for the local Claude Code CLI sandbox**, whose egress is instead an interactive per-host approval dialog with real upstream TLS and no MITM CA. For the local CLI sandbox use **cc-cli-sandbox**; do not apply the facts below there. (The signaling/relay/Monitor patterns are largely env-independent; the egress/proxy specifics are not.)

If you're starting a fresh session and planning anything that depends on external notifications or arbitrary network egress, read this first.

## 1. `subscribe_pr_activity` delivers only part of PR activity

What is and is not delivered, with the measurements: `canon: facts/claude-code/subscribe-pr-activity-events`. What you need to act on:

- **Delivered**: CI failures, a CI success rollup (at most once per commit, without a conclusion), new PR/issue comments and review comments (including ones your own account wrote, so ignore your own replies), comment edits, review submissions, draft / ready / close / reopen.
- **Nothing is delivered** for a PR that PR Steward is already watching. The tool result says so: read it after subscribing, and if it does, re-read the PR and CI on a schedule instead of waiting.
- **Not delivered**: pushes, label / assignee / milestone / body changes, merge-conflict transitions.
- **So**:
  - Do not wait on a success event to learn that CI is green. Treat it as a cue to re-check the specific check you need, and read that check by the pushed commit's SHA over REST with a token: take the SHA from `git ls-remote`, read `commits/<sha>/check-runs` with the name passed as `curl --get --data-urlencode "check_name=…"` and the token on stdin (`-H @-`, not in the arguments) (every run with that name, all pages), and the matching context in `commits/<sha>/status` for CI that reports legacy commit statuses (not the top-level `state`, which is `pending` when there are no statuses even if every check run is green). Do not judge from MCP `get_check_runs`: it does not say which commit its results belong to (`canon: facts/github/github-mcp-server-pull-request-read-fields`). Nor from cc-web's `mcp__github__` `get_status`: whether it returns a `sha` is unverified. With no token, report that CI could not be confirmed.
  - Detect pushes by re-reading the PR and comparing the head SHA. Detect conflicts with `mergeable_state`.
  - Instead of polling you can have CI PATCH a status comment on every run (edits are delivered). If edits by `github-actions[bot]` turn out not to be delivered, use [create-then-sweep](create-then-sweep.md).

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
- Tokens: check the current session's env for `GH_TOKEN` / `GITHUB_TOKEN` instead of assuming; it has differed between sessions (`canon: facts/claude-code/cc-web-session-repo-scope`).
- Job logs: call `mcp__github__get_job_logs` with `run_id`, `failed_only=true` and a large `tail_lines` (`canon: facts/claude-code/subscribe-pr-activity-events`).

### Pattern that works: route signals through GitHub

Use GitHub as the relay substrate (it's allowlisted):

- **CI success** → read the specific check by SHA, or relay it through a PR comment (section 1).
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
