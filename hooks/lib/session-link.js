"use strict";

// Session adoption links: the record that a harness's native session has been
// authorized (through the hub's ultracode_session_adopt tool) to work inside a
// *shared* ultracode session dir whose id is not its own native session id.
//
// This is what lets a second harness pick up a session it could never inherit
// by native id — the old cross-harness story required both harnesses to be
// launched with the same native session id so their derived session dirs would
// match; adoption replaces that with a hub-authorized link, and also makes a
// broken session resumable by another harness.
//
// The link is written by the hub daemon (the only writer) into machine state
// under ~/.ultracode/hub/links, so hooks/session-guard.js can read it locally —
// no network call on the spawn path, and it survives a hub restart mid-session.
// Machine state is write-guarded against model-issued writes (hooks/lib/
// common.js isMachineStatePath), so a link cannot be forged to smuggle a spawn
// into an arbitrary session dir.

const fs = require("node:fs");
const path = require("node:path");
const { machineStateRoot, sanitizeSessionId } = require("./common");
const { sessionBaseDir } = require("./session");

function linksDir() {
  return path.join(machineStateRoot(), "hub", "links");
}

function linkFilePath(harness, nativeSessionId) {
  return path.join(linksDir(), `${harness}:${sanitizeSessionId(nativeSessionId)}.json`);
}

function readLinks(harness, nativeSessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(linkFilePath(harness, nativeSessionId), "utf-8"));
    return parsed && Array.isArray(parsed.links) ? parsed.links : [];
  } catch {
    return [];
  }
}

// Adds (or refreshes) one adoption link for a native session. Atomic + 0600,
// mirroring the hub's other machine-state writes. Deduplicates on
// (primary_repo_root, ultracode session base dir).
function writeLink(harness, nativeSessionId, entry) {
  const target = linkFilePath(harness, nativeSessionId);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const base = sessionBaseDir(entry.session_dir);
  const existing = readLinks(harness, nativeSessionId).filter(
    (link) =>
      !(
        path.resolve(link.primary_repo_root || "") === path.resolve(entry.primary_repo_root || "") &&
        sessionBaseDir(link.session_dir || "") === base
      ),
  );
  const links = [
    ...existing,
    {
      ultracode_session_id: entry.ultracode_session_id,
      primary_repo_root: path.resolve(entry.primary_repo_root),
      session_dir: sessionBaseDir(entry.session_dir),
      adopted_at: entry.adopted_at || new Date().toISOString(),
    },
  ];
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ links }, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
  return links;
}

// True if this native session has adopted the ultracode session that
// `declaredDir` belongs to, under the same primary repo root. session-guard
// calls this only when the declared dir does not match the native-derived dir,
// so an ordinary same-session spawn never touches the filesystem here.
function isAdoptedSessionDir(harness, nativeSessionId, declaredDir, primaryRepoRoot) {
  const declaredBase = sessionBaseDir(declaredDir);
  const primary = path.resolve(primaryRepoRoot || "");
  return readLinks(harness, nativeSessionId).some(
    (link) =>
      sessionBaseDir(link.session_dir || "") === declaredBase &&
      path.resolve(link.primary_repo_root || "") === primary,
  );
}

module.exports = { linksDir, linkFilePath, readLinks, writeLink, isAdoptedSessionDir };
