#!/usr/bin/env node
// Hard-enforce "Session isolation" (skills/orchestrate/prompt.md) and Hard rule 3:
// every spawn that names a Repo root: must also carry a Session dir:, and that
// dir must be the derived path (or one repo-key subdirectory of it) — never a
// random or invented location the next stage will not look in.
//
// Reads a PreToolUse hook payload (matcher: Task|Agent / Agent) from stdin.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  denyPreToolUse,
  promptFromToolInput,
  field,
  hookToolInput,
  hookSessionId,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot, matchesSessionDir } = require("./lib/session");

async function main() {
  const hookInput = await readHookInput();
  const toolInput = hookToolInput(hookInput);
  if (!toolInput || typeof toolInput !== "object") return 0;

  const prompt = promptFromToolInput(toolInput);
  const declaredRepoRoot = field(prompt, "Repo root");
  if (!declaredRepoRoot) return 0; // nothing to validate — not every tool call is a repo-scoped spawn

  const declaredSessionDir = field(prompt, "Session dir");
  if (!declaredSessionDir) {
    denyPreToolUse(
      "ultracode: this spawn names a Repo root: but no Session dir: line. " +
        "Every subagent prompt must carry both (Hard rule 3) — add the derived " +
        "Session dir: and re-spawn.",
    );
    return 0;
  }

  const info = pluginTargetInfo();
  if (!info) return 0; // no generated routing yet (repo not initialized) — nothing to validate against

  const repoRoot = resolveRepoRoot(hookInput, prompt);
  const { ok, expected } = matchesSessionDir(
    declaredSessionDir,
    repoRoot,
    info.runtimeDir,
    hookSessionId(hookInput),
  );
  if (!ok) {
    denyPreToolUse(
      `ultracode: Session dir: "${declaredSessionDir}" is not the derived session ` +
        `directory for this repo and session. Use "${expected}" (or "${path.join(expected, "{repo-key}")}" ` +
        "for a multi-repo session) — never a random or timestamped suffix — and re-spawn.",
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
