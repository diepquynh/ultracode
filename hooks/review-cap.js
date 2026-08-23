#!/usr/bin/env node
// Enforce the review-loop cap for every code-reviewer spawn in a tool call.

"use strict";

const path = require("node:path");
const { denyPreToolUse, readHookInput, readJsonIfFile, readTextIfFile } = require("./lib/common");
const { HookContext } = require("./lib/hook-context");
const { reviewLedgerName } = require("./lib/ledger-policy");

const MAX_ITERATIONS = 3;

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);

  for (const spawn of context.spawns.filter((candidate) => candidate.agent === "code-reviewer")) {
    const sessionDir = spawn.effectiveSessionDir;
    if (!sessionDir) continue;
    // Per loop, not per session: the ledger this spawn appends to is the one its
    // `Phase:` names, so a later phase — or the same phase's test loop — starts
    // its own count instead of inheriting an exhausted one.
    const phase = String(spawn.parameters.phase || "").trim();
    const ledger = readTextIfFile(path.join(sessionDir, reviewLedgerName(phase)));
    if (!ledger) continue;
    const iterations = ledger.match(/^## Iteration \d+/gm) || [];
    if (iterations.length < MAX_ITERATIONS) continue;
    const block = readJsonIfFile(path.join(sessionDir, "ultracode-security-block.json"));
    if (block && block.blocked === true) continue;
    const scope = /^\d+(-tests)?$/i.test(phase) ? `phase ${phase} of repo key` : "repo key";
    denyPreToolUse(
      `ultracode: review loop cap reached (${iterations.length}/${MAX_ITERATIONS}) for ${scope} ` +
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
