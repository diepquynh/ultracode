#!/usr/bin/env node
// Hard-enforce Rules D3/D10/D17 ("never edit a spec/plan file yourself — every
// answer or requirement change goes back through a re-spawn of the owning
// agent") instead of relying on the orchestrator to resist the shortcut.
//
// Reads a PreToolUse hook payload (matcher: Write|Edit) from stdin. Orchestrator-
// only: ultracode:generate-spec and ultracode:plan legitimately write these exact
// files themselves, identified by the `agent_type` field Claude Code adds to hook
// input whenever the current tool call happens inside a subagent's own turn.

"use strict";

const path = require("node:path");
const { readHookInput, denyPreToolUse, hookToolInput, hookAgentType } = require("./lib/common");

const PROTECTED_PATTERNS = [
  /^ultracode-spec-.*\.md$/,
  /^ultracode-plan-.*\.md$/,
  /^plan\.md$/,
  /^phase-\d+.*\.md$/,
];

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  if (hookAgentType(hookInput)) return 0;

  const toolInput = hookToolInput(hookInput);
  const filePath =
    toolInput && typeof (toolInput.file_path || toolInput.filePath || toolInput.path) === "string"
      ? toolInput.file_path || toolInput.filePath || toolInput.path
      : "";
  if (!filePath) return 0;

  const base = path.basename(filePath);
  if (PROTECTED_PATTERNS.some((pattern) => pattern.test(base))) {
    denyPreToolUse(
      `ultracode: refusing to let the orchestrator write "${base}" directly (Rules D3/D10/D17). ` +
        "This is a pipeline artifact owned by ultracode:generate-spec or ultracode:plan — " +
        "re-spawn that agent with the change instead of editing the file yourself.",
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
