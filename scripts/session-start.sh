#!/usr/bin/env bash
# stl-plugin SessionStart — cheap orientation, never blocks.
# Prints (as context) what the collaborator still has to do, and where the
# last handoff of this project lives. Exit 0 always.
set -uo pipefail

CONFIG="$HOME/.claude/stl/config.json"

if [ ! -f "$CONFIG" ]; then
  echo "stl-plugin: global setup not done yet — run /stl-plugin:stl-setup before anything else."
  exit 0
fi

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$root" ] && exit 0
# realpath both sides: ~/Projetos may be a symlink, and git already resolves it.
root="$(cd "$root" && pwd -P)"

projetos="$(python3 -c 'import json,sys,os;print(os.path.realpath(os.path.expanduser(json.load(open(sys.argv[1])).get("projetos",""))))' "$CONFIG" 2>/dev/null || true)"
[ -z "$projetos" ] && exit 0

case "$root" in
  "$projetos"/*)
    [ -f "$root/CLAUDE.md" ] || echo "stl-plugin: this project has no CLAUDE.md — run /stl-plugin:stl-project-init."
    ;;
esac

if [ -d "$root/docs/handoff" ]; then
  last="$(ls "$root/docs/handoff" 2>/dev/null | grep -E '^[0-9]{3}-' | sort | tail -1)"
  [ -n "$last" ] && echo "stl-plugin: last handoff is docs/handoff/$last — read it before starting."
fi
exit 0
