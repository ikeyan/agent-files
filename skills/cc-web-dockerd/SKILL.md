---
name: cc-web-dockerd
description: Start the Docker daemon (dockerd) in Claude Code on the Web — the Anthropic-managed cloud sandbox at claude.ai/code. The docker, docker compose, and buildx CLIs are pre-installed in the cloud VM but dockerd is NOT running by default, so any docker command fails with a "Cannot connect to the Docker daemon" error or a missing docker.sock until you start it manually. Use this skill whenever Docker is needed in a cloud session — including running docker run, docker compose up, docker build, docker ps, integration tests that depend on containers, or whenever the user mentions Docker, containers, compose, or testcontainers in a claude.ai/code session. Use it proactively BEFORE the first docker command in a fresh cloud session, not only after the error appears. Do not use this skill for local Claude Code CLI sessions, the local OS-level sandbox (bubblewrap/Seatbelt), or third-party sandboxes (Docker Sandboxes, Cloudflare Sandbox SDK) — those have different daemon setup.
---

# Starting the Docker daemon in Claude Code on the Web

Claude Code on the Web (claude.ai/code) runs each session in an Anthropic-managed cloud VM (Ubuntu 24.04, root-as-default). The Docker CLI, BuildKit, and the Compose plugin are pre-installed, but **`dockerd` is not started automatically** — same convention as the bundled PostgreSQL and Redis. The unix socket at `/var/run/docker.sock` does not exist until the daemon is launched.

## Recognizing the situation

You are in this case if any of the following is true:

- `docker info` shows a populated **Client** section followed by `Server: failed to connect to the docker API at unix:///var/run/docker.sock`
- Any docker subcommand prints `Cannot connect to the Docker daemon` or `docker.sock: no such file or directory`
- `ls /var/run/docker.sock` returns "No such file or directory"
- The environment variable `CLAUDE_CODE_REMOTE` is set to `true` and you have not yet started dockerd in this session

If `docker info` returns a populated `Server:` section, the daemon is already running and you should not re-start it.

## The fix

Run `dockerd` in the background with output redirected to a log file:

```bash
sudo dockerd > /tmp/dockerd.log 2>&1 &
```

Then wait briefly for the socket to appear and verify before issuing further docker commands:

```bash
for i in {1..15}; do [ -S /var/run/docker.sock ] && break; sleep 1; done
docker info | head -5
```

Once `docker info` shows a `Server:` section, `docker run`, `docker compose up`, `docker build`, etc. work normally. Image pulls from Docker Hub, GHCR, GCR, ECR Public, and MCR are allowed under the default Trusted network policy.

### Why not `service docker start` or `systemctl`?

These are the conventional commands but they tend to fail or report misleading success in the cloud sandbox — systemd is not fully wired up the way it is on a normal Ubuntu host. Direct `dockerd` invocation bypasses the init system entirely and is the reliable path. Don't waste a turn trying `service docker start` first; go straight to the direct invocation above.

## Persisting across sessions

The cloud environment cache stores **files only, not running processes**. dockerd will not survive between sessions, so a setup script (which runs once on cache miss and then is skipped) is the wrong place. Use a **SessionStart hook** committed to the repo so it runs at the start of every session, including resumed ones.

In the repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/start-dockerd.sh"
          }
        ]
      }
    ]
  }
}
```

In the repo at `scripts/start-dockerd.sh` (chmod +x):

```bash
#!/bin/bash
# Start dockerd only in Claude Code on the Web cloud sessions.
# Local sessions are skipped — your machine already has its own daemon.

[ "$CLAUDE_CODE_REMOTE" != "true" ] && exit 0

# Idempotent: skip if already running
if [ -S /var/run/docker.sock ] && docker info >/dev/null 2>&1; then
  exit 0
fi

# Clear any stale pid file from a previous failed attempt
sudo rm -f /var/run/docker.pid

sudo dockerd > /tmp/dockerd.log 2>&1 &

# Wait up to 15s for the socket and a healthy daemon
for i in {1..15}; do
  if [ -S /var/run/docker.sock ] && docker info >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

echo "dockerd failed to start; see /tmp/dockerd.log" >&2
tail -20 /tmp/dockerd.log >&2
exit 1
```

The `CLAUDE_CODE_REMOTE` guard keeps this from interfering with local Claude Code CLI sessions, where Docker is managed by the user's OS or Docker Desktop and starting another daemon would either be redundant or harmful.

## Pre-pulling images for fast startup

Process state is not cached, but disk state is. To avoid pulling large images on every session, put pulls in the **environment setup script** (configured in the cloud environment UI, not in the repo). It runs once when the snapshot is built and the layers persist on disk:

```bash
#!/bin/bash
# Setup script — runs once per environment snapshot.
sudo dockerd > /tmp/dockerd.log 2>&1 &
for i in {1..15}; do [ -S /var/run/docker.sock ] && break; sleep 1; done
docker compose pull || true
docker compose build || true
# Daemon will be killed when this script exits; SessionStart hook restarts it.
```

This way the SessionStart hook just needs to start dockerd; images are already on disk.

## Troubleshooting

If `dockerd` exits immediately, inspect `/tmp/dockerd.log`:

- **iptables / netfilter errors** ("Failed to Setup IP tables", nf_tables not available) — start with iptables disabled. This loses container network isolation but is acceptable in a single-tenant sandbox: `sudo dockerd --iptables=false > /tmp/dockerd.log 2>&1 &`
- **overlay2 / storage driver errors** ("kernel does not support …", "driver not supported") — fall back to vfs (slower, more disk, but works in restrictive kernels): `sudo dockerd --storage-driver=vfs > /tmp/dockerd.log 2>&1 &`
- **`/var/run/docker.pid` already exists** — `sudo rm -f /var/run/docker.pid` and retry. Common after a previous failed start.
- **cgroup driver mismatch** — try `sudo dockerd --exec-opt native.cgroupdriver=cgroupfs > /tmp/dockerd.log 2>&1 &`

Combine flags as needed. A maximally permissive fallback that almost always works: `sudo dockerd --iptables=false --storage-driver=vfs --exec-opt native.cgroupdriver=cgroupfs > /tmp/dockerd.log 2>&1 &`. Use this as a last resort, not a default — it weakens isolation and slows builds.

## Cleanup

Don't kill dockerd at session end — the VM is destroyed when the session expires anyway, and there are no other tenants to protect. Stopping containers gracefully (`docker compose down`) is fine if you care about clean shutdown logs, but not required.

## Out of scope

Do not apply this skill to:

- **Local Claude Code CLI** — the user's machine has its own daemon (Docker Desktop, colima, native dockerd). Starting a second one is wrong.
- **Claude Code's local OS-level sandbox** (bubblewrap/Seatbelt) — Docker is incompatible with that sandbox by design and the standard guidance is to put `docker` in `sandbox.excludedCommands` so it runs outside the sandbox against the host daemon.
- **Docker Sandboxes, Cloudflare Sandbox SDK, or other third-party sandbox runtimes** — those provide their own preconfigured daemon; do not invoke `sudo dockerd` inside them.

The canonical signal that you are in the cloud sandbox is `CLAUDE_CODE_REMOTE=true`. When in doubt, check that variable.
