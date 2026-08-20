#!/usr/bin/env node
// Hard-enforce Hard rule 19 ("Spawn in the foreground, never in the background" —
// no Bash(true)/sleep/wait/busy-loop/keepalive while a subagent is running) instead
// of relying on the orchestrator to remember the prohibition.
//
// Reads a PreToolUse hook payload (matcher: Bash) from stdin. Orchestrator-only:
// a subagent's own Bash calls (e.g. a legitimately long test run) are exempt,
// identified by the documented `agent_type` field Claude Code adds to hook input
// whenever the current tool call happens inside a subagent's own turn.

"use strict";

const { readHookInput, denyPreToolUse, hookToolInput, hookAgentType } = require("./lib/common");

const BANNED_PATTERNS = [
  { pattern: /^\s*(true|:)\s*;?\s*$/, label: "a no-op keepalive (`true`/`:`)" },
  { pattern: /(^|[;&|]|\bthen\b|\bdo\b)\s*sleep\s+[\d.]/i, label: "`sleep`" },
  { pattern: /^\s*wait\b/im, label: "`wait`" },
  { pattern: /\b(while|until)\b[^\n]*\bsleep\b/is, label: "a sleep-polling loop" },
  { pattern: /keep[- ]?alive/i, label: "a keepalive command" },
  { pattern: /hold\s+the\s+turn\s+open/i, label: "a \"hold the turn open\" command" },
];

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  if (hookAgentType(hookInput)) return 0;

  const toolInput = hookToolInput(hookInput);
  const command =
    toolInput && typeof (toolInput.CommandLine || toolInput.command) === "string"
      ? toolInput.CommandLine || toolInput.command
      : "";
  if (!command) return 0;

  const hit = BANNED_PATTERNS.find(({ pattern }) => pattern.test(command));
  if (hit) {
    denyPreToolUse(
      `ultracode: refusing ${hit.label} (Hard rule 19 — never sleep/wait/poll/keepalive while ` +
        "a subagent spawn is running; every foreground spawn call already blocks until it " +
        "returns, so there is nothing to wait for).",
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
