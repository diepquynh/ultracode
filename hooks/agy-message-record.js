#!/usr/bin/env node
// Antigravity's replacement for the PostToolUse hooks that read what a subagent
// returned: hooks/factcheck-record.js (factcheck.json) and the return half of
// hooks/spawn-log.js (progress.json).
//
// Both read the spawn's tool result, which every harness but AGY provides. Under
// AGY the answer arrives as a SYSTEM_MESSAGE step instead (see
// hooks/lib/agy-transcript.js for the mechanics and for why that message is
// trustworthy evidence), so this hook runs on `PreInvocation`/`PostInvocation` —
// the two events that fire around the model's turn and carry `transcriptPath` —
// and records what the transcript already proves:
//
//   * ultracode:fact-check verdicts -> {session-dir}/{repo-key}/factcheck.json
//   * every subagent's return       -> the waiting {session-dir}/progress.json
//                                      record's summary and status
//
// Writing the same files in the same schemas means mcp/gate-server.js,
// hooks/pipeline-gate.js, hooks/session-resume.js and the ledger policy all keep
// working unchanged: AGY stops being the harness where a fact-check verdict
// silently never lands and the pipeline deadlocks at the spec gate, and where the
// post-compaction log said every agent finished "ok" with nothing to show —
// including the ones that handed back STUCK.
//
// It also runs on `PostToolUse` for every tool, because AGY can deliver a
// subagent's message part-way through an invocation: observed live, the
// orchestrator received the verdict and called ultracode_gate in the same
// invocation, so a Pre/PostInvocation-only recorder was still one step behind and
// the gate answered "none recorded" for a verdict that had already arrived. Firing
// after each tool call closes that window — a retry of the gate call in the same
// turn now finds the file.
//
// Idempotent: each target records the transcript step it came from, so re-firing
// this often neither rewrites the file nor inflates `rounds`. When a new verdict IS
// recorded, the hook injects one ephemeral message saying so — the recorded failure
// was an orchestrator that could not tell whether the checkpoint existed, and a
// hook that records silently invites the same guessing. `injectSteps` is only legal
// on the invocation events; PostToolUse must answer with a bare `{}` or AGY rejects
// the whole response as an unknown field.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  emit,
  isDirectory,
  readJsonIfFile,
  writeJsonAtomic,
  pick,
} = require("./lib/common");
const { normalizeRepoKey, repoStateDir } = require("./lib/session");
const { HookContext } = require("./lib/hook-context");
const { subagentMessages, subagentVerdicts } = require("./lib/agy-transcript");
const { recordAgentMessage } = require("./lib/spawn-record");

// Where the verdict belongs: the session dir its own spawn prompt declared, else
// the formula every prompt derives, rooted at the repo that spawn named.
function resolveSessionDir(record, context) {
  if (record.sessionDir && isDirectory(record.sessionDir)) return record.sessionDir;
  return context.sessionRoot || null;
}

// Same (session dir, repo key) addressing as hooks/factcheck-record.js on every
// other harness, and the same refusal to guess: the repo key comes from the
// fact-check spawn's own `Repo key:` line, and without it there is no path
// ultracode_gate would also resolve to.
function recordVerdict(sessionDir, repoKey, record) {
  const stateDir = repoStateDir(sessionDir, repoKey);
  if (!stateDir) return null;
  const factcheckPath = path.join(stateDir, "factcheck.json");
  const current = readJsonIfFile(factcheckPath) || {};
  const existing = current[record.target];
  if (existing && existing.sourceStep === record.step) return null; // already recorded

  current[record.target] = {
    verdict: record.verdict,
    rounds: ((existing && existing.rounds) || 0) + 1,
    findings: record.findings,
    repo: repoKey,
    ts: new Date().toISOString(),
    sourceStep: record.step,
    sender: record.sender,
  };
  writeJsonAtomic(factcheckPath, current);
  return factcheckPath;
}

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  const context = new HookContext(hookInput);
  const transcriptPath = pick(hookInput, "transcriptPath", "transcript_path");
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    emit({});
    return 0;
  }

  // Only the newest verdict per target matters: an earlier FAIL that a re-spawn
  // has since turned into a PASS is history, not the current state of the gate.
  const latest = new Map();
  for (const record of subagentVerdicts(transcriptPath)) {
    if (record.agent !== "fact-check") continue;
    latest.set(record.target, record);
  }

  const recorded = [];
  const keyless = [];
  for (const record of latest.values()) {
    const sessionDir = resolveSessionDir(record, context);
    if (!sessionDir) continue;
    const repoKey = normalizeRepoKey(record.repoKey);
    if (!repoKey) {
      keyless.push(`${record.target}: ${record.verdict}`);
      continue;
    }
    try {
      if (recordVerdict(sessionDir, repoKey, record)) {
        recorded.push(`${record.target}: ${record.verdict}`);
      }
    } catch {
      // Best-effort capture only — never break the turn over a recording error.
    }
  }

  // Every subagent's return, not just the fact-checker's, completes the
  // progress.json record hooks/spawn-log.js opened for that spawn. This is the log
  // hooks/session-resume.js reads back after a compaction, so an AGY session that
  // compacts mid-pipeline can see which agents finished and which handed back
  // STUCK instead of a uniform wall of "ok".
  const escalations = [];
  for (const message of subagentMessages(transcriptPath)) {
    const sessionDir = resolveSessionDir(message, hookInput);
    if (!sessionDir) continue;
    try {
      const record = recordAgentMessage(sessionDir, {
        agent: message.agent,
        text: message.body,
        step: message.step,
      });
      if (record && (record.status === "stuck" || record.status === "handoff")) {
        escalations.push(`ultracode:${message.agent} returned ${record.status.toUpperCase()}`);
      }
    } catch {
      // Same best-effort contract as above.
    }
  }

  // PreInvocation/PostInvocation carry invocationNum and accept injectSteps;
  // PostToolUse carries stepIdx and accepts nothing else.
  const canInject = typeof pick(hookInput, "invocationNum", "invocation_num") === "number";
  const notes = [];
  if (recorded.length) {
    notes.push(
      `ultracode: recorded ultracode:fact-check's verdict into factcheck.json (${recorded.join(", ")}). ` +
        "The spec/plan gate can now read it — call ultracode_gate with the same session_dir and the same " +
        "repo_key once the user has approved. Do not write this file yourself.",
    );
  }
  // A keyless spawn is the one case where the verdict arrived and still cannot be
  // recorded anywhere the gate will look, so the orchestrator has to hear it: on
  // AGY there is no PreToolUse denial to catch it at spawn time.
  if (keyless.length) {
    notes.push(
      `ultracode: ultracode:fact-check returned ${keyless.join(", ")}, and it was NOT recorded — that ` +
        "spawn carried no valid `Repo key:` line, so there is no factcheck.json path this hook and " +
        "ultracode_gate would both resolve to. Re-spawn ultracode:fact-check with `Repo key: {repo-key}` " +
        "and call ultracode_gate with that same repo_key. Do not write factcheck.json yourself.",
    );
  }
  // An escalation is the one return the orchestrator must not skim past: the agent
  // is telling it that it could not finish.
  if (escalations.length) {
    notes.push(
      `ultracode: ${escalations.join("; ")}. Read that agent's message in full and decide the next step — ` +
        "a STUCK/HANDOFF return is not a completed stage, and re-spawning it unchanged repeats the failure.",
    );
  }
  if (notes.length === 0 || !canInject) {
    emit({});
    return 0;
  }
  emit({ injectSteps: notes.map((ephemeralMessage) => ({ ephemeralMessage })) });
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
