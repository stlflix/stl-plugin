#!/usr/bin/env bash
# atomic-commit — validate a Conventional Commits subject line.
# Usage: check-msg.sh "feat(scope): summary"   Exit 0 = valid, 1 = invalid.
set -uo pipefail

msg="${1:-}"
subject="${msg%%$'\n'*}"
types='feat|fix|refactor|docs|test|chore|build|perf|style|ci|revert'

[ -z "$subject" ] && { echo "✗ empty message"; exit 1; }

if ! printf '%s' "$subject" | grep -qE "^(${types})(\([a-z0-9._-]+\))?!?: .+"; then
  echo "✗ not Conventional Commits: '$subject'"
  echo "  expected: type(scope): summary   (types: ${types//|/, })"
  exit 1
fi
len=${#subject}
if [ "$len" -gt 72 ]; then
  echo "✗ subject too long ($len > 72): '$subject'"
  exit 1
fi
case "$subject" in
  *.) echo "✗ subject ends with a period"; exit 1;;
esac
echo "✓ valid Conventional Commits subject ($len chars)"
exit 0
