"use strict";

// Pure logic for the ultracode_report MCP tool, split out from mcp/gate-server.js
// so it is unit-testable without an MCP stdio transport (mirrors mcp/lib/gate.js).
//
// WHY A DECLARED PATH OWNS REPORT FILENAMES
//
// Every stage of the pipeline hands its successor a file, and until now each agent
// invented that file's name. On disk right now: 1,864 ultracode artifacts across 27
// distinct name shapes, with `ultracode-implement-progress.md`,
// `ultracode-implement-phase-3.md`,
// `ultracode-implement-20260818-125425-lambda-yaml-phase-2.md` and
// `ultracode-implement-credentials-uri.md` all coexisting for the same kind of
// output. The next agent then guesses, and misses: 32 hard read failures on
// pipeline artifacts in the recorded Grok corpus, 22 of them on one ledger.
//
// So the orchestrator declares the path once (`Report file:` in the spawn prompt,
// captured by hooks/spawn-scope.js) and this tool writes exactly there. The agent
// never chooses a filename, so there is nothing to guess downstream.
//
// This tool is the convenient way to honor that path, not the only permitted one.
// A report is often the largest single payload an agent emits, and one stalled
// write call used to strand a whole spawn's work with no fallback. So an agent may
// also write its report itself — write tool, shell heredoc, chunked appends —
// while hooks/lib/report-policy.js holds that write to this same declared path and
// to the same lesson gate below.
//
// WHY IT ALSO GATES ON PENDING LESSONS
//
// hooks/build-streak.js records a verified failure→recovery transition — a streak
// of real build failures followed by a real pass — as a pending lesson. This tool
// is the moment the agent's work becomes visible to the rest of the pipeline, and
// therefore the last point at which the fix is still in the agent's context. 42.9%
// of diagnostic occurrences in the recorded corpus were repeats of a signature
// already seen, so a recovery that goes unrecorded is a cost the next session pays
// again.

const fs = require("node:fs");
const path = require("node:path");
const { readJsonIfFile, isInside } = require("../../hooks/lib/common");
const { sessionBaseDir } = require("../../hooks/lib/session");
const { scopeRecordFor } = require("../../hooks/lib/scope-policy");
// The lesson gate and the agent-name normalization live in hooks/lib/report-policy.js
// because the same gate now applies to a hand-written report: hooks/scope-guard.js and
// hooks/bash-scope-guard.js hold a Write/Edit/shell report to the declared path and to
// this same pending-lesson check, so "write it yourself" is a fallback for a stalled
// tool call, never a way around the gate.
const {
  bareAgent,
  markLessonsRecorded,
  pendingLessons,
} = require("../../hooks/lib/report-policy");

const SPAWN_SCOPE_FILE = "spawn-scope.json";

function spawnRecord(sessionDir, agent) {
  const baseDir = sessionBaseDir(sessionDir);
  const state = readJsonIfFile(path.join(baseDir, SPAWN_SCOPE_FILE));
  return scopeRecordFor(state, {
    agent: bareAgent(agent),
    repoKey: path.relative(baseDir, path.resolve(sessionDir)),
  });
}

// Returns { ok, message, path? }.
function writeReport(sessionDir, agent, content, { allowUnrecordedLesson = false } = {}) {
  if (!sessionDir || !fs.existsSync(sessionDir)) {
    return {
      ok: false,
      message:
        `ultracode: session dir "${sessionDir}" does not exist. Pass the exact Session dir: value from ` +
        "your prompt.",
    };
  }
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, message: "ultracode: refusing to write an empty report." };
  }

  const record = spawnRecord(sessionDir, agent);
  const declared = record && record.reportFile;
  if (!declared) {
    return {
      ok: false,
      message:
        `ultracode: no report path was declared for ultracode:${bareAgent(agent)} in this session. The ` +
        "orchestrator sets it with a `Report file: {absolute path}` line in the spawn prompt. Ask the " +
        "orchestrator for it rather than inventing a filename — the next stage reads this exact path.",
    };
  }

  const target = path.resolve(declared);
  // The declared path is orchestrator-supplied, but this tool writes with the MCP
  // server's own privileges, so confine it to the session dir regardless.
  if (!isInside(path.resolve(sessionDir), target)) {
    return {
      ok: false,
      message:
        `ultracode: declared report path "${declared}" is outside the session dir "${sessionDir}"; ` +
        "refusing to write there.",
    };
  }

  const pending = pendingLessons(sessionDir, agent);
  if (pending.length && !allowUnrecordedLesson) {
    const first = pending[0];
    return {
      ok: false,
      message:
        `ultracode: refusing to write this report yet — you recovered from ${first.streak} consecutive ` +
        `build failures on "${first.signature}" and have not recorded what fixed it. Call ` +
        "`ultracode_memory` (area = the affected module, lesson = the diagnostic and the correct pattern, " +
        `session_dir = "${sessionDir}"), then write the report. This exact diagnostic recurs across ` +
        "sessions in this repo; recording it is what stops the next run re-deriving it. If the fix was " +
        "genuinely situational and teaches nothing reusable, re-call with " +
        "unrecorded_lesson_reason set to say so.",
    };
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
    fs.renameSync(tmp, target);
  } catch (error) {
    return { ok: false, message: `ultracode: failed to write "${target}": ${error.message}` };
  }

  return {
    ok: true,
    path: target,
    message:
      `Wrote ${content.length} chars to ${target}.` +
      (pending.length ? " Proceeded with an unrecorded lesson, as stated." : ""),
  };
}

module.exports = { writeReport, pendingLessons, markLessonsRecorded, spawnRecord, bareAgent };
