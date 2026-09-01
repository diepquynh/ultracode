"use strict";

// YOLO-mode state: the record that the user has switched one primary ultracode
// session into fully autonomous implementation ("YOLO") so an unattended run —
// tokenmaxxing overnight after approving the spec and the plan — is never
// parked on a question nobody is present to answer.
//
// The state is machine-level and keyed by the primary session, not by repo:
// one file per `ultracode-session-<id>` under ~/.ultracode/hub/yolo, holding
// one entry per session base dir (two repos can never share an absolute base
// dir, so the base path is the dedupe key). Every participant of that session
// — the orchestrator's own subagents, and hub-listen workers that adopted the
// shared dir — resolves the same file from the session dir alone.
//
// Written by the hub daemon only (the ultracode_yolo_set tool), mirroring
// hooks/lib/session-link.js: machine state is write-guarded against
// model-issued writes (hooks/lib/common.js isMachineStatePath), so YOLO cannot
// be switched on by a hand-authored file — only through the tool, which
// requires the caller to be a registered participant of the session. Hooks
// (review-cap.js) read it locally: no network call on the spawn path, and a
// toggle survives a hub restart mid-session.

const fs = require("node:fs");
const path = require("node:path");
const { machineStateRoot, sanitizeSessionId } = require("./common");
const { sessionBaseDir } = require("./session");

function yoloDir() {
  return path.join(machineStateRoot(), "hub", "yolo");
}

// The shared identity of a session dir: the `ultracode-session-<id>` name with
// its prefix stripped — the same derivation the hub registry uses, so the
// daemon and every hook resolve one file from either side.
function ultracodeSessionIdFromDir(sessionDir) {
  const name = path.basename(sessionBaseDir(sessionDir));
  return name.startsWith("ultracode-session-") ? name.slice("ultracode-session-".length) : name;
}

function yoloFilePath(ultracodeSessionId) {
  return path.join(yoloDir(), `${sanitizeSessionId(ultracodeSessionId)}.json`);
}

function readYoloEntries(ultracodeSessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(yoloFilePath(ultracodeSessionId), "utf-8"));
    return parsed && Array.isArray(parsed.yolo) ? parsed.yolo : [];
  } catch {
    return [];
  }
}

// Records (or updates) the YOLO state for one primary session. Atomic + 0600,
// mirroring the hub's other machine-state writes. Deduplicates on the session
// base dir.
function writeYoloEntry(entry) {
  const base = sessionBaseDir(entry.session_dir);
  const id = ultracodeSessionIdFromDir(base);
  const target = yoloFilePath(id);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const existing = readYoloEntries(id).filter(
    (candidate) => sessionBaseDir(candidate.session_dir || "") !== base,
  );
  const yolo = [
    ...existing,
    {
      ultracode_session_id: id,
      primary_repo_root: path.resolve(entry.primary_repo_root || ""),
      session_dir: base,
      enabled: entry.enabled === true,
      note: typeof entry.note === "string" && entry.note.trim() ? entry.note.trim() : null,
      updated_at: entry.updated_at || new Date().toISOString(),
      updated_by: entry.updated_by || null,
    },
  ];
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ yolo }, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
  return yolo;
}

// The recorded state for the session `declaredDir` belongs to — null when the
// user never toggled it, which every reader treats as YOLO off.
function yoloStateFor(declaredDir) {
  const base = sessionBaseDir(declaredDir);
  return (
    readYoloEntries(ultracodeSessionIdFromDir(base)).find(
      (entry) => sessionBaseDir(entry.session_dir || "") === base,
    ) || null
  );
}

function isYoloEnabled(declaredDir) {
  const entry = yoloStateFor(declaredDir);
  return Boolean(entry && entry.enabled === true);
}

module.exports = {
  yoloDir,
  yoloFilePath,
  ultracodeSessionIdFromDir,
  readYoloEntries,
  writeYoloEntry,
  yoloStateFor,
  isYoloEnabled,
};
