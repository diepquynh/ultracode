#!/usr/bin/env node
// Auto-capture ultracode:fact-check's verdict into
// {session-dir}/{repo-key}/factcheck.json — code-enforced capture, not dependent
// on the orchestrator remembering to record anything. mcp/gate-server.js's
// ultracode_gate tool reads that same (session dir, repo key) pair before it will
// honor an "approved" decision for the matching gate (spec/plan).
//
// The repo key comes from the spawn's own `Repo key:` line and is required: with
// no key there is no one directory both this hook and the gate tool agree on, and
// a verdict recorded in the wrong one reads back at the gate as "none recorded" —
// the deadlock this file exists to prevent. So a keyless spawn records nothing and
// says so, instead of writing state the gate will never find.
//
// Reads a PostToolUse hook payload (matcher: Task|Agent / Agent) from stdin.
// PostToolUse cannot block — this only records, and never denies.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  agentFromToolInput,
  promptFromToolInput,
  emitAdditionalContext,
  field,
  isDirectory,
  readJsonIfFile,
  writeJsonAtomic,
  extractJsonObject,
  hookToolInput,
  hookToolResponse,
  hookSessionId,
} = require("./lib/common");
const {
  pluginTargetInfo,
  resolveRepoRoot,
  baseSessionDir,
  normalizeRepoKey,
  repoStateDir,
} = require("./lib/session");

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;

  const toolInput = hookToolInput(hookInput);
  if (!toolInput || typeof toolInput !== "object") return 0;
  if (agentFromToolInput(toolInput) !== "fact-check") return 0;

  const payload = extractJsonObject(hookToolResponse(hookInput));
  const target = payload && (payload.target === "spec" || payload.target === "plan") ? payload.target : null;
  const verdict = payload && (payload.verdict === "PASS" || payload.verdict === "FAIL") ? payload.verdict : null;
  if (!target || !verdict) return 0; // malformed/unparseable return — nothing safe to record

  const prompt = promptFromToolInput(toolInput);
  const repoRoot = resolveRepoRoot(hookInput, prompt);
  let sessionDir = field(prompt, "Session dir");
  if (!sessionDir || !isDirectory(sessionDir)) {
    const info = pluginTargetInfo();
    if (!info) return 0;
    sessionDir = baseSessionDir(repoRoot, info.runtimeDir, hookSessionId(hookInput));
  }

  const repoKey = normalizeRepoKey(field(prompt, "Repo key"));
  if (!repoKey) {
    emitAdditionalContext(
      "PostToolUse",
      `ultracode: ultracode:fact-check returned ${verdict} for the ${target}, and it was NOT recorded — ` +
        "that spawn carried no valid `Repo key:` line, so there is no factcheck.json path this hook and " +
        "ultracode_gate would both resolve to. Re-spawn ultracode:fact-check with `Repo key: {repo-key}` " +
        "(the lowercase slug from Step 0, matching the repo-key subdirectory of its `Session dir:`), then " +
        "call ultracode_gate with that same repo_key. Do not write factcheck.json yourself.",
    );
    return 0;
  }

  try {
    const factcheckPath = path.join(repoStateDir(sessionDir, repoKey), "factcheck.json");
    const current = readJsonIfFile(factcheckPath) || {};
    const priorRounds = (current[target] && current[target].rounds) || 0;
    current[target] = {
      verdict,
      rounds: priorRounds + 1,
      findings: Array.isArray(payload.findings) ? payload.findings : [],
      repo: repoKey,
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
