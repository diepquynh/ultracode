#!/usr/bin/env bash
set -eu

REPO_URL="${ULTRACODE_REPO_URL:-https://github.com/diepquynh/ultracode.git}"
INSTALL_DIR="${ULTRACODE_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/ultracode}"
HARNESS=""
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    claude|codex|grok|antigravity|agy|both|all) HARNESS="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Usage: install.sh [claude|codex|grok|antigravity|agy|both|all] [--dry-run]" >&2; exit 2 ;;
  esac
done

case "$INSTALL_DIR" in
  ""|/|"$HOME") echo "Refusing unsafe ULTRACODE_INSTALL_DIR: $INSTALL_DIR" >&2; exit 2 ;;
esac

[ -n "$HARNESS" ] || HARNESS=all
case "$HARNESS" in
  both) TARGETS="claude codex" ;;
  all) TARGETS="claude grok codex antigravity" ;;
  agy) TARGETS="antigravity" ;;
  *) TARGETS="$HARNESS" ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Would install Ultracode for $TARGETS from $REPO_URL into $INSTALL_DIR."
  echo "Would generate dist/<harness>/ultracode from the checkout's neutral sources."
  echo "Would install the bundled ultracode_gate MCP server's Node dependencies (npm ci)."
  echo "Would configure the local marketplace and install the Ultracode plugin."
  exit 0
fi

command -v node >/dev/null 2>&1 || {
  echo "Node is required by Ultracode's runtime hooks." >&2
  echo "Install Node 22.5 or newer first: https://nodejs.org/" >&2
  exit 1
}
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1);
' || {
  echo "Ultracode's repo-memory store needs node:sqlite, which requires Node 22.5 or newer (found $(node --version))." >&2
  echo "Install a newer Node first: https://nodejs.org/" >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "npm is required to install the bundled ultracode_gate MCP server's dependencies." >&2
  echo "It normally ships with Node: https://nodejs.org/" >&2
  exit 1
}
command -v git >/dev/null 2>&1 || { echo "git is required." >&2; exit 1; }
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
  echo "Ensure the command(s) are on PATH, then rerun this installer." >&2
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  if [ "${ULTRACODE_SKIP_PULL:-0}" -ne 1 ]; then
    git -C "$INSTALL_DIR" pull --rebase
  fi
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

  # The bundled ultracode_gate MCP server (mcp/gate-server.js) needs its own node_modules to run.
  # Some harnesses auto-install a plugin's declared dependencies; do it here explicitly too so the
  # server works regardless of whether that harness-side auto-install exists or has fired yet.
  ( cd "$PLUGIN_ROOT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund ) \
    || { echo "Failed to install the ultracode_gate MCP server's dependencies in $PLUGIN_ROOT." >&2; exit 1; }

  # Provision + start the machine-level cross-harness hub (idempotent across
  # the harness loop: a running hub is detected and left alone, an older one
  # is replaced by this newer install). Sessions also revive it lazily at MCP
  # startup, so a failure here degrades to that instead of aborting install.
  node "$PLUGIN_ROOT/mcp/hub-ctl.js" ensure --restart-if-older \
    || echo "Warning: the ultracode hub did not start; cross-harness tools stay offline until: node \"$PLUGIN_ROOT/mcp/hub-ctl.js\" ensure" >&2

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
  elif [ "$HARNESS" = grok ]; then
    grok plugin validate "$PLUGIN_ROOT" \
      || { echo "Generated Grok plugin failed validation: $PLUGIN_ROOT" >&2; exit 1; }
    if grok plugin list --json | grep -Fq '"name": "ultracode"'; then
      grok plugin uninstall ultracode --confirm
    fi
    grok plugin install "$PLUGIN_ROOT" --trust
    grok plugin enable ultracode
    echo "Installed Ultracode. Start a new Grok session, then run /init-kit."
    echo "If plugin hooks stay silent, run /hooks-trust or launch with --trust."
    echo "Grok also auto-loads Claude Code plugins. If Ultracode is already installed"
    echo "for Claude, disable one copy so skills and SessionStart hooks do not double-fire."
  elif [ "$HARNESS" = antigravity ]; then
    agy plugin validate "$PLUGIN_ROOT" \
      || { echo "Generated Antigravity plugin failed validation: $PLUGIN_ROOT" >&2; exit 1; }
    agy plugin install "$PLUGIN_ROOT" \
      || { echo "Failed to install Antigravity plugin from $PLUGIN_ROOT." >&2; exit 1; }
    agy plugin enable ultracode 2>/dev/null || true
    # Installing the plugin does NOT give the agent its MCP tools: `agy plugin install`
    # reports "mcpServers: 1 processed" for the bundled mcp_config.json, yet
    # `agy mcp list` stays empty and ultracode_gate never appears in the agent's tool
    # set. Without it the orchestrator cannot record a spec/plan approval at all — the
    # gate deadlocks, and a recorded session responded to that deadlock by forging
    # pipeline state. So register the server explicitly, with the absolute path (the
    # bundled config's ${ANTIGRAVITY_PLUGIN_ROOT} is not expanded here).
    agy mcp add ultracode-gate node "$PLUGIN_ROOT/mcp/hub-shim.js" >/dev/null 2>&1 \
      || echo "Warning: could not register the ultracode_gate MCP server with agy; run: agy mcp add ultracode-gate node \"$PLUGIN_ROOT/mcp/hub-shim.js\"" >&2
    echo "Installed Ultracode. Start a new agy session, then run /init-kit."
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
