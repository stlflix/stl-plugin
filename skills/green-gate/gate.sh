#!/usr/bin/env bash
# green-gate — detect the project stack, run its checks, aggregate to GREEN/RED.
# Exit 0 = GREEN, 1 = RED. Run from anywhere inside the project.
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root" || exit 1
fail=0
ran=0

run() { # label, command...
  local label="$1"; shift
  ran=1
  echo "── $label: $*"
  if "$@"; then echo "   ✓ $label"; else echo "   ✗ $label"; fail=1; fi
}

has_script() { # dir, script
  python3 -c 'import json,sys;sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1]+"/package.json")).get("scripts",{}) else 1)' "$1" "$2" 2>/dev/null
}

for web in . web src/web; do
  [ -f "$web/package.json" ] || continue
  pm=npm; command -v pnpm >/dev/null 2>&1 && [ -f "$web/pnpm-lock.yaml" ] && pm=pnpm
  for s in typecheck lint test; do
    has_script "$web" "$s" && run "$s ($web)" bash -c "cd '$web' && $pm run $s"
  done
done

[ -f pyproject.toml ] && {
  if command -v uv >/dev/null 2>&1 && [ -f uv.lock ]; then
    run "pytest" uv run pytest -q
  elif command -v pytest >/dev/null 2>&1; then
    run "pytest" pytest -q
  fi
}

[ -f Cargo.toml ] && command -v cargo >/dev/null 2>&1 && run "cargo test" cargo test --quiet

if [ "$ran" -eq 0 ]; then
  echo "RED — no recognized checks found; verify manually before declaring done."
  exit 1
fi
[ "$fail" -eq 0 ] && { echo "GREEN — all checks passed."; exit 0; }
echo "RED — fix the failures above and re-run."; exit 1
