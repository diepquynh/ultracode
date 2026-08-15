#!/usr/bin/env bash
set -eu

REPO_URL="${ULTRACODE_REPO_URL:-https://github.com/diepquynh/ultracode.git}"
INSTALL_DIR="${ULTRACODE_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/ultracode}"
HARNESS=""
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    claude|codex|both) HARNESS="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Usage: install.sh [claude|codex|both] [--dry-run]" >&2; exit 2 ;;
  esac
done

case "$INSTALL_DIR" in
  ""|/|"$HOME") echo "Refusing unsafe ULTRACODE_INSTALL_DIR: $INSTALL_DIR" >&2; exit 2 ;;
esac

[ -n "$HARNESS" ] || HARNESS=both
[ "$HARNESS" = both ] && TARGETS="claude codex" || TARGETS="$HARNESS"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Would install Ultracode for $TARGETS from $REPO_URL into $INSTALL_DIR."
  echo "Would generate dist/<harness>/ultracode from the checkout's neutral sources."
  echo "Would configure the local marketplace and install the Ultracode plugin."
  exit 0
fi

command -v node >/dev/null 2>&1 || {
  echo "Node is required by Ultracode's runtime hooks." >&2
  echo "Install Node 20 or newer first: https://nodejs.org/" >&2
  exit 1
}
command -v git >/dev/null 2>&1 || { echo "git is required." >&2; exit 1; }
missing=""
for target in $TARGETS; do
  command -v "$target" >/dev/null 2>&1 || missing="$missing $target"
done
if [ -n "$missing" ]; then
  echo "Missing harness CLI(s):$missing" >&2
  for target in $missing; do
    if [ "$target" = claude ]; then
      echo "Install Claude Code first: npm install -g @anthropic-ai/claude-code" >&2
    else
      echo "Install Codex first: npm install -g @openai/codex" >&2
    fi
  done
  echo "Ensure the command(s) are on PATH, then rerun this installer." >&2
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --rebase
elif [ -e "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR exists but is not an Ultracode git checkout." >&2
  exit 1
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

GENERATOR="$INSTALL_DIR/scripts/generate_definitions.js"
[ -f "$GENERATOR" ] || { echo "Missing generator: $GENERATOR" >&2; exit 1; }

for HARNESS in $TARGETS; do
  PLUGIN_ROOT="$INSTALL_DIR/dist/$HARNESS/ultracode"
  # Generated from source on every install, so no distribution is ever committed or shipped stale.
  # Wiped first: the generator overwrites but never prunes files a newer revision dropped.
  rm -rf "$PLUGIN_ROOT"
  node "$GENERATOR" --target "$HARNESS" --source-root "$INSTALL_DIR" --output-dir "$PLUGIN_ROOT" \
    || { echo "Failed to generate the $HARNESS plugin from $INSTALL_DIR." >&2; exit 1; }

  if [ "$HARNESS" = claude ]; then
    marketplaces="$(claude plugin marketplace list --json)"
    if printf '%s' "$marketplaces" | grep -Fq '"name": "ultracode"'; then
      printf '%s' "$marketplaces" | grep -Fq "\"path\": \"$PLUGIN_ROOT\"" || {
        echo "Claude marketplace 'ultracode' already points somewhere else." >&2; exit 1;
      }
      claude plugin marketplace update ultracode
    else
      claude plugin marketplace add "$PLUGIN_ROOT"
    fi

    if claude plugin list --json | grep -Fq '"id": "ultracode@ultracode"'; then
      claude plugin update ultracode@ultracode
    else
      claude plugin install ultracode@ultracode
    fi
    echo "Installed Ultracode. Restart Claude Code, then run /init-kit."
  else
    MARKETPLACE_ROOT="${INSTALL_DIR}-marketplace/codex"
    STAGED_PLUGIN="$MARKETPLACE_ROOT/plugins/ultracode"
    rm -rf "$STAGED_PLUGIN"
    mkdir -p "$MARKETPLACE_ROOT/.agents/plugins" "$MARKETPLACE_ROOT/plugins"
    cp -R "$PLUGIN_ROOT" "$STAGED_PLUGIN"
    cat >"$MARKETPLACE_ROOT/.agents/plugins/marketplace.json" <<'JSON'
{
  "name": "ultracode-local",
  "interface": { "displayName": "Ultracode Local" },
  "plugins": [{
    "name": "ultracode",
    "source": { "source": "local", "path": "./plugins/ultracode" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
JSON

    marketplaces="$(codex plugin marketplace list --json)"
    if printf '%s' "$marketplaces" | grep -Fq '"name": "ultracode-local"'; then
      printf '%s' "$marketplaces" | grep -Fq "\"root\": \"$MARKETPLACE_ROOT\"" || {
        echo "Codex marketplace 'ultracode-local' already points somewhere else." >&2; exit 1;
      }
    else
      codex plugin marketplace add "$MARKETPLACE_ROOT"
    fi
    codex plugin add ultracode@ultracode-local
    echo "Installed Ultracode. Start Codex, trust its hooks in /hooks, restart, then run \$init-kit."
  fi
done
