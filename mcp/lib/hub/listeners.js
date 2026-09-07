"use strict";

// Read-only view of the hub's session registry, for the PreToolUse hook that
// decides whether a routed stage can actually be delegated.
//
// hooks/model-router.js refuses to spawn a stage locally when the repo profile
// routes it to another harness. That refusal is only correct while the routed
// harness has somewhere to send the work: routing is advisory
// (refs/inventory-and-profile.md, `harnesses`), so an unreachable route falls
// back to a local run instead of stalling the pipeline. Answering "is anyone
// listening" needs the registry, and the hook cannot ask the hub over HTTP — it
// holds no session secret, and a PreToolUse hook must not block on a daemon
// that may be down.
//
// So this opens hub.sqlite3 READ-ONLY: no file creation, no schema, no
// migration, no writes. A missing database, an older schema, or any sqlite
// error answers "no listener", which is the fallback direction. The daemon runs
// in WAL mode, so a reader here never blocks its writes.

const path = require("node:path");
const { hubDatabasePath } = require("./config");

const BUSY_TIMEOUT_MS = 2000;

// How fresh a heartbeat has to be for a session to count as listening. Every
// authenticated hub call refreshes it (throttled to 60s in state.js) and a
// hub-listen worker calls on every wait loop, so a live worker always sits
// inside this window. A session whose harness died drops out of it in ten
// minutes and frees the route, rather than blocking local spawns for the seven
// days a registration survives.
const LISTENER_FRESH_MS = 10 * 60 * 1000;

function parseRoots(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((root) => typeof root === "string") : [];
  } catch {
    return [];
  }
}

// `node:sqlite` is required HERE rather than at module scope. This module is
// loaded by hooks/model-router.js, and a Node build without the sqlite module
// would throw on the require, taking the whole hook down with it — including
// deny-on-missing-model-route, which must never fail open. Inside the try, the
// same condition just answers "no listener".
function openReadOnly() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(hubDatabasePath(), { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

// Sessions of `harness` that registered `repoRoot` and are still heartbeating.
// Returns [] on any failure.
function liveListeners({ harness, repoRoot }) {
  if (typeof harness !== "string" || !harness.trim()) return [];
  if (typeof repoRoot !== "string" || !repoRoot.trim()) return [];
  const wanted = path.resolve(repoRoot.trim());
  const since = new Date(Date.now() - LISTENER_FRESH_MS).toISOString();
  let db;
  try {
    db = openReadOnly();
    const rows = db
      .prepare(
        `SELECT session_key, display_name, repo_roots, primary_repo_root FROM sessions
         WHERE status = 'active' AND harness = ? AND last_heartbeat_at >= ?`,
      )
      .all(harness.trim(), since);
    return rows.filter((row) => {
      const roots = parseRoots(row.repo_roots).map((root) => path.resolve(root));
      if (row.primary_repo_root) roots.push(path.resolve(row.primary_repo_root));
      return roots.includes(wanted);
    });
  } catch {
    return [];
  } finally {
    try {
      if (db) db.close();
    } catch {
      // Nothing to release beyond the handle.
    }
  }
}

function hasLiveListener(query) {
  return liveListeners(query).length > 0;
}

module.exports = { LISTENER_FRESH_MS, hasLiveListener, liveListeners };
