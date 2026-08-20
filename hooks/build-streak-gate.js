#!/usr/bin/env node
// Refuse a subagent's build/test command once hooks/build-streak.js has recorded
// DENY_THRESHOLD consecutive failures for it, and require a "STUCK:" hand-back to
// the orchestrator instead.
//
// This is the enforcing half of the circuit breaker. The escalation protocol it
// requires already exists and was previously unreachable: hooks/spawn-log.js
// classifies a spawn's return as status "stuck" when the text starts with
// "STUCK:", but nothing in the pipeline ever caused an agent to emit it.
//
// Reads a PreToolUse hook payload (matcher: Bash) from stdin. Subagent-scoped for
// the same reason build-streak.js is: escalation means handing back to the
// orchestrator.
//
// Deliberately narrow: it denies only further BUILD/TEST commands. The agent can
// still read files, grep, and write its STUCK report — it is stopped from
// grinding the compiler, not from finishing its turn.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  denyPreToolUse,
  hookToolInput,
  hookAgentType,
  bareAgentName,
  hookSessionId,
  field,
  isDirectory,
  readJsonIfFile,
  promptFromToolInput,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot, baseSessionDir } = require("./lib/session");
const { isBuildCommand } = require("./lib/build-signal");

const DENY_THRESHOLD = 5;
const STATE_FILE = "build-streak.json";

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  const agent = bareAgentName(hookAgentType(hookInput));
  if (!agent) return 0;

  const toolInput = hookToolInput(hookInput);
  const command = toolInput && typeof toolInput.command === "string" ? toolInput.command : "";
  if (!command) return 0;

  const prompt = promptFromToolInput(toolInput || {});
  const repoRoot = resolveRepoRoot(hookInput, prompt);
  let sessionDir = field(prompt, "Session dir");
  const info = pluginTargetInfo();
  if (!sessionDir || !isDirectory(sessionDir)) {
    if (!info) return 0;
    sessionDir = baseSessionDir(repoRoot, info.runtimeDir, hookSessionId(hookInput));
  }

  const state = readJsonIfFile(path.join(sessionDir, STATE_FILE));
  const entry = state && state.streaks && state.streaks[agent];
  if (!entry || (entry.consecutiveFailures || 0) < DENY_THRESHOLD) return 0;

  // Only gate the build loop itself.
  const profile = info
    ? readJsonIfFile(path.join(repoRoot, info.runtimeDir, "repo-profile.json"))
    : null;
  const { build } = isBuildCommand(command, profile);
  if (!build) return 0;

  const signature = entry.lastSignature;
  denyPreToolUse(
    `ultracode: refusing another build/test command for ultracode:${agent} — ` +
      `${entry.consecutiveFailures} consecutive build/test failures in this run` +
      (signature ? `, last diagnostic: "${signature}"` : "") +
      ". Retrying again is not the next step; you do not yet have the information the fix needs.\n\n" +
      "Return control to the orchestrator NOW with a report whose FIRST line is:\n" +
      `  STUCK: <one line naming the failure>\n\n` +
      "Then state, briefly: what you were trying to make work; the exact failing command; " +
      "the diagnostic verbatim; every hypothesis you already ruled out and how; and the " +
      "specific decision or missing fact you need from the orchestrator. " +
      "Do not describe this as done, and do not retry under a different command spelling " +
      "to get around this refusal — the orchestrator can supply what you are missing, " +
      "and that answer becomes a recorded lesson so the next run does not repeat this.",
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
