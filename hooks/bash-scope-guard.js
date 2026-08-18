#!/usr/bin/env node
// Hard-enforce the same per-agent write scope as scope-guard.js, but for writes
// made through Bash instead of the Write/Edit tools. Several read-only-by-role
// agents (code-reviewer, plan) have no write/edit tool at all and write their
// session-dir artifacts via a shell heredoc; any agent with shell access could
// otherwise route around scope-guard.js entirely with `rm`/`mv`/`cp`/`sed -i`/
// `> file` — including ultracode:implement writing a prohibited test file
// through a heredoc instead of the Write tool (agents/implement/prompt.md
// Constraint 6).
//
// Reads a PreToolUse hook payload (matcher: Bash) from stdin. Scoped to
// ultracode subagents (the `agent_type` field Claude Code adds inside a
// subagent's own turn); the orchestrator's own Bash calls are unaffected.
//
// Best-effort: hooks/lib/shell-paths.js pattern-matches common write/delete/
// move idioms, not a full shell parser — see that file's header for exactly
// what it does and does not catch.

"use strict";

const {
  readHookInput,
  denyPreToolUse,
  hookToolInput,
  hookAgentType,
  bareAgentName,
  hookSessionId,
  resolvePathCandidate,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot, baseSessionDir } = require("./lib/session");
const { checkScope } = require("./lib/scope-policy");
const { extractWriteTargets } = require("./lib/shell-paths");

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  const agent = bareAgentName(hookAgentType(hookInput));
  if (!agent) return 0;

  const toolInput = hookToolInput(hookInput);
  const command = toolInput && typeof toolInput.command === "string" ? toolInput.command : "";
  if (!command) return 0;

  const info = pluginTargetInfo();
  if (!info) return 0;

  const repoRoot = resolveRepoRoot(hookInput, "");
  const sessionDir = baseSessionDir(repoRoot, info.runtimeDir, hookSessionId(hookInput));

  for (const candidate of extractWriteTargets(command)) {
    const target = resolvePathCandidate(repoRoot, candidate);
    const { allowed, reason } = checkScope(agent, target, { repoRoot, sessionDir, info });
    if (!allowed) {
      denyPreToolUse(
        `ultracode: refusing this Bash command for ultracode:${agent} — it writes to, moves, or deletes ` +
          `"${candidate}", which is ${reason}. Do this from within the agent's allowed scope instead of ` +
          "routing around the scope guard through Bash.",
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
