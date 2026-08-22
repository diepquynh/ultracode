#!/usr/bin/env node
// Enforce non-waivable security policy for every subagent in a spawn envelope.

"use strict";

const path = require("node:path");
const { denyPreToolUse, readHookInput, readJsonIfFile } = require("./lib/common");
const { HookContext } = require("./lib/hook-context");

const OVERRIDE_PATTERNS = [
  /\b(skip|ignore|disable|bypass|waive|suppress|override|turn\s+off|don'?t\s+run|do\s+not\s+run)\b[^\n]{0,60}\b(security\s+scan|security\s+check|blocker\s+finding|sec-block)/i,
  /\b(security\s+scan|security\s+check|blocker\s+finding|sec-block)[^\n]{0,60}\b(skip|ignore|disable|bypass|waive|suppress|override|don'?t\s+run|do\s+not\s+run)\b/i,
];

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);

  for (const spawn of context.spawns) {
    if (spawn.prompt && OVERRIDE_PATTERNS.some((pattern) => pattern.test(spawn.prompt))) {
      denyPreToolUse(
        `ultracode: refusing ultracode:${spawn.agent || "subagent"} — its prompt instructs skipping, ` +
          "disabling, or waiving the mandatory security scan or a BLOCKER finding. It cannot be waived.",
      );
      return 0;
    }
    if (spawn.agent !== "module-documentation" || !spawn.effectiveSessionDir) continue;
    const block = readJsonIfFile(path.join(spawn.effectiveSessionDir, "ultracode-security-block.json"));
    if (block && block.blocked === true) {
      denyPreToolUse(
        `ultracode: refusing ultracode:module-documentation — ${spawn.effectiveSessionDir}/` +
          "ultracode-security-block.json reports an unresolved BLOCKER security finding.",
      );
      return 0;
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
