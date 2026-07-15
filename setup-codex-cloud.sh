#!/usr/bin/env bash
# codex cloud の setup script 欄から呼ぶ:
# curl -fsSL https://raw.githubusercontent.com/ikeyan/agent-files/main/setup-codex-cloud.sh -o /tmp/setup-codex-cloud.sh && bash /tmp/setup-codex-cloud.sh
# FIXME: 現状 codex cloud はコンテナキャッシュを再利用せず毎タスク setup が走る (docs/verified-facts/codex-cloud.md)。
# 修復されたら maintenance script の要否を再検討する (キャッシュ再開時に service プロセスが残るかは未検証)
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

  # docker(shim) は API socket 不要で動くが compose provider は socket に接続する (docs/verified-facts/podman.md)
  docker_api_ready() { curl -fsS --max-time 2 --unix-socket /var/run/docker.sock http://d/_ping >/dev/null 2>&1; }
  if ! docker_api_ready; then
    # setsid: setup セッション終了時の道連れ kill を避ける
    # chroot isolation: proc を mount できない sandbox では OCI isolation の build RUN が EPERM になる (docs/verified-facts/codex-cloud.md, podman.md)
    (BUILDAH_ISOLATION=chroot setsid podman system service --time=0 >/tmp/podman-service.log 2>&1 &)
    ln -sf /run/podman/podman.sock /var/run/docker.sock
    for _ in {1..150}; do docker_api_ready && break; sleep 0.1; done
    docker_api_ready || { echo "podman system service not ready:" >&2; tail /tmp/podman-service.log >&2; }
  fi
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
