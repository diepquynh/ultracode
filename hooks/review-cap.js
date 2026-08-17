#!/usr/bin/env node
// Enforce the "cap at 3 iterations" review-loop rule (skills/orchestrate/prompt.md
// "Step 4 — Code-review loop"; commands/code-review/prompt.md) in code rather than
// relying on the orchestrator to count.
//
// Reads a PreToolUse hook payload (matcher: Task|Agent / Agent) from stdin. When the
// spawn targets ultracode:code-reviewer, counts the "## Iteration N" headers the
// reviewer agent itself already writes to {session-dir}/ultracode-review-ledger.md
// (agents/code-reviewer/prompt.md, Step 5.1). At 3 or more prior iterations, denies
// the spawn instead of letting a 4th review pass start.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  denyPreToolUse,
  agentFromToolInput,
  promptFromToolInput,
  readTextIfFile,
  field,
  isDirectory,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot, baseSessionDir } = require("./lib/session");

const MAX_ITERATIONS = 3;

async function main() {
  const hookInput = await readHookInput();
  const toolInput = hookInput && hookInput.tool_input;
  if (!toolInput || typeof toolInput !== "object") return 0;

  if (agentFromToolInput(toolInput) !== "code-reviewer") return 0;

  const prompt = promptFromToolInput(toolInput);
  const repoRoot = resolveRepoRoot(hookInput, prompt);

  let sessionDir = field(prompt, "Session dir");
  if (!sessionDir || !isDirectory(sessionDir)) {
    const info = pluginTargetInfo();
    if (!info) return 0;
    sessionDir = baseSessionDir(repoRoot, info.runtimeDir, hookInput.session_id);
  }

  const ledgerPath = path.join(sessionDir, "ultracode-review-ledger.md");
  const ledger = readTextIfFile(ledgerPath);
  if (!ledger) return 0;

  const iterations = ledger.match(/^## Iteration \d+/gm) || [];
  if (iterations.length >= MAX_ITERATIONS) {
    denyPreToolUse(
      `ultracode: review loop cap reached (${iterations.length}/${MAX_ITERATIONS}). ` +
        "Refusing another review pass — report the remaining findings to the user " +
        "and ask how to proceed instead of auto-running a 4th iteration.",
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
