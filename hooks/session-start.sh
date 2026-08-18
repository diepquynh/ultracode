#!/usr/bin/env bash
# ultracode :: SessionStart hook.
# Surfaces the generated routing inventory to the orchestrator, or prompts initialization.
# Never fail the session: this hook only prints context.

PROJECT_DIR="${GROK_WORKSPACE_ROOT:-${CLAUDE_PROJECT_DIR:-${CODEX_PROJECT_DIR:-$PWD}}}"
RUNTIME_DIR="${1:?runtime directory argument is required}"
SKILLS_DIR="${2:?skills directory argument is required}"
INV="$PROJECT_DIR/$RUNTIME_DIR/INVENTORY.md"
PROFILE="$PROJECT_DIR/$RUNTIME_DIR/repo-profile.json"

if [ -f "$INV" ]; then
  echo "ultracode :: this repo IS initialized."
  echo "The orchestrator and EVERY subagent MUST read these two files before routing any work:"
  echo "  - $INV      (skill routing tables + module/area map)"
  echo "  - $PROFILE  (build / test / format / lint commands + stack profile)"
  echo "Route to skills using the INVENTORY tables by name. Do NOT route by skill descriptions."
  echo "Operate per the ultracode:orchestrate skill."
else
  echo "ultracode :: this repo is NOT initialized."
  echo "Before handling the first user request, initialize Ultracode: scout the codebase, propose a skill"
  echo "set for approval, then generate $RUNTIME_DIR/INVENTORY.md + repo-profile.json and the"
  if [ -n "${GROK_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}" ]; then
    echo "per-component skills under $SKILLS_DIR. Use the bundled Ultracode initializer workflow first."
  else
    echo "per-component skills under $SKILLS_DIR. Run /ultracode:init-kit before other repo work."
  fi
fi
