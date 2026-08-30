#!/usr/bin/env node
// Register ultracode's agent roles as Codex agent_types.
//
// Codex (measured on 0.151.0) does not read agent roles from a plugin: valid
// spawn_agent `agent_type` values come only from `[agents.<name>]` tables in
// ~/.codex/config.toml, each pointing at a role TOML via `config_file`.
// Without this registration every ultracode spawn fails with
// "unknown agent_type", and sessions improvise generic context-forks instead
// (docs/harness-limitations.md). Same workaround class as the explicit
// `codex mcp add` / `agy mcp add` registrations in install.sh.
//
// Manages ONE clearly-delimited block so reruns replace rather than duplicate,
// and uninstall removes exactly what install added:
//
//   node register_codex_agents.js --plugin-root <dist/codex/ultracode>
//   node register_codex_agents.js --remove
//
// CODEX_HOME overrides ~/.codex (tests point it at a fixture).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BLOCK_START = "# >>> ultracode agents (managed by ultracode install.sh — do not edit) >>>";
const BLOCK_END = "# <<< ultracode agents <<<";

function configPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}

function stripBlock(text) {
  const start = text.indexOf(BLOCK_START);
  if (start < 0) return text;
  const end = text.indexOf(BLOCK_END, start);
  const after = end < 0 ? text.length : end + BLOCK_END.length;
  return (text.slice(0, start) + text.slice(after)).replace(/\n{3,}$/g, "\n\n");
}

function buildBlock(pluginRoot) {
  const agentsDir = path.join(pluginRoot, "agents");
  const files = fs
    .readdirSync(agentsDir)
    .filter((entry) => entry.endsWith(".toml"))
    .sort();
  if (files.length === 0) throw new Error(`no agent role files found in ${agentsDir}`);
  const lines = [BLOCK_START];
  for (const file of files) {
    const agentType = `ultracode_${path.basename(file, ".toml").replace(/-/g, "_")}`;
    lines.push(
      `[agents.${agentType}]`,
      `description = "ultracode pipeline role '${path.basename(file, ".toml")}' — spawn only as the ultracode orchestrate/hub-listen skills instruct, never for ad-hoc work."`,
      `config_file = ${JSON.stringify(path.join(agentsDir, file))}`,
      "",
    );
  }
  lines.push(BLOCK_END, "");
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const remove = args.includes("--remove");
  const rootIndex = args.indexOf("--plugin-root");
  const pluginRoot = rootIndex >= 0 ? path.resolve(args[rootIndex + 1] || "") : null;
  if (!remove && !pluginRoot) {
    process.stderr.write("Usage: register_codex_agents.js --plugin-root <dir> | --remove\n");
    process.exit(2);
  }

  const target = configPath();
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "";
  let next = stripBlock(existing);
  if (!remove) {
    if (next.length && !next.endsWith("\n")) next += "\n";
    next += (next.trim().length ? "\n" : "") + buildBlock(pluginRoot);
  }
  if (next === existing) {
    process.stdout.write(`codex agents: no change needed in ${target}\n`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, "utf-8");
  fs.renameSync(tmp, target);
  process.stdout.write(
    remove
      ? `codex agents: removed ultracode agent registrations from ${target}\n`
      : `codex agents: registered ultracode agent_types in ${target}\n`,
  );
}

main();
