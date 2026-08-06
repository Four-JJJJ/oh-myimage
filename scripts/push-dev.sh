#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REMOTE_ALIAS="${REMOTE_ALIAS:-token-new}"
REMOTE_BASE_DIR="${REMOTE_BASE_DIR:-/opt/oh-myimage-dev}"
REMOTE_ENV_FILE="${REMOTE_ENV_FILE:-/etc/oh-myimage-dev/oh-myimage-dev.env}"
REMOTE_COMPOSE_FILE="${REMOTE_COMPOSE_FILE:-deploy/docker-compose.oh-myimage-dev.yml}"
REMOTE_PROJECT="${REMOTE_PROJECT:-oh-myimage-dev}"
REMOTE_URL="${REMOTE_URL:-https://dev-gen.fourj.space}"
ARCHIVE_NAME="${ARCHIVE_NAME:-oh-myimage-dev-release.tar.gz}"
RELEASE_NAME="${RELEASE_NAME:-dev-$(date +%Y%m%d%H%M%S)}"
DRY_RUN="${DRY_RUN:-0}"
SKIP_TESTS="${SKIP_TESTS:-0}"
TEST_ARGS="${TEST_ARGS:-}"
REBUILD_IMAGE="${REBUILD_IMAGE:-0}"

RELEASE_DIR="${REMOTE_BASE_DIR}/releases/${RELEASE_NAME}"
CURRENT_LINK="${REMOTE_BASE_DIR}/current"
REMOTE_ARCHIVE_PATH="${RELEASE_DIR}/${ARCHIVE_NAME}"

FILES_TO_PACKAGE=(
  "dist"
  "dist-node"
  "src"
  "migrations"
  "deploy"
  "public"
  "index.html"
  "Dockerfile"
  ".dockerignore"
  "postcss.config.js"
  "tailwind.config.ts"
  "tsconfig.json"
  "vite.config.ts"
  "package.json"
  "package-lock.json"
)

run() {
  printf '+ %s\n' "$*"
  if [[ "$DRY_RUN" != "1" ]]; then
    "$@"
  fi
}

run_shell() {
  printf '+ %s\n' "$*"
  if [[ "$DRY_RUN" != "1" ]]; then
    bash -lc "$*"
  fi
}

require_file() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    printf 'Missing required path: %s\n' "$path" >&2
    exit 1
  fi
}

cleanup() {
  if [[ "$DRY_RUN" != "1" ]]; then
    rm -f "$ARCHIVE_NAME"
  fi
}

trap cleanup EXIT

require_file "package.json"

printf 'Preparing dev release: %s\n' "$RELEASE_NAME"
printf 'Target: %s -> %s\n' "$REMOTE_ALIAS" "$REMOTE_URL"

run git status --short
run npm run build
for path in "${FILES_TO_PACKAGE[@]}"; do
  require_file "$path"
done

if [[ "$SKIP_TESTS" != "1" && -n "$TEST_ARGS" ]]; then
  run_shell "npm exec vitest run ${TEST_ARGS}"
fi

run tar -czf "$ARCHIVE_NAME" "${FILES_TO_PACKAGE[@]}"

run ssh "$REMOTE_ALIAS" "mkdir -p ${RELEASE_DIR}"
run scp "$ARCHIVE_NAME" "${REMOTE_ALIAS}:${REMOTE_ARCHIVE_PATH}"
run ssh "$REMOTE_ALIAS" "cd ${RELEASE_DIR} && tar -xzf ${ARCHIVE_NAME} && rm -f ${ARCHIVE_NAME}"
if [[ "$REBUILD_IMAGE" != "1" ]]; then
  run ssh "$REMOTE_ALIAS" "if [[ -f ${CURRENT_LINK}/package-lock.json ]] && ! cmp -s ${RELEASE_DIR}/package-lock.json ${CURRENT_LINK}/package-lock.json; then printf 'package-lock.json changed; set REBUILD_IMAGE=1 to rebuild the dev image before restarting containers.\\n' >&2; exit 1; fi"
fi
run ssh "$REMOTE_ALIAS" "ln -sfn ${RELEASE_DIR} ${CURRENT_LINK}"
if [[ "$REBUILD_IMAGE" == "1" ]]; then
  run ssh "$REMOTE_ALIAS" "cd ${CURRENT_LINK} && docker compose -p ${REMOTE_PROJECT} --env-file ${REMOTE_ENV_FILE} -f ${REMOTE_COMPOSE_FILE} build oh-myimage-dev-api"
fi
run ssh "$REMOTE_ALIAS" "cd ${CURRENT_LINK} && docker compose -p ${REMOTE_PROJECT} --env-file ${REMOTE_ENV_FILE} -f ${REMOTE_COMPOSE_FILE} run --rm oh-myimage-dev-api npm run db:migrate:postgres"
run ssh "$REMOTE_ALIAS" "cd ${CURRENT_LINK} && docker compose -p ${REMOTE_PROJECT} --env-file ${REMOTE_ENV_FILE} -f ${REMOTE_COMPOSE_FILE} up -d --force-recreate oh-myimage-dev-api oh-myimage-dev-worker"

run_shell "curl -s ${REMOTE_URL}/ | grep -o 'assets/index-[^\\\" ]*\\.js' | head -n 1"
run curl -s "${REMOTE_URL}/api/config"
run ssh "$REMOTE_ALIAS" "readlink -f ${CURRENT_LINK}"
run_shell "ssh ${REMOTE_ALIAS} \"docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' | grep oh-myimage-dev\""

printf '\nBrowser acceptance URL:\n%s/?preview=off\n' "$REMOTE_URL"
