#!/usr/bin/env node
// Record, at spawn time, the write scope a subagent's own plan phase declares —
// so scope-guard.js and bash-scope-guard.js can hold it to that scope later.
//
// WHY A SEPARATE HOOK
//
// A Write/Edit or Bash call made INSIDE a subagent's turn carries no spawn
// prompt: the hook sees `{ file_path, content }` and an `agent_type`, nothing
// more. The phase file — the only place the intended file set is stated — is
// named in the spawn prompt, which is visible only on the Agent/Task call. So the
// scope has to be captured when the spawn happens and read back later.
//
// This hook writes state and emits NOTHING. That matters: a PreToolUse
// `updatedInput` does not merge across hooks (both hooks see the original input
// and only one survives), so a second emitting hook on Agent|Task would clobber
// model-router.js's routed model. Emitting nothing keeps it safe to run alongside.
//
// WHY SCOPE FROM THE PHASE FILE AND NOT THE SPAWN PROMPT
//
// Measured on the recorded corpus: of implement runs whose phase file still
// existed on disk, 100% of written paths (50/50) were derivable from that phase
// file, while 71% of the same writes were NOT derivable from the spawn prompt
// alone. The phase file is the artifact that actually enumerates the work.
//
// It also captures the spawn's declared `Report file:`, which the ultracode_report
// MCP tool writes to. Agents used to name their own report files, producing 27
// distinct name shapes across 1,864 artifacts and leaving the next stage to guess
// — the declared path removes the guess.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  agentFromToolInput,
  promptFromToolInput,
  field,
  isDirectory,
  readTextIfFile,
  readJsonIfFile,
  writeJsonAtomic,
  hookToolInput,
  hookSessionId,
  hookAgentType,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot, baseSessionDir } = require("./lib/session");
const { declaredPathsFrom } = require("./lib/scope-policy");

const SCHEMA_VERSION = 1;
const STATE_FILE = "spawn-scope.json";

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  // Only the orchestrator's own spawns; a nested spawn inherits nothing here.
  if (hookAgentType(hookInput)) return 0;

  const toolInput = hookToolInput(hookInput);
  if (!toolInput || typeof toolInput !== "object") return 0;
  const agent = agentFromToolInput(toolInput);
  if (!agent) return 0;

  const prompt = promptFromToolInput(toolInput);
  const repoRoot = resolveRepoRoot(hookInput, prompt);
  const info = pluginTargetInfo();
  if (!info) return 0;

  let sessionDir = field(prompt, "Session dir");
  if (!sessionDir || !isDirectory(sessionDir)) {
    sessionDir = baseSessionDir(repoRoot, info.runtimeDir, hookSessionId(hookInput));
  }

  const phaseFile = field(prompt, "Phase file");
  const phaseBody = phaseFile ? readTextIfFile(phaseFile) : null;

  // No phase file, or one that names nothing concrete, records an explicitly
  // empty scope. scope-policy.js treats that as "unscoped" and keeps the previous
  // permissive behavior — a no-plan task must still be able to work.
  const declared = phaseBody ? declaredPathsFrom(phaseBody) : { files: [], dirs: [] };

  const statePath = path.join(
    baseSessionDir(repoRoot, info.runtimeDir, hookSessionId(hookInput)),
    STATE_FILE,
  );
  try {
    const state = readJsonIfFile(statePath) || { schemaVersion: SCHEMA_VERSION, agents: {} };
    state.schemaVersion = SCHEMA_VERSION;
    state.agents = state.agents || {};
    state.agents[agent] = {
      phaseFile: phaseFile || null,
      phaseFileFound: Boolean(phaseBody),
      files: declared.files,
      dirs: declared.dirs,
      reportFile: field(prompt, "Report file") || null,
      sessionDir,
      recordedAt: new Date().toISOString(),
    };
    writeJsonAtomic(statePath, state);
  } catch {
    // Best-effort: a recording failure must never block a spawn. The guards
    // treat a missing record as unscoped.
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
