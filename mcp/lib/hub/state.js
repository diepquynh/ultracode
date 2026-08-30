"use strict";

// SQLite-backed hub state: the session registry, the cross-harness message
// queue, and the task-distribution queue. One daemon process owns the single
// writable connection (mcp/hub-server.js), so ordering and lease exclusivity
// come from SQLite transactions rather than multi-writer file conventions —
// the same reason mcp/lib/memory.js chose node:sqlite over JSON documents.
//
// Everything here is transport-independent and synchronous. The HTTP layer
// (mcp/lib/hub/http.js) adds long-poll waiters and push delivery on top; this
// module only ever returns "who should be notified" hints so it stays pure.
//
// Cursor semantics: messages are never destroyed by a read. A client passes
// the last message id it has seen and gets everything newer addressed to it;
// acking is simply passing the advanced cursor next time, so a timed-out
// long-poll or a crashed client re-reads instead of losing messages.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { isInside, isDirectory, sanitizeSessionId } = require("../../../hooks/lib/common");
const { sessionBaseDir } = require("../../../hooks/lib/session");
const { validateTaskPayload } = require("./task-contract");
const { resolveHarnessRoute } = require("./harness-route");

const BUSY_TIMEOUT_MS = 5000;
const HARNESSES = ["claude", "codex", "grok", "antigravity"];
const NATIVE_CHANNELS = ["codex-queue", "claude-uds", "none"];
const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
const SESSION_GONE_MS = 24 * 60 * 60 * 1000;
const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE_BODY_BYTES = 64 * 1024;
const DEFAULT_LEASE_SECONDS = 900;
const MAX_LEASE_SECONDS = 3600;
const MAX_TASK_ATTEMPTS = 3;
const DEFAULT_FETCH_LIMIT = 50;

// The shared project-root runtime dir every harness uses (definitions/
// harness-layout.json pins all four to ".ultracode"; the generator enforces
// it). The hub is machine-level and may serve plugin copies of any harness,
// so it uses the invariant directly instead of one copy's model-routing.json.
const RUNTIME_DIR = ".ultracode";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS hub_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_key   TEXT PRIMARY KEY,
    secret        TEXT NOT NULL,
    harness       TEXT NOT NULL,
    harness_session_id TEXT NOT NULL,
    display_name  TEXT,
    repo_roots    TEXT NOT NULL,
    session_dir   TEXT NOT NULL,
    ultracode_session_id TEXT NOT NULL DEFAULT '',
    primary_repo_root TEXT NOT NULL DEFAULT '',
    capabilities  TEXT NOT NULL DEFAULT '[]',
    native_channel TEXT NOT NULL DEFAULT 'none',
    native_address TEXT,
    registered_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS adoptions (
    session_key   TEXT NOT NULL,
    ultracode_session_id TEXT NOT NULL,
    primary_repo_root TEXT NOT NULL,
    session_dir   TEXT NOT NULL,
    adopted_at    TEXT NOT NULL,
    PRIMARY KEY (session_key, primary_repo_root, ultracode_session_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_session TEXT NOT NULL,
    to_session TEXT,
    to_harness TEXT,
    body TEXT NOT NULL,
    reply_to INTEGER,
    task_id INTEGER,
    dedupe_key TEXT UNIQUE,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    delivery_channel TEXT,
    fetched_at TEXT
  );
  CREATE INDEX IF NOT EXISTS messages_to_session ON messages(to_session, id);
  CREATE INDEX IF NOT EXISTS messages_to_harness ON messages(to_harness, id);
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_session TEXT NOT NULL,
    target_harness TEXT,
    capability TEXT,
    title TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    claimed_by TEXT,
    lease_expires_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, target_harness);
`;

class HubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HubError";
    this.status = status;
  }
}

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function parseJsonColumn(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HubError(400, `${label} is required and must be a non-empty string.`);
  }
  return value.trim();
}

function sessionKeyFor(harness, sessionId) {
  return `${harness}:${sanitizeSessionId(sessionId)}`;
}

// The shared identity of a session dir: the `ultracode-session-<id>` name with
// its prefix stripped. Two harnesses working the same dir share this id even
// when their native session ids differ — that is what adoption links.
function ultracodeSessionIdFromDir(sessionDir) {
  const name = path.basename(sessionBaseDir(sessionDir));
  return name.startsWith("ultracode-session-") ? name.slice("ultracode-session-".length) : name;
}

// The repo root that owns a session dir: the declared root whose
// <root>/.ultracode/session contains it.
function owningRepoRoot(roots, base) {
  return roots.find((root) => isInside(path.join(root, RUNTIME_DIR, "session"), base)) || null;
}

// A coarse "how far did this session get" hint for the resume/pick UI, read
// from which artifacts exist in the session dir. Best-effort and never throws:
// a dir the daemon cannot read just reports "unknown".
function inferStage(sessionBaseDirPath) {
  try {
    const gates = readJsonSafe(path.join(sessionBaseDirPath, "gates.json"));
    if (gates && gates.plan && gates.plan.decision === "approved") return "plan-approved";
    if (gates && gates.spec && gates.spec.decision === "approved") return "spec-approved";
    const names = fs.readdirSync(sessionBaseDirPath);
    if (names.some((n) => n.startsWith("ultracode-plan-"))) return "planned";
    if (names.some((n) => n.startsWith("ultracode-spec-"))) return "spec-drafted";
    return "started";
  } catch {
    return "unknown";
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function publicSession(row) {
  return {
    session_key: row.session_key,
    harness: row.harness,
    harness_session_id: row.harness_session_id,
    display_name: row.display_name || null,
    repo_roots: parseJsonColumn(row.repo_roots, []),
    session_dir: row.session_dir,
    capabilities: parseJsonColumn(row.capabilities, []),
    native_channel: row.native_channel,
    native_address: row.native_address || null,
    registered_at: row.registered_at,
    last_heartbeat_at: row.last_heartbeat_at,
    status: row.status,
  };
}

function publicMessage(row) {
  return {
    id: row.id,
    from: row.from_session,
    to_session: row.to_session || null,
    to_harness: row.to_harness || null,
    body: row.body,
    reply_to: row.reply_to || null,
    task_id: row.task_id || null,
    created_at: row.created_at,
  };
}

function publicTask(row) {
  return {
    id: row.id,
    publisher: row.publisher_session,
    target_harness: row.target_harness || null,
    capability: row.capability || null,
    title: row.title,
    payload: parseJsonColumn(row.payload, null),
    status: row.status,
    claimed_by: row.claimed_by || null,
    lease_expires_at: row.lease_expires_at || null,
    attempts: row.attempts,
    result: row.result ? parseJsonColumn(row.result, null) : null,
    created_at: row.created_at,
  };
}

class HubState {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT INTO hub_meta (key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO NOTHING")
      .run();
  }

  close() {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  // ---- auth ----------------------------------------------------------------

  sessionRow(sessionKey) {
    return this.db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) || null;
  }

  verifySession(sessionKey, secret) {
    const row = this.sessionRow(requireString(sessionKey, "session_key"));
    if (!row) throw new HubError(404, `Unknown session_key '${sessionKey}'. Register first.`);
    const given = Buffer.from(String(secret || ""));
    const expected = Buffer.from(row.secret);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      throw new HubError(403, "session_secret does not match this session_key.");
    }
    if (row.status === "gone") {
      throw new HubError(410, "This session registration has expired; register again.");
    }
    return row;
  }

  // ---- registry ------------------------------------------------------------

  registerSession({
    harness,
    session_id,
    display_name,
    repo_roots,
    session_dir,
    capabilities,
    native_channel,
    native_address,
  }) {
    if (!HARNESSES.includes(harness)) {
      throw new HubError(400, `harness must be one of: ${HARNESSES.join(", ")}.`);
    }
    const rawId = requireString(session_id, "session_id");
    if (sanitizeSessionId(rawId) === "no-session-id") {
      throw new HubError(
        400,
        "session_id sanitizes to the 'no-session-id' fallback; pass the real harness session id — two anonymous sessions would collide on the same key.",
      );
    }
    if (!Array.isArray(repo_roots) || repo_roots.length === 0) {
      throw new HubError(400, "repo_roots must be a non-empty array of absolute directories.");
    }
    const roots = repo_roots.map((root) => {
      const value = requireString(root, "repo_roots[]");
      if (!path.isAbsolute(value) || !isDirectory(value)) {
        throw new HubError(400, `repo_roots entry '${value}' is not an existing absolute directory.`);
      }
      return path.resolve(value);
    });
    const declaredDir = path.resolve(requireString(session_dir, "session_dir"));
    const base = sessionBaseDir(declaredDir);
    if (!path.basename(base).startsWith("ultracode-session-")) {
      throw new HubError(400, "session_dir must contain an 'ultracode-session-<id>' component.");
    }
    const primaryRepoRoot = owningRepoRoot(roots, base);
    if (!primaryRepoRoot) {
      throw new HubError(
        400,
        `session_dir must sit under <repo_root>/${RUNTIME_DIR}/session for one of the declared repo_roots.`,
      );
    }
    const ultracodeSessionId = ultracodeSessionIdFromDir(base);
    const channel = native_channel || "none";
    if (!NATIVE_CHANNELS.includes(channel)) {
      throw new HubError(400, `native_channel must be one of: ${NATIVE_CHANNELS.join(", ")}.`);
    }
    if (channel !== "none" && !(typeof native_address === "string" && native_address.trim())) {
      throw new HubError(400, "native_address is required when native_channel is not 'none'.");
    }
    const caps = Array.isArray(capabilities)
      ? capabilities.map((c) => requireString(c, "capabilities[]"))
      : [];

    const sessionKey = sessionKeyFor(harness, rawId);
    const secret = crypto.randomBytes(16).toString("hex");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO sessions (session_key, secret, harness, harness_session_id, display_name, repo_roots,
           session_dir, ultracode_session_id, primary_repo_root, capabilities, native_channel, native_address,
           registered_at, last_heartbeat_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
         ON CONFLICT(session_key) DO UPDATE SET
           secret = excluded.secret, display_name = excluded.display_name,
           repo_roots = excluded.repo_roots, session_dir = excluded.session_dir,
           ultracode_session_id = excluded.ultracode_session_id,
           primary_repo_root = excluded.primary_repo_root,
           capabilities = excluded.capabilities, native_channel = excluded.native_channel,
           native_address = excluded.native_address, last_heartbeat_at = excluded.last_heartbeat_at,
           status = 'active'`,
      )
      .run(
        sessionKey,
        secret,
        harness,
        rawId,
        display_name || null,
        JSON.stringify(roots),
        declaredDir,
        ultracodeSessionId,
        primaryRepoRoot,
        JSON.stringify(caps),
        channel,
        channel === "none" ? null : native_address.trim(),
        now,
        now,
      );

    // Cursor for the caller's first msg_wait: skip history it can never need
    // (broadcasts sent before it existed) but never skip a direct message that
    // was queued for this session_key while it was offline/unregistered.
    const maxId = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get().max_id;
    const pending = this.db
      .prepare("SELECT MIN(id) AS min_id FROM messages WHERE to_session = ? AND fetched_at IS NULL")
      .get(sessionKey).min_id;
    const cursor = pending ? pending - 1 : maxId;
    return { session_key: sessionKey, session_secret: secret, cursor };
  }

  heartbeat({ session_key, session_secret }) {
    const row = this.verifySession(session_key, session_secret);
    this.db
      .prepare("UPDATE sessions SET last_heartbeat_at = ?, status = 'active' WHERE session_key = ?")
      .run(nowIso(), row.session_key);
    const pending = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_session = ? AND fetched_at IS NULL")
      .get(row.session_key).n;
    const openTasks = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND (target_harness IS NULL OR target_harness = ?)",
      )
      .get(row.harness).n;
    return { ok: true, pending_messages: pending, open_tasks: openTasks };
  }

  listSessions({ harness, repo_root } = {}) {
    let rows = this.db
      .prepare("SELECT * FROM sessions WHERE status != 'gone' ORDER BY last_heartbeat_at DESC")
      .all();
    if (harness) rows = rows.filter((row) => row.harness === harness);
    if (repo_root) {
      const resolved = path.resolve(repo_root);
      rows = rows.filter((row) => parseJsonColumn(row.repo_roots, []).includes(resolved));
    }
    return { sessions: rows.map(publicSession) };
  }

  // ---- ultracode-session adoption -----------------------------------------

  // Every distinct shared ultracode session known for a repo, for the
  // hub-listen picker and for resume: id, its dir, the pipeline stage inferred
  // from which gate/spec/plan files exist, and who has touched it. Derived from
  // the sessions registry plus recorded adoptions, so a session survives here
  // even after the harness that created it went away (the resume case).
  queryUltracodeSessions({ repo_root } = {}) {
    const rows = this.db
      .prepare(
        `SELECT ultracode_session_id AS id, primary_repo_root, session_dir, harness, session_key, last_heartbeat_at, status
           FROM sessions WHERE ultracode_session_id != ''
         UNION ALL
         SELECT ultracode_session_id AS id, primary_repo_root, session_dir, '' AS harness, session_key, adopted_at AS last_heartbeat_at, 'adopted' AS status
           FROM adoptions`,
      )
      .all();
    const wanted = repo_root ? path.resolve(repo_root) : null;
    const byId = new Map();
    for (const row of rows) {
      if (wanted && path.resolve(row.primary_repo_root) !== wanted) continue;
      const key = `${row.primary_repo_root}::${row.id}`;
      if (!byId.has(key)) {
        byId.set(key, {
          ultracode_session_id: row.id,
          primary_repo_root: row.primary_repo_root,
          session_dir: sessionBaseDir(row.session_dir),
          stage: inferStage(sessionBaseDir(row.session_dir)),
          participants: [],
          last_activity: row.last_heartbeat_at,
        });
      }
      const entry = byId.get(key);
      if (row.harness && !entry.participants.some((p) => p.session_key === row.session_key)) {
        entry.participants.push({ session_key: row.session_key, harness: row.harness, status: row.status });
      }
      if (row.last_heartbeat_at > entry.last_activity) entry.last_activity = row.last_heartbeat_at;
    }
    return { sessions: [...byId.values()].sort((a, b) => b.last_activity.localeCompare(a.last_activity)) };
  }

  // Authorize a native session to work inside a shared ultracode session it did
  // not create. Records the adoption and (via the HTTP facade) writes the link
  // file hooks/session-guard.js reads. Target is given by session_dir (exact)
  // or by ultracode_session_id + repo_root (resume by id).
  adoptSession({ session_key, session_secret, session_dir, ultracode_session_id, repo_root }) {
    const caller = this.verifySession(session_key, session_secret);
    let targetDir;
    let primaryRepoRoot;
    if (session_dir) {
      targetDir = sessionBaseDir(path.resolve(requireString(session_dir, "session_dir")));
      primaryRepoRoot = owningRepoRoot(parseJsonColumn(caller.repo_roots, []).map((r) => path.resolve(r)), targetDir);
    } else {
      const id = requireString(ultracode_session_id, "ultracode_session_id");
      const root = path.resolve(requireString(repo_root, "repo_root"));
      primaryRepoRoot = root;
      targetDir = path.join(root, RUNTIME_DIR, "session", `ultracode-session-${id}`);
    }
    if (!path.basename(targetDir).startsWith("ultracode-session-")) {
      throw new HubError(400, "Adoption target must be an 'ultracode-session-<id>' directory.");
    }
    if (!primaryRepoRoot) {
      throw new HubError(
        400,
        "Adoption target is not under a repo root this session registered for; register that repo root first.",
      );
    }
    const id = ultracodeSessionIdFromDir(targetDir);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO adoptions (session_key, ultracode_session_id, primary_repo_root, session_dir, adopted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_key, primary_repo_root, ultracode_session_id)
           DO UPDATE SET session_dir = excluded.session_dir, adopted_at = excluded.adopted_at`,
      )
      .run(caller.session_key, id, primaryRepoRoot, targetDir, now);
    return {
      harness: caller.harness,
      harness_session_id: caller.harness_session_id,
      ultracode_session_id: id,
      primary_repo_root: primaryRepoRoot,
      session_dir: targetDir,
      adopted_at: now,
    };
  }

  adoptedDirsFor(sessionKey) {
    return this.db
      .prepare("SELECT session_dir FROM adoptions WHERE session_key = ?")
      .all(sessionKey)
      .map((row) => row.session_dir);
  }

  // ---- messages ------------------------------------------------------------

  sendMessage({
    from_session_key,
    from_secret,
    to_session_key,
    to_harness,
    body,
    reply_to,
    task_id,
    dedupe_key,
  }) {
    const sender = this.verifySession(from_session_key, from_secret);
    const hasSession = typeof to_session_key === "string" && to_session_key.trim();
    const hasHarness = typeof to_harness === "string" && to_harness.trim();
    if (Boolean(hasSession) === Boolean(hasHarness)) {
      throw new HubError(400, "Pass exactly one of to_session_key (direct) or to_harness (broadcast).");
    }
    let recipient = null;
    if (hasSession) {
      recipient = this.sessionRow(to_session_key.trim());
      if (!recipient) throw new HubError(404, `Unknown to_session_key '${to_session_key}'.`);
    } else if (!HARNESSES.includes(to_harness.trim())) {
      throw new HubError(400, `to_harness must be one of: ${HARNESSES.join(", ")}.`);
    }
    const text = requireString(body, "body");
    if (Buffer.byteLength(text, "utf-8") > MAX_MESSAGE_BODY_BYTES) {
      throw new HubError(
        413,
        `body exceeds ${MAX_MESSAGE_BODY_BYTES} bytes — messages carry addresses into the session dir, not content; write the content to a session file and send its path.`,
      );
    }

    if (dedupe_key) {
      const existing = this.db
        .prepare("SELECT * FROM messages WHERE dedupe_key = ?")
        .get(String(dedupe_key));
      if (existing) {
        return { message_id: existing.id, duplicate: true, recipient: recipient && publicSession(recipient) };
      }
    }
    const result = this.db
      .prepare(
        `INSERT INTO messages (from_session, to_session, to_harness, body, reply_to, task_id, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sender.session_key,
        hasSession ? recipient.session_key : null,
        hasHarness ? to_harness.trim() : null,
        text,
        Number.isInteger(reply_to) ? reply_to : null,
        Number.isInteger(task_id) ? task_id : null,
        dedupe_key ? String(dedupe_key) : null,
        nowIso(),
      );
    return {
      message_id: Number(result.lastInsertRowid),
      duplicate: false,
      recipient: recipient && publicSession(recipient),
    };
  }

  fetchMessages({ session_key, session_secret, cursor, limit }) {
    const row = this.verifySession(session_key, session_secret);
    const after = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : DEFAULT_FETCH_LIMIT;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE id > ? AND (to_session = ? OR to_harness = ?)
         ORDER BY id ASC LIMIT ?`,
      )
      .all(after, row.session_key, row.harness, cap);
    const now = nowIso();
    const markFetched = this.db.prepare(
      "UPDATE messages SET fetched_at = COALESCE(fetched_at, ?) WHERE id = ?",
    );
    for (const message of rows) markFetched.run(now, message.id);
    return {
      messages: rows.map(publicMessage),
      cursor: rows.length ? rows[rows.length - 1].id : after,
    };
  }

  markDelivered(messageId, channel) {
    this.db
      .prepare("UPDATE messages SET delivered_at = COALESCE(delivered_at, ?), delivery_channel = ? WHERE id = ?")
      .run(nowIso(), channel, messageId);
  }

  // ---- tasks ---------------------------------------------------------------

  publishTask({ from_session_key, from_secret, title, target_harness, capability, payload }) {
    const sender = this.verifySession(from_session_key, from_secret);
    const name = requireString(title, "title");
    if (target_harness && !HARNESSES.includes(target_harness)) {
      throw new HubError(400, `target_harness must be one of: ${HARNESSES.join(", ")}.`);
    }
    const verdict = validateTaskPayload(payload);
    if (!verdict.ok) {
      throw new HubError(400, `Invalid task payload: ${verdict.errors.join(" ")}`);
    }

    // The repo profile's `harnesses` route is resolved HERE, from the file as
    // it exists right now — not from whatever the orchestrator read earlier —
    // so a mid-session profile edit retunes the very next publish. The caller
    // may still pass target_harness for a user-directed delegation with no
    // profile route; a caller value that CONTRADICTS the current profile is
    // refused (mirroring model-router's deny-on-mismatch) so a stale
    // orchestrator learns the fresh route instead of silently overriding it.
    // A route naming the publisher's own harness means "this stage was not
    // meant to leave that harness" — it never targets the publish, but the
    // publish itself is honored as the user's explicit choice.
    const resolved = resolveHarnessRoute({
      repoRoot: payload.repo_root,
      agentHint: payload.agent_hint,
      phaseFile: payload.source && payload.source.phase_file,
    });
    let target = target_harness || null;
    let routedBy = target ? "caller" : null;
    if (resolved.route && resolved.route !== sender.harness) {
      if (target && target !== resolved.route) {
        throw new HubError(
          409,
          `repo-profile.json currently routes '${payload.agent_hint}' to '${resolved.route}' ` +
            `(${resolved.source}), not '${target}'. Omit target_harness — the hub re-reads the profile on ` +
            "every publish — or update the profile if the route should change.",
        );
      }
      target = resolved.route;
      routedBy = "profile";
    }
    // No profile route and no caller choice → default to the PUBLISHER's own
    // harness, never "any harness": an absent setup must not scatter work to
    // whichever harness happens to claim first.
    if (!target) {
      target = sender.harness;
      routedBy = "default-current-harness";
    }
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO tasks (publisher_session, target_harness, capability, title, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sender.session_key,
        target,
        capability ? requireString(capability, "capability") : null,
        name,
        JSON.stringify(payload),
        now,
        now,
      );
    const taskId = Number(result.lastInsertRowid);
    // Push hint: active sessions on the target harness (or any harness) that
    // could claim this — the HTTP layer sends them a wake notice.
    const candidates = this.db
      .prepare(
        `SELECT * FROM sessions WHERE status = 'active' AND session_key != ?
         AND (? IS NULL OR harness = ?)`,
      )
      .all(sender.session_key, target, target);
    return {
      task_id: taskId,
      target_harness: target,
      routed_by: routedBy,
      ...(resolved.invalid && {
        route_warning: `repo-profile.json harnesses route for '${payload.agent_hint}' is '${resolved.invalid}', which is not a harness name — treated as absent; fix the profile.`,
      }),
      notify_candidates: candidates.map(publicSession),
    };
  }

  reopenExpiredLeases() {
    const now = nowIso();
    const expired = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'claimed' AND lease_expires_at < ?")
      .all(now);
    const notifications = [];
    for (const task of expired) {
      if (task.attempts >= MAX_TASK_ATTEMPTS) {
        const result = JSON.stringify({
          summary: `Lease expired after ${task.attempts} claim attempts; task marked failed.`,
        });
        this.db
          .prepare("UPDATE tasks SET status = 'failed', result = ?, updated_at = ? WHERE id = ?")
          .run(result, now, task.id);
        notifications.push(...this.notifyPublisher(task, "failed", `gave up after ${task.attempts} expired leases`));
      } else {
        this.db
          .prepare(
            "UPDATE tasks SET status = 'open', claimed_by = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run(now, task.id);
      }
    }
    return notifications;
  }

  claimTask({ session_key, session_secret, task_id, capability, lease_seconds }) {
    const worker = this.verifySession(session_key, session_secret);
    const lease = Math.min(
      Number.isInteger(lease_seconds) && lease_seconds > 0 ? lease_seconds : DEFAULT_LEASE_SECONDS,
      MAX_LEASE_SECONDS,
    );
    const workerCaps = parseJsonColumn(worker.capabilities, []);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.reopenExpiredLeases();
      const candidates = Number.isInteger(task_id)
        ? this.db.prepare("SELECT * FROM tasks WHERE id = ? AND status = 'open'").all(task_id)
        : this.db.prepare("SELECT * FROM tasks WHERE status = 'open' ORDER BY id ASC").all();
      const match = candidates.find((task) => {
        if (task.target_harness && task.target_harness !== worker.harness) return false;
        if (capability) return task.capability === capability;
        if (!task.capability) return true;
        return workerCaps.length === 0 || workerCaps.includes(task.capability);
      });
      if (!match) {
        this.db.exec("COMMIT");
        return { task: null };
      }
      this.db
        .prepare(
          `UPDATE tasks SET status = 'claimed', claimed_by = ?, lease_expires_at = ?,
             attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'open'`,
        )
        .run(worker.session_key, nowIso(lease * 1000), nowIso(), match.id);
      this.db.exec("COMMIT");
      return { task: publicTask(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(match.id)) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeTask({ session_key, session_secret, task_id, status, summary, report_file }) {
    const worker = this.verifySession(session_key, session_secret);
    if (!Number.isInteger(task_id)) throw new HubError(400, "task_id must be an integer.");
    if (!["done", "failed"].includes(status)) throw new HubError(400, "status must be 'done' or 'failed'.");
    const text = requireString(summary, "summary");
    const task = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id);
    if (!task) throw new HubError(404, `Unknown task_id ${task_id}.`);
    if (task.status !== "claimed" || task.claimed_by !== worker.session_key) {
      throw new HubError(
        409,
        `Task ${task_id} is not claimed by this session (status: ${task.status}, claimed_by: ${task.claimed_by || "nobody"}).`,
      );
    }
    let reportPath = null;
    if (report_file) {
      reportPath = path.resolve(requireString(report_file, "report_file"));
      // The report must land in a session dir this worker is authorized to write
      // in: its own registered dir, or a shared ultracode session it adopted
      // (the normal case — a delegated task is executed in the adopted dir, so
      // its report sits beside the publisher's artifacts).
      const allowedBases = [
        sessionBaseDir(worker.session_dir),
        ...this.adoptedDirsFor(worker.session_key).map((dir) => sessionBaseDir(dir)),
      ];
      if (!allowedBases.some((base) => isInside(base, reportPath))) {
        throw new HubError(
          400,
          "report_file must be inside this worker's own registered session_dir or a session it has adopted.",
        );
      }
    }
    const result = { summary: text, report_file: reportPath, worker_session_dir: worker.session_dir };
    this.db
      .prepare("UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?")
      .run(status, JSON.stringify(result), nowIso(), task_id);
    const notifications = this.notifyPublisher({ ...task, result: JSON.stringify(result) }, status, text, reportPath);
    return { ok: true, notifications };
  }

  // Inserts the completion/failure message that wakes the publisher. Returns
  // push hints ({ message_id, recipient }) for the HTTP layer.
  notifyPublisher(task, status, summary, reportPath = null) {
    const publisher = this.sessionRow(task.publisher_session);
    if (!publisher) return [];
    const body = JSON.stringify({
      task_id: task.id,
      title: task.title,
      status,
      summary,
      report_file: reportPath,
    });
    const inserted = this.db
      .prepare(
        `INSERT INTO messages (from_session, to_session, body, task_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(task.claimed_by || "hub", publisher.session_key, body, task.id, nowIso());
    return [{ message_id: Number(inserted.lastInsertRowid), recipient: publicSession(publisher) }];
  }

  // Wake notices for a freshly published task: one direct hub-originated
  // message per candidate session, so push-capable workers wake immediately
  // and pull-only workers see it on their next msg_wait. Claim exclusivity
  // makes multiple woken candidates safe.
  notifyTaskPublished(taskId, title, candidates) {
    const notifications = [];
    for (const candidate of candidates) {
      const body = JSON.stringify({
        task_id: taskId,
        title,
        status: "open",
        note: "A task you can claim was published; call ultracode_task_claim.",
      });
      const inserted = this.db
        .prepare(
          `INSERT INTO messages (from_session, to_session, body, task_id, created_at)
           VALUES ('hub', ?, ?, ?, ?)`,
        )
        .run(candidate.session_key, body, taskId, nowIso());
      notifications.push({ message_id: Number(inserted.lastInsertRowid), recipient: candidate });
    }
    return notifications;
  }

  // ---- maintenance ---------------------------------------------------------

  expireStale() {
    const staleBefore = nowIso(-HEARTBEAT_STALE_MS);
    const goneBefore = nowIso(-SESSION_GONE_MS);
    const pruneBefore = nowIso(-MESSAGE_RETENTION_MS);
    this.db
      .prepare("UPDATE sessions SET status = 'stale' WHERE status = 'active' AND last_heartbeat_at < ?")
      .run(staleBefore);
    this.db
      .prepare("UPDATE sessions SET status = 'gone' WHERE status = 'stale' AND last_heartbeat_at < ?")
      .run(goneBefore);
    this.db.prepare("DELETE FROM messages WHERE created_at < ?").run(pruneBefore);
    return this.reopenExpiredLeases();
  }
}

module.exports = {
  HubState,
  HubError,
  HARNESSES,
  NATIVE_CHANNELS,
  MAX_MESSAGE_BODY_BYTES,
  DEFAULT_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
  MAX_TASK_ATTEMPTS,
};
