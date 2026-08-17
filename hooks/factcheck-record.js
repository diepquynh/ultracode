#!/usr/bin/env node
// Auto-capture ultracode:fact-check's verdict into {session-dir}/factcheck.json —
// code-enforced capture, not dependent on the orchestrator remembering to record
// anything. mcp/gate-server.js's ultracode_gate tool reads this file before it
// will honor an "approved" decision for the matching gate (spec/plan).
//
// Reads a PostToolUse hook payload (matcher: Task|Agent / Agent) from stdin.
// PostToolUse cannot block — this only records, and never denies.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  agentFromToolInput,
  promptFromToolInput,
  field,
  isDirectory,
  readJsonIfFile,
  writeJsonAtomic,
  extractJsonObject,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot, baseSessionDir } = require("./lib/session");

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;

  const toolInput = hookInput.tool_input;
  if (!toolInput || typeof toolInput !== "object") return 0;
  if (agentFromToolInput(toolInput) !== "fact-check") return 0;

  const payload = extractJsonObject(hookInput.tool_response);
  const target = payload && (payload.target === "spec" || payload.target === "plan") ? payload.target : null;
  const verdict = payload && (payload.verdict === "PASS" || payload.verdict === "FAIL") ? payload.verdict : null;
  if (!target || !verdict) return 0; // malformed/unparseable return — nothing safe to record

  const prompt = promptFromToolInput(toolInput);
  const repoRoot = resolveRepoRoot(hookInput, prompt);
  let sessionDir = field(prompt, "Session dir");
  if (!sessionDir || !isDirectory(sessionDir)) {
    const info = pluginTargetInfo();
    if (!info) return 0;
    sessionDir = baseSessionDir(repoRoot, info.runtimeDir, hookInput.session_id);
  }

  try {
    const factcheckPath = path.join(sessionDir, "factcheck.json");
    const current = readJsonIfFile(factcheckPath) || {};
    const priorRounds = (current[target] && current[target].rounds) || 0;
    current[target] = {
      verdict,
      rounds: priorRounds + 1,
      findings: Array.isArray(payload.findings) ? payload.findings : [],
      ts: new Date().toISOString(),
    };
    writeJsonAtomic(factcheckPath, current);
  } catch {
    // Best-effort capture only — never fail the turn over a recording error.
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
