#!/usr/bin/env node
// Shared reading of what a subagent handed back, and the shape of the
// {session-dir}/progress.json record built from it.
//
// hooks/spawn-log.js writes that record when a spawn returns, which on every
// harness except Antigravity is also when the agent's answer is available. Under
// AGY the spawn call returns an acknowledgement and the answer arrives later as a
// message, so spawn-log recorded every AGY spawn as `status: "ok"` with an empty
// summary — a post-compaction log that says an agent ran and nothing about what it
// said, including when it handed back STUCK. hooks/agy-message-record.js completes
// those records from the message, and shares this module so "stuck" means the same
// thing whichever path recorded it.

"use strict";

const path = require("node:path");
const { readJsonIfFile, writeJsonAtomic } = require("./common");

const SCHEMA_VERSION = 1;
const MAX_RECORDS = 200;
const PROGRESS_FILE = "progress.json";

function summarize(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim().split("\n")[0].slice(0, 200);
  if (typeof value === "object") {
    if (typeof value.systemMessage === "string") return value.systemMessage;
    if (typeof value.result === "string") return value.result.trim().split("\n")[0].slice(0, 200);
  }
  return "";
}

// An agent reports being unable to finish with a "STUCK:"/"HANDOFF:" line — the
// escalation contract in every agent prompt — so those are read back as statuses
// rather than left to look like a normal completion.
function statusOf(value) {
  if (value && typeof value === "object" && (value.isError || value.is_error)) return "error";
  const text =
    typeof value === "string"
      ? value
      : value && typeof value.result === "string"
        ? value.result
        : "";
  if (/^\s*STUCK:/m.test(text)) return "stuck";
  if (/^\s*HANDOFF:/m.test(text)) return "handoff";
  return "ok";
}

function progressPath(sessionDir) {
  return path.join(sessionDir, PROGRESS_FILE);
}

function loadProgress(sessionDir) {
  const current = readJsonIfFile(progressPath(sessionDir)) || {
    schemaVersion: SCHEMA_VERSION,
    records: [],
  };
  current.schemaVersion = SCHEMA_VERSION;
  current.records = Array.isArray(current.records) ? current.records : [];
  return current;
}

function saveProgress(sessionDir, progress) {
  progress.records = progress.records.slice(-MAX_RECORDS);
  writeJsonAtomic(progressPath(sessionDir), progress);
}

// Fills in what a subagent actually returned, on the record spawn-log.js already
// wrote for that spawn. Returns the completed record, or null when there was
// nothing to do (this message is already recorded).
//
// The record completed is the newest one for that agent still missing its return —
// spawn order and message order agree per agent, and a re-spawn of the same agent
// gets its own record. When no record is waiting (spawn-log never saw the spawn,
// e.g. the harness dropped the PostToolUse call) one is appended, so the message is
// never simply lost.
function recordAgentMessage(sessionDir, { agent, text, step, phase = null }) {
  if (!agent) return null;
  const progress = loadProgress(sessionDir);
  if (progress.records.some((record) => record && record.messageStep === step)) return null;

  const summary = summarize(text);
  const status = statusOf(text);
  const pending = [...progress.records]
    .reverse()
    .find(
      (record) =>
        record && record.agent === agent && !record.messageStep && !record.summary,
    );

  if (pending) {
    pending.summary = summary;
    pending.status = status;
    pending.messageStep = step;
    saveProgress(sessionDir, progress);
    return pending;
  }

  const record = {
    ts: new Date().toISOString(),
    agent,
    phase,
    status,
    summary,
    messageStep: step,
  };
  progress.records.push(record);
  saveProgress(sessionDir, progress);
  return record;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_RECORDS,
  PROGRESS_FILE,
  summarize,
  statusOf,
  progressPath,
  loadProgress,
  saveProgress,
  recordAgentMessage,
};
