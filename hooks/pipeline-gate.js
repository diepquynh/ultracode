#!/usr/bin/env node
// Hard-enforce Rules D3/D5/D10 ("the spec needs approval before ultracode:plan
// runs; the plan needs approval before ultracode:implement runs") instead of
// relying on the orchestrator's own judgment call in conversation.
//
// Reads a PreToolUse hook payload (matcher: Task|Agent / Agent) from stdin.
// Approval is recorded by the orchestrator calling the ultracode_gate MCP tool
// (mcp/gate-server.js), which writes {session-dir}/gates.json — the session dir
// itself, since one spec and one plan cover every repo in scope. A plan-driven
// spawn (one whose prompt carries a Phase file:) is gated on gates.plan.
//
// An inline no-plan ultracode:implement spawn (Rule M3's last bullet) is still
// permitted, but it must now SAY it is one. Omitting Phase file: used to be a
// silent exemption from every plan gate, and in the recorded corpus 96% of
// implement spawns (248 of 258) took it — the plan tier was effectively optional
// in practice while appearing mandatory in the rules. Requiring an explicit
// "No plan:" line turns that from an accident into a decision: the orchestrator
// states why there is no plan, and the omission becomes visible in the transcript
// instead of looking identical to a spawn that simply forgot the phase file.

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
const {
  pluginTargetInfo,
  resolveRepoRoot,
  baseSessionDir,
  sessionBaseDir,
  normalizeRepoKey,
} = require("./lib/session");

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
  const phaseFile = field(prompt, "Phase file");
  const needsPlanGate = PLAN_GATED_AGENTS.has(agent) && Boolean(phaseFile);

  // Scoped to implement alone: it is the agent that writes code, and the one the
  // bypass data is about. write-test / EPA / module-documentation legitimately
  // run standalone for a directly requested stage.
  if (agent === "implement" && !phaseFile && !field(prompt, "No plan")) {
    denyPreToolUse(
      "ultracode: refusing to spawn ultracode:implement without a plan. Add ONE of:\n" +
        "  Phase file: {session-dir}/ultracode-phase-{N}-{slug}.md   — the normal path, once the plan is approved\n" +
        "  No plan: {one line saying why this task does not need one}  — for a genuinely small inline change\n" +
        "A phase file also scopes the agent's writes to the files the phase declares, so a planned spawn is " +
        "both gated and confined; a bare spawn is neither.",
    );
    return 0;
  }

  if (!needsSpecGate && !needsPlanGate) return 0;

  const repoRoot = resolveRepoRoot(hookInput, prompt);
  let sessionDir = field(prompt, "Session dir");
  if (!sessionDir || !isDirectory(sessionDir)) {
    const info = pluginTargetInfo();
    if (!info) return 0;
    sessionDir = baseSessionDir(repoRoot, info.runtimeDir, hookSessionId(hookInput));
  }

  // A spec/plan approval is one session-level decision — one spec and one plan
  // cover every repo in scope — so it is read from the session dir itself, not
  // from whichever repo-key subdirectory this particular spawn is scoped to.
  // Reading it relative to the declared dir meant a phase spawn scoped to
  // `{SESSION_DIR}/{repo-key}` looked for an approval the ultracode_gate call
  // had recorded at `{SESSION_DIR}`, and every such spawn was refused for a
  // plan the user had in fact approved.
  const gates = readJsonIfFile(path.join(sessionBaseDir(sessionDir), "gates.json"));
  // The key this spawn declares is the one whose fact-check verdict the gate tool
  // will look for, so quoting it back makes the hint a call the orchestrator can
  // issue as-is rather than one it has to reconstruct.
  const repoKey = normalizeRepoKey(field(prompt, "Repo key")) || "{repo-key}";
  const gateCallHint =
    `ultracode_gate(session_dir: "${sessionDir}", repo_key: "${repoKey}", gate: "%GATE%", ` +
    'decision: "approved")';

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
