#!/usr/bin/env node
// Enforce the review-loop cap for every code-reviewer spawn in a tool call.
//
// The cap stops the loop from spinning on its own budget; it is not a safety
// rule, and a 4th pass is sometimes exactly what the work needs. So the spawn
// past the cap is put to the user rather than refused: the hook asks, and the
// pass runs or does not by their answer. The reason doubles as the orchestrator's
// hint — on a rejection (and in headless runs, where nobody can be prompted) it
// comes back as the tool-call failure, so the loop stops with the cap named
// instead of stalling silently. See askPreToolUse in lib/common.js for what each
// harness does with it.
//
// Known gap: the ask does not work on Grok. It has no ask decision — both shapes
// fail open there, which would delete the cap rather than soften it — so Grok
// gets the denial below and its user cannot approve a 4th pass at the prompt at
// all; only the orchestrator can put that question to them.

"use strict";

const path = require("node:path");
const { askPreToolUse, readHookInput, readJsonIfFile, readTextIfFile } = require("./lib/common");
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
    const capped =
      `ultracode: review loop cap reached (${iterations.length}/${MAX_ITERATIONS}) for ${scope} ` +
      `"${spawn.repoKey}".`;
    askPreToolUse(
      `${capped} Approve to spend one more pass on it, or reject to end the loop — rejecting means ` +
        "the findings still open get reported to you as they stand rather than fixed automatically.",
      `${capped} Do not start another automatic pass: report the findings still open to the user, ` +
        "and let them decide whether another review pass is worth it.",
    );
    return 0;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
