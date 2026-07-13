#!/usr/bin/env bash
set -euo pipefail

arch=$(uname -m)
case "$arch" in
  x86_64 | aarch64) ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y podman podman-docker uidmap slirp4netns fuse-overlayfs
fi

plugin=/usr/local/lib/docker/cli-plugins/docker-compose
if [[ ! -x "$plugin" ]]; then
  mkdir -p "$(dirname "$plugin")"
  curl -fsSL --retry 3 "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$arch" -o "$plugin"
  chmod +x "$plugin"
fi

if command -v podman >/dev/null 2>&1; then
  mkdir -p /etc/containers/registries.conf.d
  cat >/etc/containers/registries.conf.d/000-docker-io.conf <<'CONF'
unqualified-search-registries = ["docker.io"]
short-name-mode = "permissive"
CONF

  mkdir -p /etc/containers/containers.conf.d
  cat >/etc/containers/containers.conf.d/000-compose.conf <<'CONF'
[engine]
compose_providers = ["/usr/local/lib/docker/cli-plugins/docker-compose"]
CONF
fi

if [[ -f .setup-sandbox.sh ]]; then
  /bin/bash .setup-sandbox.sh
elif [[ -f package-lock.json ]]; then
  npm ci
elif [[ -f pnpm-lock.yaml ]]; then
  pnpm install --frozen-lockfile
elif [[ -f yarn.lock ]]; then
  yarn install --frozen-lockfile
elif [[ -f bun.lock ]]; then
  bun install --frozen-lockfile
fi
