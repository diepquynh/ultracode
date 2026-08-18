#!/usr/bin/env node
// Hard-enforce Rules D3/D5/D10 ("the spec needs approval before ultracode:plan
// runs; the plan needs approval before ultracode:implement runs") instead of
// relying on the orchestrator's own judgment call in conversation.
//
// Reads a PreToolUse hook payload (matcher: Task|Agent / Agent) from stdin.
// Approval is recorded by the orchestrator calling the ultracode_gate MCP tool
// (mcp/gate-server.js), which writes {session-dir}/gates.json. A plan-driven
// spawn (one whose prompt carries a Phase file:) is gated on gates.plan; an
// inline no-plan spawn (Rule M3's last bullet) carries no Phase file: and is
// exempt, matching current behavior.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  denyPreToolUse,
  agentFromToolInput,
  promptFromToolInput,
  field,
  isDirectory,
  readJsonIfFile,
  hookToolInput,
  hookSessionId,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot, baseSessionDir } = require("./lib/session");

const PLAN_GATED_AGENTS = new Set([
  "implement",
  "write-test",
  "execution-path-analyzer",
  "module-documentation",
]);

function decisionFor(gates, gate) {
  return gates && gates[gate] && gates[gate].decision;
}

async function main() {
  const hookInput = await readHookInput();
  const toolInput = hookToolInput(hookInput);
  if (!toolInput || typeof toolInput !== "object") return 0;

  const agent = agentFromToolInput(toolInput);
  const needsSpecGate = agent === "plan";
  const prompt = promptFromToolInput(toolInput);
  const needsPlanGate = PLAN_GATED_AGENTS.has(agent) && Boolean(field(prompt, "Phase file"));
  if (!needsSpecGate && !needsPlanGate) return 0;

  const repoRoot = resolveRepoRoot(hookInput, prompt);
  let sessionDir = field(prompt, "Session dir");
  if (!sessionDir || !isDirectory(sessionDir)) {
    const info = pluginTargetInfo();
    if (!info) return 0;
    sessionDir = baseSessionDir(repoRoot, info.runtimeDir, hookSessionId(hookInput));
  }

  const gates = readJsonIfFile(path.join(sessionDir, "gates.json"));
  const gateCallHint =
    `ultracode_gate(session_dir: "${sessionDir}", gate: "%GATE%", decision: "approved")`;

  if (needsSpecGate && decisionFor(gates, "spec") !== "approved") {
    denyPreToolUse(
      "ultracode: refusing to spawn ultracode:plan — the spec has not been recorded as approved. " +
        "After the user approves the spec, call " +
        gateCallHint.replace("%GATE%", "spec") +
        ", then re-spawn.",
    );
    return 0;
  }

  if (needsPlanGate && decisionFor(gates, "plan") !== "approved") {
    denyPreToolUse(
      `ultracode: refusing to spawn ultracode:${agent} — this prompt names a Phase file: but the plan has ` +
        "not been recorded as approved. After the user approves the plan, call " +
        gateCallHint.replace("%GATE%", "plan") +
        ", then re-spawn.",
    );
    return 0;
  }

  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
