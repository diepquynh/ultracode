#!/usr/bin/env node
// Hard-enforce Rules D3/D10/D17 ("never edit a spec/plan file yourself — every
// answer or requirement change goes back through a re-spawn of the owning
// agent") instead of relying on the orchestrator to resist the shortcut.
//
// Reads a PreToolUse hook payload (matcher: Write|Edit) from stdin.
//
// Two layers with different scopes:
//   * PROTECTED_PATTERNS (spec/plan/phase files) — orchestrator-only, because
//     ultracode:generate-spec and ultracode:plan legitimately write these exact
//     files themselves. A subagent's turn is identified by the `agent_type`
//     field Claude Code adds to hook input.
//   * checkLedger (hooks/lib/ledger-policy.js) — applies to EVERY writer,
//     orchestrator and subagent alike, because pipeline ledgers such as
//     factcheck.json gate real decisions and have exactly one legitimate author.
//     bash-scope-guard.js enforces the same policy against shell redirects.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  denyPreToolUse,
  hookToolInput,
  hookAgentType,
  bareAgentName,
} = require("./lib/common");
const { checkLedger } = require("./lib/ledger-policy");

// Phase files are written as `ultracode-phase-<n>-<slug>.md` (agents/plan/prompt.md
// writes one self-contained file per phase). An earlier `/^phase-\d+.*\.md$/` here
// required the basename to START with "phase-", so it never matched a real phase
// file and this rule silently enforced nothing.
const PROTECTED_PATTERNS = [
  /^ultracode-spec-.*\.md$/,
  /^ultracode-plan-.*\.md$/,
  /^plan\.md$/,
  /^ultracode-phase-\d+.*\.md$/,
];

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  const agent = bareAgentName(hookAgentType(hookInput));

  const toolInput = hookToolInput(hookInput);
  const filePath =
    toolInput && typeof (toolInput.file_path || toolInput.filePath || toolInput.path) === "string"
      ? toolInput.file_path || toolInput.filePath || toolInput.path
      : "";
  if (!filePath) return 0;

  // Ledger ownership binds every writer, so this runs before the
  // orchestrator-only spec/plan check below.
  const ledger = checkLedger(agent, filePath);
  if (!ledger.allowed) {
    denyPreToolUse(`ultracode: refusing this write — ${ledger.reason}`);
    return 0;
  }

  if (agent) return 0;

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
