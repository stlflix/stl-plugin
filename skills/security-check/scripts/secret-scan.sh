#!/usr/bin/env bash
# security-check — deterministic secret / .env scan over a diff.
# Usage: secret-scan.sh [base-ref]
#   no arg   → working tree + index vs HEAD
#   base-ref → base...HEAD (whole branch)
# Exit 0 clean · 1 warnings · 2 BLOCK (secret or tracked .env)
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not a git repo"; exit 1; }
cd "$root" || exit 1
base="${1:-}"
status=0

if [ -n "$base" ]; then
  git rev-parse --verify --quiet "$base" >/dev/null || { echo "SCAN ERROR — unknown base ref '$base' (try origin/main)"; exit 1; }
  files="$(git diff --name-only --diff-filter=ACMR "$base"...HEAD)"
  diff_cmd=(git diff "$base"...HEAD)
else
  files="$( { git diff --name-only --diff-filter=ACMR HEAD; git ls-files --others --exclude-standard; } | sort -u)"
  diff_cmd=(bash -c 'git diff HEAD; git ls-files --others --exclude-standard -z | xargs -0 -I{} git diff --no-index /dev/null {} 2>/dev/null')
fi

# 1. env / key files in the change set (block)
echo "$files" | grep -E '(^|/)\.env($|\.)|\.(pem|key|p12)$|credentials\.json$|service-account.*\.json$' | grep -vE '\.env\.(example|template|sample)$' | while read -r f; do
  echo "BLOCK  $f — env/key file in the change set"
done | tee /tmp/stl-secret-scan.block
[ -s /tmp/stl-secret-scan.block ] && status=2

# 2. secret patterns in added lines (block)
patterns='AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{20,}|sk_(live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|(postgres(ql)?|mysql|mongodb(\+srv)?|redis)://[^:/\s]+:[^@\s]+@|service_role[^\n]{0,20}[:=][^\n]{0,10}eyJ|(SUPABASE_SERVICE_ROLE_KEY|FIRECRAWL_API_KEY|VERCEL_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*[:=]\s*["'\''"]?[A-Za-z0-9_-]{16,}'
"${diff_cmd[@]}" 2>/dev/null | grep -nE '^\+' | grep -vE '^\+\+\+' | grep -E "$patterns" | sed 's/^/BLOCK  +/' | cut -c1-200 | tee /tmp/stl-secret-scan.pat
[ -s /tmp/stl-secret-scan.pat ] && status=2

# 3. warnings: NEXT_PUBLIC_ with service role, console.log of tokens, TODO security
"${diff_cmd[@]}" 2>/dev/null | grep -nE '^\+' | grep -vE '^\+\+\+' | grep -iE 'NEXT_PUBLIC_[A-Z_]*(SERVICE|SECRET|PRIVATE)|console\.(log|debug)\([^)]*(token|password|secret|authorization)|dangerouslySetInnerHTML|eval\(|Math\.random\(\)[^\n]*(token|id|secret)' | sed 's/^/WARN   +/' | cut -c1-200 | tee /tmp/stl-secret-scan.warn
[ -s /tmp/stl-secret-scan.warn ] && [ "$status" -eq 0 ] && status=1

# 4. tracked .env anywhere in the repo (block)
git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '\.env\.(example|template|sample)$' | sed 's/^/BLOCK  tracked: /' | tee /tmp/stl-secret-scan.tracked
[ -s /tmp/stl-secret-scan.tracked ] && status=2

case $status in
  0) echo "SCAN CLEAN";;
  1) echo "SCAN WARNINGS — review the WARN lines";;
  2) echo "SCAN BLOCK — secrets or env files present; do not commit/merge";;
esac
exit $status
