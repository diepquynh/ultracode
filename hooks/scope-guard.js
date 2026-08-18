#!/usr/bin/env node
// Hard-enforce each subagent's documented write scope (hooks/lib/scope-policy.js)
// instead of relying on its own prompt.md to police itself — a weaker model, an
// ambiguous plan step, or a hostile instruction embedded in repo content can all
// talk a subagent into writing somewhere outside its working path.
//
// Reads a PreToolUse hook payload (matcher: Write|Edit) from stdin. Scoped to
// calls happening inside an ultracode subagent's own turn, identified by the
// `agent_type` field Claude Code adds in that case — the orchestrator's own
// Write/Edit calls are governed by artifact-guard.js and the user's own
// judgment, not this hook. Complements bash-scope-guard.js, which enforces the
// same policy against the same subagent's Bash calls.

"use strict";

const path = require("node:path");
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

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  const agent = bareAgentName(hookAgentType(hookInput));
  if (!agent) return 0;

  const toolInput = hookToolInput(hookInput);
  const filePath =
    toolInput && typeof (toolInput.file_path || toolInput.filePath || toolInput.path) === "string"
      ? toolInput.file_path || toolInput.filePath || toolInput.path
      : "";
  if (!filePath) return 0;

  const info = pluginTargetInfo();
  if (!info) return 0; // repo not initialized yet — nothing to check against

  const repoRoot = resolveRepoRoot(hookInput, "");
  const sessionDir = baseSessionDir(repoRoot, info.runtimeDir, hookSessionId(hookInput));
  const target = resolvePathCandidate(repoRoot, filePath);

  const { allowed, reason } = checkScope(agent, target, { repoRoot, sessionDir, info });
  if (!allowed) {
    denyPreToolUse(
      `ultracode: refusing to let ultracode:${agent} write "${filePath}" — ${reason}. ` +
        "If this file genuinely needs to change, that belongs to a different agent or to the orchestrator " +
        "itself — do not retry under a different path to route around this.",
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
