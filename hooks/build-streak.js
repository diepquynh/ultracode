#!/usr/bin/env node
// Count a subagent's CONSECUTIVE failing build/test commands, so a subagent that
// cannot make progress escalates instead of grinding.
//
// Measured motivation (analysis of 912 recorded ultracode subagent runs): 15 runs
// — 1.6% of all runs — hit a streak of 4+ consecutive build failures and together
// burned 315M cache-read tokens, 10.7% of the entire corpus's spend. The worst
// single run hit a 14-failure streak over 237 tool calls and kept going for 27
// more calls afterwards. Every one of those runs was ultracode:implementer or
// ultracode:write-test. Nothing in the pipeline noticed.
//
// Reads a PostToolUse hook payload (matcher: Bash) from stdin. PostToolUse cannot
// block, so this hook only records and (past the warn threshold) speaks up via
// additionalContext; hooks/build-streak-gate.js does the actual denying on the
// NEXT build call once the deny threshold is reached.
//
// Scoped to ultracode subagents (the `agent_type` field the harness adds inside a
// subagent's turn). The orchestrator is deliberately exempt: escalation here means
// "report STUCK to the orchestrator", which the orchestrator cannot do to itself.
//
// One counter per agent, across all its build/test commands, rather than one per
// distinct command string. An agent alternating compile → test → compile while
// stuck is still stuck, and per-command counters would reset on every variation
// and never fire.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  emitAdditionalContext,
  hookToolResponse,
  commandFromToolInput,
  readJsonIfFile,
  writeJsonAtomic,
  pick,
  isAntigravity,
} = require("./lib/common");
const { pluginTargetInfo, sessionBaseDir } = require("./lib/session");
const { HookContext } = require("./lib/hook-context");
const { isBuildCommand, failedFrom, diagnosticSignature } = require("./lib/build-signal");
const { toolResultText } = require("./lib/agy-transcript");

// What the command printed. Antigravity's PostToolUse payload has no result field
// at all (only `stepIdx` and, on failure, `error`), so its output is read from the
// transcript instead — without it the diagnostic signature, the lesson recall, and
// the "same error again" detection all had nothing to work with on that harness.
function commandOutput(hookInput) {
  const response = hookToolResponse(hookInput);
  if (response !== null && response !== undefined) return response;
  const transcriptPath = pick(hookInput, "transcriptPath", "transcript_path");
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  const text = toolResultText(transcriptPath, pick(hookInput, "stepIdx", "step_idx"));
  return text || null;
}

const SCHEMA_VERSION = 1;
// Recall fires one failure BEFORE the warning: if this repo already learned the
// fix for this diagnostic, the agent should get it at attempt 2, not after it has
// burned three more. Measured: 42.9% of diagnostic occurrences in the recorded
// corpus were repeats of a signature already seen, and 12% of distinct signatures
// recurred across separate sessions — those are the ones only memory can prevent.
const RECALL_THRESHOLD = 2;
const WARN_THRESHOLD = 3;
const DENY_THRESHOLD = 5;
const MAX_HISTORY = 12;
const STATE_FILE = "build-streak.json";

// Reads the durable lesson store directly rather than through the MCP tool: a
// hook cannot call MCP, and this is the same SQLite file mcp/lib/memory.js owns.
// Wrapped so a missing store, an old Node without node:sqlite, or a locked file
// degrades to "no lessons" instead of breaking the turn.
function recallFor(repoRoot, area, query) {
  try {
    const { recallLessons } = require("../mcp/lib/memory");
    const info = pluginTargetInfo();
    if (!info) return [];
    const dbPath = path.join(repoRoot, info.runtimeDir, "memory", "knowledge.sqlite3");
    return recallLessons(dbPath, { area, query, limit: 3 }) || [];
  } catch {
    return [];
  }
}

// The module a failing path belongs to, used to scope recall. Falls back to null
// (global recall) rather than guessing.
function areaFromCommand(command) {
  const moduleFlag = command.match(/-pl\s+([\w./-]+)/);
  if (moduleFlag) return moduleFlag[1];
  return null;
}

function loadProfile(repoRoot) {
  const info = pluginTargetInfo();
  if (!info) return null;
  return readJsonIfFile(path.join(repoRoot, info.runtimeDir, "repo-profile.json"));
}

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  const context = new HookContext(hookInput);
  const actor = context.currentActor();
  const agent = actor.agent;
  if (!agent) return 0;

  const command = commandFromToolInput(context.toolInput);
  if (!command) return 0;

  const repoRoot = actor.repoRoot;
  const sessionDir = actor.sessionDir ? sessionBaseDir(actor.sessionDir) : context.sessionRoot;
  if (!sessionDir) return 0;
  const statePath = path.join(sessionDir, STATE_FILE);
  const profile = loadProfile(repoRoot);
  const { build, purpose } = isBuildCommand(command, profile);
  if (!build) return 0;

  const { failed, exitCode, text } = failedFrom(commandOutput(hookInput), hookInput);
  // `failed === null` means interrupted/timed out — no evidence either way, so
  // leave the streak exactly as it was.
  if (failed === null) return 0;

  const state = readJsonIfFile(statePath) || { schemaVersion: SCHEMA_VERSION, streaks: {} };
  state.schemaVersion = SCHEMA_VERSION;
  state.streaks = state.streaks || {};
  const entry = state.streaks[agent] || {
    consecutiveFailures: 0,
    history: [],
    lastSignature: null,
    recoveredSignatures: [],
  };

  const now = new Date().toISOString();

  if (!failed) {
    // A pass clears the streak. When it clears a streak that had reached the
    // warn threshold, that is a verified failure→recovery transition — the code
    // now actually compiles, not merely the agent's belief that it fixed things.
    // That is the moment a lesson is worth recording, and the only moment we can
    // be sure the fix was real.
    const recovered =
      entry.consecutiveFailures >= WARN_THRESHOLD && entry.lastSignature
        ? { signature: entry.lastSignature, streak: entry.consecutiveFailures }
        : null;
    if (recovered) {
      entry.recoveredSignatures = [
        ...(entry.recoveredSignatures || []),
        { ...recovered, purpose, recoveredAt: now, lessonRecorded: false },
      ].slice(-MAX_HISTORY);
    }
    entry.consecutiveFailures = 0;
    entry.lastSignature = null;
    entry.lastAt = now;
    state.streaks[agent] = entry;
    writeJsonAtomic(statePath, state);

    if (recovered) {
      emitAdditionalContext(
        "PostToolUse",
        `ultracode: that passed after ${recovered.streak} consecutive failures on "${recovered.signature}". ` +
          "Record what actually fixed it, now, while you still have it in hand — call `ultracode_memory` " +
          `with area = the affected module and a one-line lesson naming the diagnostic and the fix ` +
          "(the root cause and the correct pattern, not a narration of your debugging). This exact " +
          "diagnostic recurs across sessions in this repo; a recorded lesson is what stops the next run " +
          "from re-deriving it. Mention in your report that you recorded it.",
      );
    }
    return 0;
  }

  const signature = diagnosticSignature(text);
  entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
  entry.lastSignature = signature || entry.lastSignature || null;
  entry.lastCommand = command.slice(0, 400);
  entry.lastPurpose = purpose;
  entry.lastExitCode = exitCode;
  entry.lastAt = now;
  if (entry.consecutiveFailures === 1) entry.firstFailedAt = now;
  entry.history = [...(entry.history || []), { ts: now, purpose, signature }].slice(-MAX_HISTORY);
  state.streaks[agent] = entry;
  writeJsonAtomic(statePath, state);

  const count = entry.consecutiveFailures;
  if (count < RECALL_THRESHOLD) return 0;

  // Hand over any lesson this repo already recorded for this diagnostic. Doing
  // the lookup here rather than telling the agent to do it means it costs the
  // agent no tool call and cannot be skipped.
  const lessons = signature ? recallFor(repoRoot, areaFromCommand(command), signature) : [];
  const lessonBlock = lessons.length
    ? "\n\nThis repo has already recorded a lesson for a failure like this:\n" +
      lessons.map((l) => `  - [${l.area}] ${l.lesson}`).join("\n") +
      "\nCheck it against what you are seeing before your next attempt. If it applies, use it and say " +
      "which lesson you used. If it does not, say why, so it is not silently ignored."
    : "";

  if (count < WARN_THRESHOLD) {
    // Below the warning: only speak up if there is something concrete to hand over.
    if (lessonBlock) emitAdditionalContext("PostToolUse", `ultracode:${lessonBlock}`);
    return 0;
  }

  // At/over the warn threshold but below the deny threshold: nudge, don't block.
  // Repeating the SAME signature is the strong signal — it means the last edit
  // did not change the failure at all.
  if (count < DENY_THRESHOLD) {
    const repeated =
      signature && (entry.history || []).filter((h) => h.signature === signature).length > 1;
    const remaining = DENY_THRESHOLD - count;
    const warning =
      `ultracode: that is ${count} consecutive failing build/test commands in this run` +
      (repeated ? `, and the same diagnostic is repeating ("${signature}")` : "") +
      ". Before the next attempt, state explicitly what you now believe the root cause is and " +
      "what specifically will change — do not retry a variation of the same edit. " +
      `After ${remaining} more consecutive failure${remaining === 1 ? "" : "s"} further ` +
      'build/test commands are refused and you must hand back to the orchestrator with a "STUCK:" ' +
      "report." +
      lessonBlock;
    // Antigravity's PostToolUse output accepts `{}` and nothing else, so this
    // nudge has nowhere to go at the moment it is earned. File it instead:
    // hooks/build-streak-gate.js prepends it to the refusal it issues at the deny
    // threshold, which is a channel AGY does honor. The nudge therefore arrives
    // late on AGY (with the block, rather than two failures before it) — the
    // counter, the recall lookup, and the escalation itself are unaffected.
    if (isAntigravity()) {
      writeJsonAtomic(path.join(sessionDir, "build-streak-warning.json"), {
        warning,
        streak: count,
        ts: now,
      });
    } else {
      emitAdditionalContext("PostToolUse", warning);
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
