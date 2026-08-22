#!/usr/bin/env node
// Enforce the review-loop cap for every code-reviewer spawn in a tool call.

"use strict";

const path = require("node:path");
const { denyPreToolUse, readHookInput, readJsonIfFile, readTextIfFile } = require("./lib/common");
const { HookContext } = require("./lib/hook-context");

const MAX_ITERATIONS = 3;

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);

  for (const spawn of context.spawns.filter((candidate) => candidate.agent === "code-reviewer")) {
    const sessionDir = spawn.effectiveSessionDir;
    if (!sessionDir) continue;
    const ledger = readTextIfFile(path.join(sessionDir, "ultracode-review-ledger.md"));
    if (!ledger) continue;
    const iterations = ledger.match(/^## Iteration \d+/gm) || [];
    if (iterations.length < MAX_ITERATIONS) continue;
    const block = readJsonIfFile(path.join(sessionDir, "ultracode-security-block.json"));
    if (block && block.blocked === true) continue;
    denyPreToolUse(
      `ultracode: review loop cap reached (${iterations.length}/${MAX_ITERATIONS}) for repo key ` +
        `"${spawn.repoKey}". Report the remaining findings instead of starting another automatic pass.`,
    );
    return 0;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
