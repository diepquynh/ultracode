#!/usr/bin/env bash
# ultracode :: SessionStart hook.
# Surfaces the generated routing inventory to the orchestrator, or prompts initialization.
# Never fail the session: this hook only prints context.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
INV="$PROJECT_DIR/.claude/ultracode/INVENTORY.md"
PROFILE="$PROJECT_DIR/.claude/ultracode/repo-profile.json"

if [ -f "$INV" ]; then
  echo "ultracode :: this repo IS initialized."
  echo "The orchestrator and EVERY subagent MUST read these two files before routing any work:"
  echo "  - $INV      (skill routing tables + module/area map)"
  echo "  - $PROFILE  (build / test / format / lint commands + stack profile)"
  echo "Route to skills using the INVENTORY tables by name. Do NOT route by skill descriptions."
  echo "Operate per the ultracode:orchestrate skill."
else
  echo "ultracode :: this repo is NOT initialized."
  echo "Run /ultracode:init-kit to scout the codebase, propose a skill set for approval, then generate"
  echo ".claude/ultracode/INVENTORY.md + repo-profile.json + per-component skills under .claude/skills/."
fi
