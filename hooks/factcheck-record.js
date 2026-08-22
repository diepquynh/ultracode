#!/usr/bin/env node
// Capture fact-check verdicts under the primary session root and the spawn's
// explicit repo key. The work repository may be elsewhere.

"use strict";

const path = require("node:path");
const {
  emitAdditionalContext,
  extractJsonObject,
  readHookInput,
  readJsonIfFile,
  writeJsonAtomic,
} = require("./lib/common");
const { HookContext } = require("./lib/hook-context");

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);
  const payload = extractJsonObject(context.toolResponse);
  const target = payload && (payload.target === "spec" || payload.target === "plan") ? payload.target : null;
  const verdict = payload && (payload.verdict === "PASS" || payload.verdict === "FAIL") ? payload.verdict : null;
  if (!target || !verdict) return 0;

  for (const spawn of context.spawns.filter((candidate) => candidate.agent === "fact-check")) {
    if (!spawn.repoKey || !spawn.stateRoot) {
      emitAdditionalContext(
        "PostToolUse",
        `ultracode: fact-check returned ${verdict} for ${target}, but no valid \`Repo key:\` line was available; ` +
          "re-spawn with the required parameter contract.",
      );
      continue;
    }
    try {
      const factcheckPath = path.join(spawn.stateRoot, spawn.repoKey, "factcheck.json");
      const current = readJsonIfFile(factcheckPath) || {};
      const priorRounds = (current[target] && current[target].rounds) || 0;
      current[target] = {
        verdict,
        rounds: priorRounds + 1,
        findings: Array.isArray(payload.findings) ? payload.findings : [],
        repo: spawn.repoKey,
        workRepoRoot: spawn.workRepoRoot,
        ts: new Date().toISOString(),
      };
      writeJsonAtomic(factcheckPath, current);
    } catch {
      // Best-effort capture only.
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
