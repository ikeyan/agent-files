---
name: cc-cli-sandbox
description: >
  Empirically-verified runtime constraints of the LOCAL Claude Code CLI OS
  sandbox that wraps Bash-tool commands. NOT the claude.ai/code cloud VM
  (that is cc-web-dockerd). IMPORTANT: cc-web-sandbox-signals describes a
  DIFFERENT environment (silent Anthropic-MITM proxy) that does NOT hold for
  cc-cli — do not inherit its egress facts here. Use when a sandboxed command
  misbehaves: a "network request outside sandbox" dialog, file owner shows
  65534/nobody, systemctl/journalctl/docker "Operation not permitted",
  runtime fetch "Proxy server unreachable", /tmp read-only, or deciding when
  to retry with dangerouslyDisableSandbox.
---

# Claude Code CLI sandbox: verified runtime constraints

Scope: the **local** OS sandbox around Bash-tool commands (this session's env).
Web cloud sandbox → `cc-web-dockerd`. Every fact below was probed in cc-cli.

## cc-web-sandbox-signals does NOT apply here

`cc-web-sandbox-signals` claims a silent TLS-intercepting proxy (every cert signed
`O=Anthropic; CN=sandbox-egress-production TLS Inspection CA`), a `Host not in
allowlist` 403 body, and a fixed reachability table. **Verified false in
cc-cli**: `github.com` serves its real upstream cert
(`O=Sectigo`), and egress is an interactive approval dialog, not a silent
MITM. cc-web-sandbox-signals reflects the cloud/web env. Always re-verify
egress claims empirically per environment; never inherit cross-env.

## Egress = interactive per-host approval

- A sandboxed command's network request to a non-preapproved host raises a
  **"network request outside sandbox"** dialog; the user allows/denies per
  host. Denied → the request fails.
- A preconfigured `allowedHosts` list (project `.claude/settings.json`
  sandbox / `/sandbox`) passes **without prompt and with real upstream TLS**
  (no MITM CA). Observed list shape: `github.com, *.npmjs.org, <project
  hosts>`. `*.glob` patterns supported.
- **Do not enumerate hosts to "map" the allowlist** — every non-allowed host
  is a separate user dialog; probing a list spams them.
- `curl` to an allowed host works. `deno` / runtime-native fetch do **not**
  traverse this path → `error sending request ... Proxy server unreachable`
  even with `--allow-env` + `DENO_TLS_CA_STORE=system`. In-sandbox HTTP: use
  `curl`; don't fight runtime proxy/CA.

## Filesystem

- Writes are path-allowlisted: repo cwd and `$TMPDIR` writable; **`/tmp` is
  read-only** ("Read-only file system") — always use `$TMPDIR`.
- Paths you own but outside the allowlist are read-only to Bash (e.g. `rm`
  under `~/.claude/...`); the Write/Edit tools reach more than Bash.
- **File ownership is squashed to `65534` (nobody/nogroup)** for `stat`
  in-sandbox. Owner/gid diffs are all false-positive; `mode`, content,
  existence stay accurate. Trust owner/gid only unsandboxed.

## Unix sockets / system bus blocked

`systemctl`/`journalctl` on system units → `Failed to connect to system scope
bus ... Operation not permitted`. `docker` → `permission denied while trying
to connect to the docker API`. Need `dangerouslyDisableSandbox`.

## Decision rule

Sandbox-caused (not target) signatures: network-approval denied · `Operation
not permitted` on a bus/unix-socket · `permission denied ... docker API` ·
`Proxy server unreachable` · `/tmp` `Read-only file system`.

→ Retry **that one command** with `dangerouslyDisableSandbox: true`.
`/sandbox` manages `allowedHosts` and an "Unsandboxed fallback allowed"
toggle. Owner-sensitive read-only checks (e.g. `deno task …:sync`) give
trustworthy output only unsandboxed or in the operator's real shell.

## Heuristic

Eliminate the sandbox-incompatible dependency rather than fight the sandbox:
vendor fetched constants so a checker needs no network; keep secret-readers
metadata-only so a non-root checker needs no privileged read. Verify
env-specific claims empirically — cc-web-sandbox-signals ≠ cc-cli.

## Persistence

Capture sandbox findings here (SKILL.md), not chat — they resurface every
session otherwise.
