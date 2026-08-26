#!/usr/bin/env node
// Where a stage report may be written — independent of which tool writes it.
//
// mcp/lib/report.js explains why the orchestrator, not the agent, names each
// report: agents naming their own produced 27 filename shapes across 1,864
// artifacts, and the next stage then guessed and missed. That rule was enforced
// only by the ultracode_report tool owning the path, which in turn made the tool
// the ONLY way to produce a report. A single stalled or failed tool call then had
// no fallback, and the whole spawn's work was stranded behind it.
//
// So the constraint moves off the tool and onto the path: any mechanism may write
// the report — the write tool, a shell heredoc, chunked appends — as long as it
// writes the exact path the spawn declared, under the session dir for that spawn's
// repo key. This policy is what makes that safe, and it is applied to Write/Edit
// (scope-guard.js) and to shell writes (bash-scope-guard.js) alike, so the rule
// does not depend on which tool the model reached for.
//
// Two things are checked, only for agents whose report path the orchestrator
// declares:
//   1. A session-dir `ultracode-*` artifact from one of those agents must BE the
//      declared report (their own ledgers excepted — ledger-policy.js owns those).
//      An invented sibling name is the exact failure the declared path exists to
//      prevent.
//   2. The build-streak lesson gate that ultracode_report enforces (mcp/lib/
//      report.js) applies to a hand-written report too. Otherwise "write it
//      yourself instead" would be a way to skip recording a verified failure→
//      recovery, and 42.9% of diagnostics in the recorded corpus were repeats of a
//      signature already seen.

"use strict";

const path = require("node:path");
const { isInside, readJsonIfFile, writeJsonAtomic } = require("./common");
const { sessionBaseDir } = require("./session");
const { AGENT_OWNED } = require("./ledger-policy");

const BUILD_STREAK_FILE = "build-streak.json";

// The agents whose spawn prompt carries `Report file: {absolute path}`
// (hooks/subagent-parameters.json, commands/orchestrate/prompt.md). Every other
// agent names its own session artifacts from the pattern in its prompt.md, so
// there is no declared path to hold it to.
const DECLARED_REPORT_AGENTS = new Set([
  "implement",
  "write-test",
  "execution-path-analyzer",
  "module-documentation",
]);

function bareAgent(agent) {
  const value = String(agent || "").trim();
  return value.startsWith("ultracode:") ? value.slice("ultracode:".length) : value;
}

// Recoveries this agent has not yet turned into a lesson. `sessionDir` may be the
// session base or one repo-key subdirectory of it: hooks/build-streak.js records
// the streak at the base, so both forms must resolve there or a gate reads an
// empty file for a streak that exists.
function pendingLessons(sessionDir, agent) {
  const state = readJsonIfFile(path.join(sessionBaseDir(sessionDir), BUILD_STREAK_FILE));
  const entry = state && state.streaks && state.streaks[bareAgent(agent)];
  if (!entry || !Array.isArray(entry.recoveredSignatures)) return [];
  return entry.recoveredSignatures.filter((item) => item && item.lessonRecorded === false);
}

// Called by the ultracode_memory tool once a lesson is actually recorded, so the
// gate reflects reality rather than a flag nobody clears. Marks ALL pending
// recoveries for the session as recorded: the agent has just written the lesson
// for the failure it was working on, and a stale pending entry would block a later
// report for work already learned from.
function markLessonsRecorded(sessionDir, agent) {
  const statePath = path.join(sessionBaseDir(sessionDir), BUILD_STREAK_FILE);
  const state = readJsonIfFile(statePath);
  if (!state || !state.streaks) return 0;
  const keys = agent ? [bareAgent(agent)] : Object.keys(state.streaks);
  let cleared = 0;
  for (const key of keys) {
    const entry = state.streaks[key];
    if (!entry || !Array.isArray(entry.recoveredSignatures)) continue;
    for (const item of entry.recoveredSignatures) {
      if (item && item.lessonRecorded === false) {
        item.lessonRecorded = true;
        cleared += 1;
      }
    }
  }
  if (cleared) {
    try {
      writeJsonAtomic(statePath, state);
    } catch {
      return 0;
    }
  }
  return cleared;
}

// Every report path this session declared for `agent`, across repo keys. The
// per-spawn record (scopeRecordFor) is the right one to quote in a deny message,
// but a cross-repo session holds one record per repo key and a leaf tool call whose
// `Repo key:` did not survive the payload can resolve to a sibling's record. Any
// path this agent was genuinely handed is therefore accepted: an invented name
// still matches nothing, which is what this check is for.
function declaredReportPaths(state, agent) {
  const paths = new Set();
  const add = (record) => {
    if (record && typeof record === "object" && record.reportFile) {
      paths.add(path.resolve(record.reportFile));
    }
  };
  const scopes = state && state.scopes && state.scopes[agent];
  if (scopes && typeof scopes === "object") for (const record of Object.values(scopes)) add(record);
  add(state && state.agents && state.agents[agent]);
  return paths;
}

// A ledger this agent is the documented writer of (ultracode-review-ledger-*.md,
// ultracode-implement-progress-*.md). Those are session artifacts it writes by
// hand today; ledger-policy.js already decides who may touch them.
function ownsLedger(agent, base) {
  return AGENT_OWNED.some((entry) => entry.pattern.test(base) && entry.owners.includes(agent));
}

const LESSON_GATE_HINT =
  "Record it with `ultracode_memory` (area = the affected module, lesson = the diagnostic and the " +
  "correct pattern, session_dir = your prompt's `Session dir:`), then write the report. If the fix was " +
  "genuinely situational and teaches nothing reusable, write the report through `ultracode_report` with " +
  "`unrecorded_lesson_reason` saying so — that is the only channel that carries the reason.";

// Returns { allowed: true } or { allowed: false, reason }. `targetPath` must be
// absolute and resolved. `ctx` = { sessionRoot, declaredScope, state } —
// declaredScope is this spawn's spawn-scope.json record and `state` is that whole
// file, whose `reportFile` values are the declared paths.
function checkReportWrite(agent, targetPath, ctx) {
  const name = bareAgent(agent);
  if (!DECLARED_REPORT_AGENTS.has(name)) return { allowed: true };

  const { sessionRoot, declaredScope, state } = ctx || {};
  const root = sessionRoot ? sessionBaseDir(sessionRoot) : "";
  // Only session artifacts are this policy's business: project source is
  // scope-policy.js's, and a path outside every governed root is already denied
  // there for these agents.
  if (!root || !isInside(root, targetPath)) return { allowed: true };

  const base = path.basename(targetPath);
  if (!base.startsWith("ultracode-")) return { allowed: true };
  if (ownsLedger(name, base)) return { allowed: true };

  const accepted = declaredReportPaths(state, name);
  const own = declaredScope && declaredScope.reportFile ? path.resolve(declaredScope.reportFile) : "";
  if (own) accepted.add(own);
  // No declared path means the orchestrator omitted the `Report file:` line. The
  // agent's prompt tells it to ask for one rather than invent a name; denying the
  // write here would only strand a spawn over the orchestrator's omission.
  if (accepted.size === 0) return { allowed: true };

  if (!accepted.has(path.resolve(targetPath))) {
    const declared = own || [...accepted][0];
    return {
      allowed: false,
      reason:
        `not the report path the orchestrator declared for this spawn ("${declared}"). ` +
        "The next stage reads that exact path, so a name you choose is a name it cannot find. " +
        "Write your report there instead — with any mechanism you like, including a shell heredoc " +
        "or chunked appends if a single large write call stalls",
    };
  }

  const pending = pendingLessons(root, name);
  if (pending.length) {
    const first = pending[0];
    return {
      allowed: false,
      reason:
        `your report, but you recovered from ${first.streak} consecutive build failures on ` +
        `"${first.signature}" and have not recorded what fixed it. ${LESSON_GATE_HINT} ` +
        "This exact diagnostic recurs across sessions in this repo; recording it is what stops the " +
        "next run re-deriving it",
    };
  }

  return { allowed: true };
}

module.exports = {
  DECLARED_REPORT_AGENTS,
  checkReportWrite,
  pendingLessons,
  markLessonsRecorded,
  bareAgent,
};
