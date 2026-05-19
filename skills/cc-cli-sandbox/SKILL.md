---
name: cc-cli-sandbox
description: Empirically-verified runtime constraints of the LOCAL Claude Code CLI OS sandbox that wraps Bash-tool commands. NOT the claude.ai/code cloud VM (cc-web-dockerd). IMPORTANT: cc-web-sandbox-signals describes a DIFFERENT environment (silent Anthropic-MITM proxy) that does NOT hold here — do not inherit its egress facts. Use when a sandboxed command misbehaves: a "network request outside sandbox" dialog, file owner shows 65534/nobody, systemctl/journalctl/docker "Operation not permitted", runtime fetch "Proxy server unreachable", a path is read-only, deciding between a sandbox-config change and dangerouslyDisableSandbox, or checking whether the current shell is in-sandbox.
---

# Claude Code CLI sandbox: verified runtime constraints

Scope: the **local** OS sandbox that wraps Bash-tool commands in the Claude Code CLI. This is not the claude.ai/code cloud VM (`cc-web-dockerd`) nor the web sandbox `cc-web-sandbox-signals` describes. Always re-verify egress/filesystem claims empirically per environment; never inherit them cross-env.

## cc-web-sandbox-signals does NOT apply here

That skill claims a silent TLS-intercepting proxy (every cert signed by an Anthropic `TLS Inspection CA`), a `Host not in allowlist` 403 body, and a fixed reachability table. Verified false here: an allowed host serves its **real upstream cert** (e.g. `github.com` → Sectigo, not an Anthropic MITM CA) and egress is an interactive approval dialog, not a silent MITM. cc-web-sandbox-signals reflects the cloud/web env only.

## Detecting whether you're in-sandbox

The sandbox itself sets a few signals that survive subshells and are independent of user shell config or other CC-level env (so they tell you "sandboxed", not just "under Claude Code"):

- `$SANDBOX_RUNTIME=1` in-sandbox; unset when `dangerouslyDisableSandbox` runs the command. Simplest detector: `[ "${SANDBOX_RUNTIME:-}" = 1 ]`.
- `/proc/self/uid_map` is the single-row `<uid> <uid> 1` mapping in-sandbox (the same uid-namespace mapping that produces the `65534`/nobody squash described in class B below) vs. the unrestricted `0 0 4294967295` outside.
- `/proc/self/mountinfo`'s root mount is `ro` in-sandbox vs. `rw` outside.

Do **not** use `$CLAUDECODE` as the discriminator — it is `1` in both cases (it signals "under Claude Code", not "sandboxed").

## First triage: policy blocker or structural blocker?

Two disjoint classes. Decide which **before** reaching for `dangerouslyDisableSandbox`: class A has a cheaper, session-persistent fix (a config edit) and keeps the sandbox on; only class B needs the sandbox off.

### A. Config-adjustable — the permission/allowlist policy is the cause

- **Filesystem writes.** Default-writable = the project working directory and `$TMPDIR`; everything else (including `/tmp` and your own dotfile dirs) is read-only, surfacing as `Read-only file system`. Fix = add the path to the sandbox's write allowlist (`sandbox.filesystem.allowWrite` in settings, or via `/sandbox`), not `dangerouslyDisableSandbox`. This even covers tools that hardcode a path and ignore `TMPDIR`/`TMP`/`TEMP` (e.g. one that `mkdir`s its own `/tmp/xxxxxx` working dir): `$TMPDIR` cannot save those, but allow-listing `/tmp` does — verified to flip such a step from failing to passing fully in-sandbox.
- **Network egress.** A request to a non-preapproved host raises a **"network request outside sandbox"** dialog (per-host allow/deny; allowed hosts get **real upstream TLS**, not a MITM CA). Fix = add the host to the `allowedHosts` allowlist (settings or `/sandbox`; `*.glob` supported). Do not enumerate hosts to "map" the list — each non-allowed host is its own dialog, so probing spams them. `curl` traverses egress; runtime-native fetch (e.g. Deno/Node built-in clients) does **not** → `error sending request … Proxy server unreachable` even with the system CA store selected. In-sandbox HTTP: use `curl`.

### B. Structural — no config knob exists

Properties of the sandbox itself, not the permission policy; no `sandbox.*` setting changes them (the write/host allowlists are orthogonal).

- **File ownership is squashed to `65534`/nobody** for `stat` in-sandbox — a uid-namespace mapping, not a permission. No setting restores real owners. `mode`, content and existence stay accurate, but every owner/gid comparison is a false positive. Owner/permission drift checkers are meaningful only unsandboxed or in the operator's real shell.
- **Unix socket / system bus.** `systemctl`/`journalctl` against the system manager → `Failed to connect to system scope bus … Operation not permitted`; `docker` → `permission denied while trying to connect to the docker API`. Not a known allowlist toggle — treat as structural.

→ For class B, retry **that one command** with `dangerouslyDisableSandbox: true`; `/sandbox` also exposes an "Unsandboxed fallback allowed" toggle.

## Sandbox-caused (not target) failure signatures

`Read-only file system` (→ A, write allowlist) · a network-approval dialog or its denial (→ A, host allowlist) · `Proxy server unreachable` from a runtime fetch (→ A, or switch to `curl`) · `Operation not permitted` on a bus/unix-socket (→ B) · `permission denied … docker API` (→ B) · owner shows `65534` (→ B, the check is only valid unsandboxed).

## Heuristic

Prefer eliminating the sandbox-incompatible dependency over fighting the sandbox: vendor fetched constants so a checker needs no network; keep secret-readers metadata-only so a non-root checker needs no privileged read. When a config edit (class A) suffices, take it rather than disabling the sandbox. Verify env-specific claims empirically — cc-web-sandbox-signals ≠ this environment.

## Persistence

Capture sandbox findings in this SKILL.md, not chat — the same behavior surprises the next session otherwise.
