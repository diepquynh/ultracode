#!/usr/bin/env bash
set -eu

INSTALL_DIR="${ULTRACODE_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/ultracode}"
HARNESS=""
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    claude|codex|grok|antigravity|agy|both|all) HARNESS="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Usage: uninstall.sh [claude|codex|grok|antigravity|agy|both|all] [--dry-run]" >&2; exit 2 ;;
  esac
done

case "$INSTALL_DIR" in
  ""|/|"$HOME") echo "Refusing unsafe ULTRACODE_INSTALL_DIR: $INSTALL_DIR" >&2; exit 2 ;;
esac

[ -n "$HARNESS" ] || HARNESS=all
SELECTION="$HARNESS"
case "$HARNESS" in
  both) TARGETS="claude codex" ;;
  all) TARGETS="claude grok codex antigravity" ;;
  agy) TARGETS="antigravity" ;;
  *) TARGETS="$HARNESS" ;;
esac

MARKETPLACE_ROOT="${INSTALL_DIR}-marketplace/codex"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Would uninstall Ultracode for $TARGETS from $INSTALL_DIR."
  echo "Would unregister the local marketplace and Ultracode plugin."
  echo "Would remove the Codex local marketplace checkout if Codex is selected."
  echo "Would remove $INSTALL_DIR when uninstalling every harness."
  exit 0
fi

missing=""
for target in $TARGETS; do
  cmd="$target"
  if [ "$target" = antigravity ]; then
    cmd="agy"
  fi
  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $target"
done
if [ -n "$missing" ]; then
  echo "Missing harness CLI(s):$missing" >&2
  for target in $missing; do
    if [ "$target" = claude ]; then
      echo "Install Claude Code first: npm install -g @anthropic-ai/claude-code" >&2
    elif [ "$target" = grok ]; then
      echo "Install Grok Build first: https://docs.x.ai/build" >&2
    elif [ "$target" = antigravity ]; then
      echo "Install Antigravity CLI (agy) first: https://github.com/google/antigravity" >&2
    else
      echo "Install Codex first: npm install -g @openai/codex" >&2
    fi
  done
  echo "Ensure the command(s) are on PATH, then rerun this uninstaller." >&2
  exit 1
fi

for HARNESS in $TARGETS; do
  PLUGIN_ROOT="$INSTALL_DIR/dist/$HARNESS/ultracode"

  if [ "$HARNESS" = claude ]; then
    if claude plugin list --json | grep -Fq '"id": "ultracode@ultracode"'; then
      claude plugin uninstall ultracode@ultracode \
        || { echo "Failed to uninstall the Claude plugin ultracode@ultracode." >&2; exit 1; }
    fi

    marketplaces="$(claude plugin marketplace list --json)"
    if printf '%s' "$marketplaces" | grep -Fq '"name": "ultracode"'; then
      printf '%s' "$marketplaces" | grep -Fq "\"path\": \"$PLUGIN_ROOT\"" || {
        echo "Claude marketplace 'ultracode' already points somewhere else." >&2; exit 1;
      }
      claude plugin marketplace remove ultracode \
        || { echo "Failed to remove the Claude marketplace 'ultracode'." >&2; exit 1; }
    fi
    echo "Uninstalled Ultracode from Claude Code. Restart Claude Code."
  elif [ "$HARNESS" = grok ]; then
    if grok plugin list --json | grep -Fq '"name": "ultracode"'; then
      grok plugin uninstall ultracode --confirm \
        || { echo "Failed to uninstall the Grok plugin ultracode." >&2; exit 1; }
    fi
    echo "Uninstalled Ultracode from Grok Build. Start a new Grok session."
  elif [ "$HARNESS" = antigravity ]; then
    if agy plugin list | grep -Fq '"name": "ultracode"'; then
      agy plugin uninstall ultracode \
        || { echo "Failed to uninstall the Antigravity plugin ultracode." >&2; exit 1; }
    fi
    # install.sh registers this separately from the plugin, so uninstalling the
    # plugin leaves it behind pointing at a directory that is about to be gone.
    agy mcp remove ultracode-gate >/dev/null 2>&1 || true
    echo "Uninstalled Ultracode from Antigravity. Start a new agy session."
  else
    if codex plugin list --json | grep -Fq '"pluginId": "ultracode@ultracode-local"'; then
      codex plugin remove ultracode@ultracode-local \
        || { echo "Failed to remove the Codex plugin ultracode@ultracode-local." >&2; exit 1; }
    fi

    marketplaces="$(codex plugin marketplace list --json)"
    if printf '%s' "$marketplaces" | grep -Fq '"name": "ultracode-local"'; then
      printf '%s' "$marketplaces" | grep -Fq "\"root\": \"$MARKETPLACE_ROOT\"" || {
        echo "Codex marketplace 'ultracode-local' already points somewhere else." >&2; exit 1;
      }
      codex plugin marketplace remove ultracode-local \
        || { echo "Failed to remove the Codex marketplace 'ultracode-local'." >&2; exit 1; }
    fi

    # install.sh registers these separately from the plugin (Codex does not expand
    # ${PLUGIN_ROOT} in plugin-manifest mcpServers, and reads agent_types only
    # from config.toml), so remove both explicitly too.
    codex mcp remove ultracode-gate >/dev/null 2>&1 || true
    node "$INSTALL_DIR/scripts/register_codex_agents.js" --remove >/dev/null 2>&1 || true
    # install.sh stages the Codex plugin under ${INSTALL_DIR}-marketplace/codex.
    rm -rf "$MARKETPLACE_ROOT"
    rmdir "${INSTALL_DIR}-marketplace" 2>/dev/null || true
    echo "Uninstalled Ultracode from Codex. Start a new Codex session."
  fi
done

# A single-harness uninstall leaves the checkout: other targets may still use it.
if [ "$SELECTION" = all ]; then
  # Stop the machine-level hub daemon before its code goes away. Its state
  # (~/.ultracode/hub*, including the bearer token) is deliberately kept so a
  # reinstall picks up the same registrations; remove it with --purge-hub or
  # by deleting ~/.ultracode by hand.
  for HARNESS in $TARGETS; do
    CTL="$INSTALL_DIR/dist/$HARNESS/ultracode/mcp/hub-ctl.js"
    if [ -f "$CTL" ]; then
      node "$CTL" stop >/dev/null 2>&1 || true
      break
    fi
  done
  echo "Left ~/.ultracode (hub state/token) in place for reinstalls; delete it to purge."
  if [ -d "$INSTALL_DIR/.git" ]; then
    [ -f "$INSTALL_DIR/scripts/generate_definitions.js" ] || {
      echo "$INSTALL_DIR is a git checkout but is not an Ultracode tree; leaving it." >&2
      exit 1
    }
    rm -rf "$INSTALL_DIR"
    echo "Removed $INSTALL_DIR."
  elif [ -e "$INSTALL_DIR" ]; then
    echo "$INSTALL_DIR exists but is not an Ultracode git checkout; leaving it." >&2
    exit 1
  fi
fi
