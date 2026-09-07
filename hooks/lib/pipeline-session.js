#!/usr/bin/env node
// Marks the sessions that drive the pipeline, so a guard can apply to them
// without applying to every session that happens to have this plugin
// installed.
//
// One guard needs this: hooks/profile-read-guard.js, which refuses a primary
// session's read of repo-profile.json. That refusal belongs to an orchestrate
// or hub-listen session, where reading the profile means re-deciding routing
// the hooks and the hub already own. In an ordinary session the same read is
// just a user looking at their own config, and denying it would be noise.
//
// hooks/skill-init-guard.js already sees both ways either command loads (the
// Skill tool, and the Read/Bash call the harnesses without one use), so it
// records the marker there. A missing marker allows the read: the command
// prompts still forbid it, and a guard that fires on the wrong sessions is
// worse than one that occasionally does not fire.
//
// Machine state, one small file per session, same store as the compaction
// markers in lib/grok-hooks.js.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { machineStateRoot, sanitizeSessionId } = require("./common");

const PIPELINE_COMMANDS = new Set(["orchestrate", "hub-listen"]);

function markerPath(target, sessionId) {
  return path.join(
    machineStateRoot(),
    "pipeline-sessions",
    `${target}:${sanitizeSessionId(sessionId)}.json`,
  );
}

// Idempotent: re-invoking the command in the same session rewrites the same
// file. Returns false when the write failed, and no caller treats that as an
// error — the marker only ever widens what a guard covers.
function recordPipelineSession(target, sessionId, command) {
  if (!PIPELINE_COMMANDS.has(command)) return false;
  const file = markerPath(target, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ command, ts: new Date().toISOString() }), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function isPipelineSession(target, sessionId) {
  return Boolean(pipelineSessionCommand(target, sessionId));
}

// Which command this session loaded, or "". The distinction matters to
// hooks/model-router.js: harness routing binds an orchestrate session, which
// chooses where each stage runs, and not a hub-listen worker, whose harness was
// settled by the claim that handed it the task.
function pipelineSessionCommand(target, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(markerPath(target, sessionId), "utf-8");
  } catch {
    return "";
  }
  try {
    const parsed = JSON.parse(raw);
    const command = parsed && typeof parsed.command === "string" ? parsed.command : "";
    return PIPELINE_COMMANDS.has(command) ? command : "";
  } catch {
    return "";
  }
}

module.exports = {
  PIPELINE_COMMANDS,
  isPipelineSession,
  markerPath,
  pipelineSessionCommand,
  recordPipelineSession,
};
