#!/usr/bin/env bash
# Ephemeral GitHub runner only. Preserve daemon settings and retain Docker Hub
# fallback. Google documents this public Docker Hub cache at:
# https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images
set -euo pipefail
config=$(mktemp)
trap 'rm -f "$config"' EXIT
if sudo test -f /etc/docker/daemon.json; then
  sudo cat /etc/docker/daemon.json > "$config"
else
  echo '{}' > "$config"
fi
jq '."registry-mirrors" = (["https://mirror.gcr.io"] + (."registry-mirrors" // []) | unique)' "$config" > "${config}.new"
sudo install -m 0644 "${config}.new" /etc/docker/daemon.json
rm -f "${config}.new"
sudo systemctl restart docker
docker info --format '{{json .RegistryConfig.Mirrors}}'
