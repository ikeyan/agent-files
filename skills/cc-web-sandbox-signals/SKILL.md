---
name: cc-web-sandbox-signals
description: Use when a Claude Code on the web (claude.ai/code) session waits for PR events or CI results, relies on subscribe_pr_activity, needs a GitHub token or CI job logs, needs an external event or webhook to reach it, cannot reach an external host (a 403 such as "Host not in allowlist", or TLS certificate errors from the egress proxy), or streams events with Monitor. Not for the local CLI sandbox (use cc-cli-sandbox).
---

# Claude Code WEB sandbox: signaling and egress gotchas

Scope: claude.ai/code only. The local CLI sandbox behaves differently; use cc-cli-sandbox there.

## 1. `subscribe_pr_activity` delivers only part of PR activity

What is and is not delivered, with the measurements: `canon: facts/claude-code/subscribe-pr-activity-events`. What you need to act on:

- **Delivered**: CI failures, a CI success rollup (at most once per commit, without a conclusion), new PR/issue comments and review comments (including ones your own account wrote, so ignore your own replies), comment edits, review submissions, draft / ready / close / reopen.
- **Nothing is delivered** for a PR that PR Steward is already watching. The tool result says so: read it after subscribing, and if it does, re-read the PR and CI on a schedule instead of waiting.
- **Not delivered**: pushes, label / assignee / milestone / body changes, merge-conflict transitions.
- **So**:
  - Do not wait on a success event to learn that CI is green. Treat it as a cue to re-check the specific check you need, and read that check by the pushed commit's SHA over REST with a token: take the SHA from `git ls-remote`, read `commits/<sha>/check-runs` with the name passed as `curl --get --data-urlencode "check_name=…"` and the token as a header line on stdin, not in the arguments (`printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -H @- …`; `-H @-` silently drops a line without a colon, so never pipe the bare token) (every run with that name, all pages), and the matching context in `commits/<sha>/status` for CI that reports legacy commit statuses (not the top-level `state`, which is `pending` when there are no statuses even if every check run is green). Do not judge from MCP `get_check_runs`: it does not say which commit its results belong to (`canon: facts/github/github-mcp-server-pull-request-read-fields`). Nor from cc-web's `mcp__github__` `get_status`: whether it returns a `sha` is unverified. With no token, report that CI could not be confirmed.
  - Detect pushes by re-reading the PR and comparing the head SHA. Detect conflicts with `mergeable_state`.
  - Instead of polling you can have CI PATCH a status comment on every run (edits are delivered). If edits by `github-actions[bot]` turn out not to be delivered, use [create-then-sweep](create-then-sweep.md).

## 2. Network egress

Outbound HTTPS goes through a TLS-inspecting proxy with a per-environment host allowlist, and nothing can connect into the session (`canon: facts/claude-code/cc-web-egress-proxy`).

- Before depending on a host, probe it with `curl`. A 403 whose body is `Host not in allowlist` comes from the proxy: the host is blocked for this environment, and only the environment settings in the web UI can allow it. Any other error body comes from the target.
- TLS certificate errors naming `O=Anthropic; CN=sandbox-egress-production TLS Inspection CA` come from the proxy.
- Tokens: check the current session's env for `GH_TOKEN` / `GITHUB_TOKEN` before relying on one; it differs between sessions.
- Job logs: call `mcp__github__get_job_logs` with `run_id`, `failed_only=true` and a large `tail_lines`.

### Route signals through GitHub

External systems cannot push into the session, so relay through GitHub:

- **CI success** → read the specific check by SHA, or relay it through a PR comment (section 1).
- **External event → session** → have the source write an issue comment or gist, and poll it from the session via `mcp__github__*` or `curl api.github.com`.
- **Session → external** → go through a GitHub-mediated hop.

## 3. `Monitor` for streaming sources

Monitor turns every stdout line into a conversation event. Use it for SSE, WebSocket and tail-f bridges:

- SSE: `curl -N --no-buffer`.
- WebSocket: [ws-to-lines.ts](ws-to-lines.ts), run with Bun.
- Line-buffer every stage (`grep --line-buffered`), or events arrive in large batches.
- Probe the URL with `curl` first (section 2).
