#!/usr/bin/env node
// Protect pipeline artifacts and ledger ownership with a harness-neutral actor
// and write-path view.

"use strict";

const path = require("node:path");
const { denyPreToolUse, readHookInput, writePathFromToolInput } = require("./lib/common");
const { HookContext } = require("./lib/hook-context");
const { checkLedger } = require("./lib/ledger-policy");

const PROTECTED_PATTERNS = [
  /^ultracode-spec-.*\.md$/,
  /^ultracode-plan-.*\.md$/,
  /^plan\.md$/,
  /^ultracode-phase-\d+.*\.md$/,
];

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);
  const actor = context.currentActor();
  const filePath = writePathFromToolInput(context.toolInput);
  if (!filePath) return 0;

  const ledger = checkLedger(actor.agent, filePath);
  if (!ledger.allowed) {
    denyPreToolUse(`ultracode: refusing this write — ${ledger.reason}`);
    return 0;
  }

  if (actor.agent) return 0;
  const base = path.basename(filePath);
  if (PROTECTED_PATTERNS.some((pattern) => pattern.test(base))) {
    denyPreToolUse(
      `ultracode: refusing to let the orchestrator write "${base}" directly (Rules D3/D10/D17). ` +
        "This artifact is owned by ultracode:generate-spec or ultracode:plan; re-spawn its owner instead.",
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
