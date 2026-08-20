#!/usr/bin/env node
// Structured session/pipeline tracker for "Progress tracking" (skills/orchestrate/prompt.md).
// TaskCreate/TaskUpdate already give the user a live view; this gives the *next* turn (in
// particular one that starts after a context compaction) a file-backed, queryable record of
// every completed spawn, independent of the model remembering to have called TaskUpdate.
//
// Reads a PostToolUse hook payload (matcher: Task|Agent / Agent) from stdin. PostToolUse
// cannot block — this only appends to {session-dir}/progress.json, and never denies.

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
  hookToolInput,
  hookToolResponse,
  hookSessionId,
  hookAgentType,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot, baseSessionDir } = require("./lib/session");

const MAX_RECORDS = 200;
const SCHEMA_VERSION = 1;

function summarize(toolResponse) {
  if (toolResponse == null) return "";
  if (typeof toolResponse === "string") return toolResponse.trim().split("\n")[0].slice(0, 200);
  if (typeof toolResponse === "object") {
    if (typeof toolResponse.systemMessage === "string") return toolResponse.systemMessage;
    if (typeof toolResponse.result === "string") return toolResponse.result.trim().split("\n")[0].slice(0, 200);
  }
  return "";
}

function statusOf(toolResponse) {
  if (toolResponse && typeof toolResponse === "object" && (toolResponse.isError || toolResponse.is_error)) {
    return "error";
  }
  const text =
    typeof toolResponse === "string"
      ? toolResponse
      : toolResponse && typeof toolResponse.result === "string"
        ? toolResponse.result
        : "";
  if (/^\s*STUCK:/m.test(text)) return "stuck";
  if (/^\s*HANDOFF:/m.test(text)) return "handoff";
  return "ok";
}

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;

  // A spawn made from inside another agent's turn is still a spawn, and it is
  // exactly the kind that goes missing from a post-compaction reconstruction.
  // Recorded so the record is complete, tagged so it is distinguishable.
  const parentAgent = hookAgentType(hookInput);

  const toolInput = hookToolInput(hookInput);
  if (!toolInput || typeof toolInput !== "object") return 0;
  const agent = agentFromToolInput(toolInput);
  if (!agent) return 0;

  const prompt = promptFromToolInput(toolInput);
  const repoRoot = resolveRepoRoot(hookInput, prompt);

  let sessionDir = field(prompt, "Session dir");
  if (!sessionDir || !isDirectory(sessionDir)) {
    const info = pluginTargetInfo();
    if (!info) return 0;
    sessionDir = baseSessionDir(repoRoot, info.runtimeDir, hookSessionId(hookInput));
  }

  const phaseFile = field(prompt, "Phase file");
  const phaseMatch = (phaseFile || prompt).match(/phase-(\d+)/);
  const record = {
    ts: new Date().toISOString(),
    agent,
    phase: phaseMatch ? `phase-${phaseMatch[1]}` : null,
    status: statusOf(hookToolResponse(hookInput)),
    summary: summarize(hookToolResponse(hookInput)),
    ...(parentAgent ? { spawnedBy: parentAgent } : {}),
    ...(field(prompt, "Report file") ? { reportFile: field(prompt, "Report file") } : {}),
  };

  try {
    const progressPath = path.join(sessionDir, "progress.json");
    const current = readJsonIfFile(progressPath) || { schemaVersion: SCHEMA_VERSION, records: [] };
    current.schemaVersion = SCHEMA_VERSION;
    current.records = [...(current.records || []), record].slice(-MAX_RECORDS);
    writeJsonAtomic(progressPath, current);
  } catch {
    // Best-effort bookkeeping only — never fail the turn over a logging error.
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
