#!/bin/sh
set -eu

image=${SLAB_RUNNER_SMOKE_IMAGE:-slab-runner:smoke}
port=${SLAB_RUNNER_SMOKE_PORT:-39690}
expected_codex_version=${CODEX_VERSION:-0.148.0}
suffix=${GITHUB_RUN_ID:-local}-$$
container=slab-runner-smoke-$suffix
volume=slab-runner-smoke-codex-$suffix
temporary_directory=$(mktemp -d)
token_file=$temporary_directory/runner-token
runner_token=testing-only-runner-token-0123456789abcdef

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM

printf '%s\n' "$runner_token" > "$token_file"
chmod 444 "$token_file"
docker volume create "$volume" >/dev/null

docker run --detach \
  --name "$container" \
  --publish "127.0.0.1:${port}:6990" \
  --volume "$volume:/var/lib/slab-runner/codex" \
  --mount "type=bind,src=$token_file,dst=/run/secrets/runner-token,readonly" \
  --env RUNNER_HOST=0.0.0.0 \
  --env RUNNER_TOKEN_FILE=/run/secrets/runner-token \
  "$image" >/dev/null

curl --retry 30 --retry-delay 1 --retry-all-errors -fsS \
  "http://127.0.0.1:${port}/health" >/dev/null
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/runtimes")" = "401"
test "$(curl --retry 10 --retry-delay 1 --retry-all-errors --silent --output /dev/null --write-out '%{http_code}' --header "Authorization: Bearer $runner_token" "http://127.0.0.1:${port}/runtimes")" = "200"

test "$(docker exec "$container" id -u)" = "10001"
docker exec "$container" codex --version | grep -F "codex-cli $expected_codex_version" >/dev/null
if docker exec "$container" sh -c 'command -v npm >/dev/null 2>&1 || command -v yarn >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1'; then
  echo "The production image must not include package-manager CLIs." >&2
  exit 1
fi
if docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -F "$runner_token" >/dev/null; then
  echo "The Runner token must not be stored in container environment metadata." >&2
  exit 1
fi

docker restart "$container" >/dev/null
curl --retry 30 --retry-delay 1 --retry-all-errors -fsS \
  "http://127.0.0.1:${port}/health" >/dev/null
test "$(curl --retry 10 --retry-delay 1 --retry-all-errors --silent --output /dev/null --write-out '%{http_code}' --header "Authorization: Bearer $runner_token" "http://127.0.0.1:${port}/runtimes")" = "200"

echo "Slab Runner container smoke passed."
