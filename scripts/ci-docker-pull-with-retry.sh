#!/usr/bin/env bash
# Only registry availability failures are retryable; bad image names/auth fail fast.
set -u -o pipefail
image="${1:?Usage: ci-docker-pull-with-retry.sh IMAGE}"
log=$(mktemp)
trap 'rm -f "$log"' EXIT
for attempt in 1 2 3; do
  if docker pull "$image" > "$log" 2>&1; then
    cat "$log"
    exit 0
  else
    status=$?
  fi
  cat "$log"
  if ! grep -Eiq '(^|[[:space:]:])(429|50[234])([[:space:]]|$)|too many requests|timeout|timed out|deadline exceeded|connection reset|temporary failure|TLS handshake|unexpected EOF' "$log"; then
    exit "$status"
  fi
  if (( attempt == 3 )); then
    echo "::error::Registry unavailable after 3 attempts pulling ${image}"
    exit "$status"
  fi
  delay=$((30 * 2 ** (attempt - 1)))
  echo "::warning::Transient registry failure; retrying ${image} in ${delay}s"
  sleep "$delay"
done
