#!/usr/bin/env bash
#
# Move every collaborator database from the old cluster to the BuildLoop one,
# and only then take the old one down (BL-08, BL-09).
#
# The order is the whole point: the new cluster comes up on a port of its own,
# everything is restored into it, the row counts of both sides are compared, and
# NOTHING is removed until that comparison exits 0. If it does not, the old
# stack is still serving and the operator has lost nothing but time.
#
# Idempotent: re-running after a failure restores over what is already there.
set -euo pipefail

OLD_URL="${OLD_URL:-postgres://supabase_admin:${OLD_PASSWORD:?OLD_PASSWORD is required}@127.0.0.1:5433/postgres}"
OLD_COMPOSE="${OLD_COMPOSE:-/home/ubuntu/supabase-ops/supabase/docker/docker-compose.yml}"
STACK_DIR="${STACK_DIR:-/home/ubuntu/buildloop}"
NEW_PORT="${NEW_PORT:-5434}"
FINAL_PORT="${FINAL_PORT:-5433}"
MCP_URL="${MCP_URL:-http://127.0.0.1:8200}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

step() { printf '\n=== %s\n' "$*"; }

require() {
  local name
  for name in "$@"; do
    command -v "$name" >/dev/null || { echo "missing command: $name" >&2; exit 1; }
  done
}

require docker node pg_dump pg_dumpall pg_restore psql curl

# shellcheck disable=SC1091
set -a; . "${STACK_DIR}/.env"; set +a
NEW_URL="postgres://buildloop_admin:${POSTGRES_PASSWORD:?the stack .env has no POSTGRES_PASSWORD}@127.0.0.1:${NEW_PORT}/postgres"

step "reading the collaborators from the old registry"
mapfile -t SLUGS < <(psql "$OLD_URL" -Atc "SELECT slug FROM stl_mcp.collaborators ORDER BY slug")
echo "${#SLUGS[@]} collaborator(s): ${SLUGS[*]:-none}"

step "bringing the new cluster up on ${NEW_PORT}"
( cd "$STACK_DIR" && DB_PORT_HOST="$NEW_PORT" docker compose up -d db )
until psql "$NEW_URL" -Atc 'SELECT 1' >/dev/null 2>&1; do sleep 2; done
echo "new cluster answering on ${NEW_PORT}"

step "restoring the roles"
# Only ours: the old cluster's own service roles do not exist in the new one and
# must not be invented there.
{
  echo "stl_collaborator"
  printf '%s\n' "${SLUGS[@]}"
} > /tmp/buildloop-roles.txt
pg_dumpall --roles-only --no-role-passwords -d "$OLD_URL" \
  | grep -E "$(paste -sd'|' /tmp/buildloop-roles.txt)" \
  | psql "$NEW_URL" -v ON_ERROR_STOP=0 || true

step "restoring each collaborator database"
for slug in "${SLUGS[@]}"; do
  echo "--- db_${slug}"
  psql "$NEW_URL" -Atc "SELECT 1 FROM pg_database WHERE datname = 'db_${slug}'" | grep -q 1 \
    || psql "$NEW_URL" -c "CREATE DATABASE db_${slug}"
  pg_dump -Fc "${OLD_URL%/postgres}/db_${slug}" \
    | pg_restore --no-owner --role="${slug}" --dbname="${NEW_URL%/postgres}/db_${slug}" --clean --if-exists
done

step "restoring the stl_mcp registry"
pg_dump -Fc --schema=stl_mcp "$OLD_URL" | pg_restore --no-owner --dbname="$NEW_URL" --clean --if-exists

step "comparing the row counts of both clusters"
DATABASES=()
for slug in "${SLUGS[@]}"; do DATABASES+=("db_${slug}"); done
# Exits non-zero on the first divergence, and `set -e` stops the script here:
# nothing below this line has run yet, so nothing has been removed.
node "${SCRIPT_DIR}/compare-counts.mjs" "$OLD_URL" "$NEW_URL" postgres "${DATABASES[@]}"

step "upgrading each database to the current provisioning plan"
for slug in "${SLUGS[@]}"; do
  curl -fsS -X POST "${MCP_URL}/admin/collaborators/${slug}/upgrade" \
    -H "X-Admin-Key: ${MCP_ADMIN_KEY:?the stack .env has no MCP_ADMIN_KEY}" \
    -H 'Content-Type: application/json' -d '{}' >/dev/null
  echo "--- ${slug} upgraded"
done

step "cutting over: the new cluster takes port ${FINAL_PORT}"
# Without DB_PORT_HOST the compose default is ${FINAL_PORT} again.
( cd "$STACK_DIR" && docker compose down db && docker compose up -d )

step "taking the old stack down"
docker compose -f "$OLD_COMPOSE" down
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^supabase/' | xargs -r docker image rm

cat <<'DONE'

=== done
The old VOLUME was preserved on purpose: remove it by hand after seven days of
the new stack serving, and not before.

    docker volume ls | grep supabase
DONE
