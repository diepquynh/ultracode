// Tests for the machine-level ultracode hub: state store, task contract,
// lock/config lifecycle, HTTP surface, MCP-over-HTTP, shim behavior, and
// push-adapter degradation. Uses only Node stdlib + the bundled MCP SDK.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const HUB_SERVER = path.join(ROOT, "mcp", "hub-server.js");

// Every test gets an isolated machine-state root and repo/session layout so
// hub state never leaks between tests (or into the developer's real ~/.ultracode).
function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-hub-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hubHome = path.join(dir, "machine-state");
  const repoRoot = path.join(dir, "repo");
  const sessionDir = path.join(repoRoot, ".ultracode", "session", "ultracode-session-test-abc123");
  fs.mkdirSync(sessionDir, { recursive: true });
  process.env.ULTRACODE_HUB_HOME = hubHome;
  t.after(() => {
    delete process.env.ULTRACODE_HUB_HOME;
  });
  return { dir, hubHome, repoRoot, sessionDir };
}

function freshHubState(fixture) {
  // Re-require after ULTRACODE_HUB_HOME is set; config reads env per call so
  // a plain require is fine.
  const { HubState } = require(path.join(ROOT, "mcp", "lib", "hub", "state.js"));
  const { hubDatabasePath } = require(path.join(ROOT, "mcp", "lib", "hub", "config.js"));
  void fixture;
  return new HubState(hubDatabasePath());
}

function registerDefault(state, fixture, overrides = {}) {
  return state.registerSession({
    harness: "claude",
    session_id: "test-abc123",
    display_name: "orchestrator",
    repo_roots: [fixture.repoRoot],
    session_dir: fixture.sessionDir,
    capabilities: ["implement"],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// state.js — registry
// ---------------------------------------------------------------------------

test("hub: session register/heartbeat round-trip with secret auth", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  const reg = registerDefault(state, fixture);
  assert.equal(reg.session_key, "claude:test-abc123");
  assert.match(reg.session_secret, /^[0-9a-f]{32}$/);
  assert.equal(reg.cursor, 0);

  const beat = state.heartbeat({ session_key: reg.session_key, session_secret: reg.session_secret });
  assert.equal(beat.ok, true);
  assert.equal(beat.pending_messages, 0);

  assert.throws(
    () => state.heartbeat({ session_key: reg.session_key, session_secret: "wrong" }),
    /session_secret does not match/,
  );
});

test("hub: re-register upserts and rotates the secret", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  const first = registerDefault(state, fixture);
  const second = registerDefault(state, fixture, { display_name: "renamed" });
  assert.equal(first.session_key, second.session_key);
  assert.notEqual(first.session_secret, second.session_secret);
  assert.throws(
    () => state.heartbeat({ session_key: first.session_key, session_secret: first.session_secret }),
    /does not match/,
  );
  const { sessions } = state.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].display_name, "renamed");
  assert.equal("secret" in sessions[0], false);
});

test("hub: registration rejects bad harness, anonymous ids, foreign session dirs", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  assert.throws(() => registerDefault(state, fixture, { harness: "cursor" }), /harness must be one of/);
  assert.throws(() => registerDefault(state, fixture, { session_id: "  " }), /session_id is required/);
  assert.throws(
    () => registerDefault(state, fixture, { session_dir: path.join(fixture.dir, "elsewhere") }),
    /ultracode-session-/,
  );
  const outside = path.join(fixture.dir, "other-repo", ".ultracode", "session", "ultracode-session-x");
  fs.mkdirSync(outside, { recursive: true });
  assert.throws(() => registerDefault(state, fixture, { session_dir: outside }), /declared repo_roots/);
  assert.throws(
    () => registerDefault(state, fixture, { native_channel: "codex-queue" }),
    /native_address is required/,
  );
});

// ---------------------------------------------------------------------------
// state.js — messages
// ---------------------------------------------------------------------------

test("hub: direct message send/fetch with cursor semantics and dedupe", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  const alice = registerDefault(state, fixture);
  const bobDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-bob-1");
  fs.mkdirSync(bobDir, { recursive: true });
  const bob = registerDefault(state, fixture, {
    harness: "codex",
    session_id: "bob-1",
    session_dir: bobDir,
  });

  const sent = state.sendMessage({
    from_session_key: alice.session_key,
    from_secret: alice.session_secret,
    to_session_key: bob.session_key,
    body: "see report at /tmp/x.md",
    dedupe_key: "msg-1",
  });
  assert.equal(sent.duplicate, false);
  assert.equal(sent.recipient.session_key, bob.session_key);

  const resent = state.sendMessage({
    from_session_key: alice.session_key,
    from_secret: alice.session_secret,
    to_session_key: bob.session_key,
    body: "see report at /tmp/x.md",
    dedupe_key: "msg-1",
  });
  assert.equal(resent.duplicate, true);
  assert.equal(resent.message_id, sent.message_id);

  const fetched = state.fetchMessages({
    session_key: bob.session_key,
    session_secret: bob.session_secret,
    cursor: bob.cursor,
  });
  assert.equal(fetched.messages.length, 1);
  assert.equal(fetched.messages[0].from, alice.session_key);
  assert.equal(fetched.cursor, sent.message_id);

  // Idempotent re-read from the old cursor; empty from the advanced cursor.
  const reread = state.fetchMessages({
    session_key: bob.session_key,
    session_secret: bob.session_secret,
    cursor: bob.cursor,
  });
  assert.equal(reread.messages.length, 1);
  const after = state.fetchMessages({
    session_key: bob.session_key,
    session_secret: bob.session_secret,
    cursor: fetched.cursor,
  });
  assert.equal(after.messages.length, 0);

  // Alice never sees Bob's direct messages.
  const alicesView = state.fetchMessages({
    session_key: alice.session_key,
    session_secret: alice.session_secret,
    cursor: 0,
  });
  assert.equal(alicesView.messages.length, 0);
});

test("hub: broadcast reaches every session of the harness; body size is capped", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  const alice = registerDefault(state, fixture);
  const grokDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-grok-1");
  fs.mkdirSync(grokDir, { recursive: true });
  const grok = registerDefault(state, fixture, {
    harness: "grok",
    session_id: "grok-1",
    session_dir: grokDir,
  });

  assert.throws(
    () =>
      state.sendMessage({
        from_session_key: alice.session_key,
        from_secret: alice.session_secret,
        to_harness: "grok",
        to_session_key: grok.session_key,
        body: "both set",
      }),
    /exactly one/,
  );
  assert.throws(
    () =>
      state.sendMessage({
        from_session_key: alice.session_key,
        from_secret: alice.session_secret,
        to_harness: "grok",
        body: "x".repeat(65 * 1024),
      }),
    /exceeds/,
  );

  state.sendMessage({
    from_session_key: alice.session_key,
    from_secret: alice.session_secret,
    to_harness: "grok",
    body: "open tasks waiting",
  });
  const fetched = state.fetchMessages({
    session_key: grok.session_key,
    session_secret: grok.session_secret,
    cursor: grok.cursor,
  });
  assert.equal(fetched.messages.length, 1);
  assert.equal(fetched.messages[0].to_harness, "grok");
});

test("hub: re-registration cursor does not skip queued direct messages", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  const alice = registerDefault(state, fixture);
  const bobDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-bob-2");
  fs.mkdirSync(bobDir, { recursive: true });
  const bob = registerDefault(state, fixture, {
    harness: "codex",
    session_id: "bob-2",
    session_dir: bobDir,
  });
  state.sendMessage({
    from_session_key: alice.session_key,
    from_secret: alice.session_secret,
    to_session_key: bob.session_key,
    body: "queued while bob was away",
  });
  const bobAgain = registerDefault(state, fixture, {
    harness: "codex",
    session_id: "bob-2",
    session_dir: bobDir,
  });
  const fetched = state.fetchMessages({
    session_key: bobAgain.session_key,
    session_secret: bobAgain.session_secret,
    cursor: bobAgain.cursor,
  });
  assert.equal(fetched.messages.length, 1);
  assert.equal(fetched.messages[0].body, "queued while bob was away");
});

// ---------------------------------------------------------------------------
// state.js — tasks
// ---------------------------------------------------------------------------

function validPayload(fixture, overrides = {}) {
  return {
    agent_hint: "implement",
    task: "Implement phase 2 of the payments plan.",
    repo_root: fixture.repoRoot,
    repo_key: "repo",
    source: {
      session_dir: fixture.sessionDir,
      phase_file: path.join(fixture.sessionDir, "ultracode-plan-x-phase-2.md"),
    },
    ...overrides,
  };
}

test("hub: task publish/claim/complete lifecycle notifies the publisher", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  const publisher = registerDefault(state, fixture);
  const workerDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-worker-1");
  fs.mkdirSync(workerDir, { recursive: true });
  const worker = registerDefault(state, fixture, {
    harness: "codex",
    session_id: "worker-1",
    session_dir: workerDir,
  });

  const published = state.publishTask({
    from_session_key: publisher.session_key,
    from_secret: publisher.session_secret,
    title: "Implement payments phase 2",
    target_harness: "codex",
    payload: validPayload(fixture),
  });
  assert.ok(published.task_id >= 1);
  assert.equal(published.notify_candidates.length, 1);
  assert.equal(published.notify_candidates[0].session_key, worker.session_key);

  const claimed = state.claimTask({
    session_key: worker.session_key,
    session_secret: worker.session_secret,
  });
  assert.equal(claimed.task.id, published.task_id);
  assert.equal(claimed.task.payload.repo_key, "repo");

  // Exclusive: a second claim finds nothing.
  const second = state.claimTask({
    session_key: worker.session_key,
    session_secret: worker.session_secret,
  });
  assert.equal(second.task, null);

  const reportFile = path.join(workerDir, "ultracode-implement-phase-2.md");
  const completion = state.completeTask({
    session_key: worker.session_key,
    session_secret: worker.session_secret,
    task_id: published.task_id,
    status: "done",
    summary: "Phase 2 implemented; build green.",
    report_file: reportFile,
  });
  assert.equal(completion.ok, true);
  assert.equal(completion.notifications.length, 1);
  assert.equal(completion.notifications[0].recipient.session_key, publisher.session_key);

  const inbox = state.fetchMessages({
    session_key: publisher.session_key,
    session_secret: publisher.session_secret,
    cursor: 0,
  });
  assert.equal(inbox.messages.length, 1);
  const body = JSON.parse(inbox.messages[0].body);
  assert.equal(body.task_id, published.task_id);
  assert.equal(body.status, "done");
  assert.equal(body.report_file, reportFile);
});

test("hub: claim honors target harness; complete confines report to worker session dir", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  const publisher = registerDefault(state, fixture);
  const grokDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-grok-9");
  fs.mkdirSync(grokDir, { recursive: true });
  const grokWorker = registerDefault(state, fixture, {
    harness: "grok",
    session_id: "grok-9",
    session_dir: grokDir,
  });

  const published = state.publishTask({
    from_session_key: publisher.session_key,
    from_secret: publisher.session_secret,
    title: "Codex-only task",
    target_harness: "codex",
    payload: validPayload(fixture),
  });
  const denied = state.claimTask({
    session_key: grokWorker.session_key,
    session_secret: grokWorker.session_secret,
  });
  assert.equal(denied.task, null);

  const open = state.publishTask({
    from_session_key: publisher.session_key,
    from_secret: publisher.session_secret,
    title: "Any harness",
    payload: validPayload(fixture),
  });
  const claimed = state.claimTask({
    session_key: grokWorker.session_key,
    session_secret: grokWorker.session_secret,
  });
  assert.equal(claimed.task.id, open.task_id);
  assert.throws(
    () =>
      state.completeTask({
        session_key: grokWorker.session_key,
        session_secret: grokWorker.session_secret,
        task_id: open.task_id,
        status: "done",
        summary: "done",
        report_file: path.join(fixture.sessionDir, "not-mine.md"),
      }),
    /worker's own registered session_dir/,
  );
  assert.throws(
    () =>
      state.completeTask({
        session_key: publisher.session_key,
        session_secret: publisher.session_secret,
        task_id: published.task_id,
        status: "done",
        summary: "not the claimer",
      }),
    /not claimed by this session/,
  );
});

test("hub: expired lease reopens the task, then fails it after max attempts", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  const publisher = registerDefault(state, fixture);
  const workerDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-worker-2");
  fs.mkdirSync(workerDir, { recursive: true });
  const worker = registerDefault(state, fixture, {
    harness: "codex",
    session_id: "worker-2",
    session_dir: workerDir,
  });
  const published = state.publishTask({
    from_session_key: publisher.session_key,
    from_secret: publisher.session_secret,
    title: "Flaky task",
    payload: validPayload(fixture),
  });

  const expireLease = () =>
    state.db
      .prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), published.task_id);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const claimed = state.claimTask({
      session_key: worker.session_key,
      session_secret: worker.session_secret,
    });
    assert.equal(claimed.task.id, published.task_id, `attempt ${attempt} should claim`);
    assert.equal(claimed.task.attempts, attempt);
    expireLease();
    state.reopenExpiredLeases();
  }
  // Third expiry hit the attempt cap: task is failed, publisher was notified.
  const after = state.claimTask({ session_key: worker.session_key, session_secret: worker.session_secret });
  assert.equal(after.task, null);
  const row = state.db.prepare("SELECT status FROM tasks WHERE id = ?").get(published.task_id);
  assert.equal(row.status, "failed");
  const inbox = state.fetchMessages({
    session_key: publisher.session_key,
    session_secret: publisher.session_secret,
    cursor: 0,
  });
  assert.equal(inbox.messages.length, 1);
  assert.equal(JSON.parse(inbox.messages[0].body).status, "failed");
});

test("hub: expireStale marks sessions stale and prunes old messages", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  const reg = registerDefault(state, fixture);
  state.db
    .prepare("UPDATE sessions SET last_heartbeat_at = ? WHERE session_key = ?")
    .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), reg.session_key);
  state.expireStale();
  assert.equal(state.listSessions().sessions[0].status, "stale");

  state.sendMessage({
    from_session_key: reg.session_key,
    from_secret: reg.session_secret,
    to_harness: "grok",
    body: "old",
  });
  state.db.prepare("UPDATE messages SET created_at = ?").run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());
  state.expireStale();
  assert.equal(state.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
});

// ---------------------------------------------------------------------------
// state.js — ultracode-session adoption and query
// ---------------------------------------------------------------------------

test("hub: query lists shared ultracode sessions with inferred stage", (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());

  const publisher = registerDefault(state, fixture);
  // A recorded plan approval bumps the inferred stage.
  fs.writeFileSync(
    path.join(fixture.sessionDir, "gates.json"),
    JSON.stringify({ plan: { decision: "approved" } }),
  );

  const { sessions } = state.queryUltracodeSessions({ repo_root: fixture.repoRoot });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].ultracode_session_id, "test-abc123");
  assert.equal(sessions[0].session_dir, fixture.sessionDir);
  assert.equal(sessions[0].stage, "plan-approved");
  assert.equal(sessions[0].participants[0].session_key, publisher.session_key);
});

test("hub: adopt links a native session to a shared session and writes the hook link file", (t) => {
  const fixture = makeFixture(t);
  const { HubFacade } = require(path.join(ROOT, "mcp", "lib", "hub", "http.js"));
  const { readLinks, isAdoptedSessionDir } = require(path.join(ROOT, "hooks", "lib", "session-link.js"));
  const state = freshHubState(fixture);
  t.after(() => state.close());
  const facade = new HubFacade(state);

  registerDefault(state, fixture); // publisher owns fixture.sessionDir (id test-abc123)

  // A codex worker with its OWN native session registers, then adopts the
  // publisher's shared session dir.
  const workerDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-codex-w");
  fs.mkdirSync(workerDir, { recursive: true });
  const worker = state.registerSession({
    harness: "codex",
    session_id: "codex-w",
    repo_roots: [fixture.repoRoot],
    session_dir: workerDir,
  });

  return facade
    .adoptSession({
      session_key: worker.session_key,
      session_secret: worker.session_secret,
      session_dir: fixture.sessionDir,
    })
    .then((result) => {
      assert.equal(result.ultracode_session_id, "test-abc123");
      assert.equal(result.session_dir, fixture.sessionDir);

      // The DB knows the adoption for resume/query.
      const links = readLinks("codex", "codex-w");
      assert.equal(links.length, 1);
      assert.equal(links[0].session_dir, fixture.sessionDir);

      // The hook helper authorizes the shared dir for this native session only.
      assert.equal(
        isAdoptedSessionDir("codex", "codex-w", fixture.sessionDir, fixture.repoRoot),
        true,
      );
      assert.equal(
        isAdoptedSessionDir("codex", "someone-else", fixture.sessionDir, fixture.repoRoot),
        false,
      );

      // Resume by id resolves the same dir.
      return facade.adoptSession({
        session_key: worker.session_key,
        session_secret: worker.session_secret,
        ultracode_session_id: "test-abc123",
        repo_root: fixture.repoRoot,
      });
    })
    .then((byId) => {
      assert.equal(byId.session_dir, fixture.sessionDir);
    });
});

test("hub: a worker may complete a task with a report inside its adopted session dir", (t) => {
  const fixture = makeFixture(t);
  const { HubFacade } = require(path.join(ROOT, "mcp", "lib", "hub", "http.js"));
  const state = freshHubState(fixture);
  t.after(() => state.close());
  const facade = new HubFacade(state);

  const publisher = registerDefault(state, fixture);
  const workerDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-cx-adopt");
  fs.mkdirSync(workerDir, { recursive: true });
  const worker = state.registerSession({
    harness: "codex",
    session_id: "cx-adopt",
    repo_roots: [fixture.repoRoot],
    session_dir: workerDir,
  });
  const published = state.publishTask({
    from_session_key: publisher.session_key,
    from_secret: publisher.session_secret,
    title: "Adopted-dir task",
    payload: validPayload(fixture),
  });
  state.claimTask({ session_key: worker.session_key, session_secret: worker.session_secret });

  return facade
    .adoptSession({
      session_key: worker.session_key,
      session_secret: worker.session_secret,
      session_dir: fixture.sessionDir,
    })
    .then(() => {
      // A report in the PUBLISHER's (adopted) session dir is now allowed...
      const reportInShared = path.join(fixture.sessionDir, "repo", "ultracode-implement-phase-2.md");
      const done = state.completeTask({
        session_key: worker.session_key,
        session_secret: worker.session_secret,
        task_id: published.task_id,
        status: "done",
        summary: "done in the shared session",
        report_file: reportInShared,
      });
      assert.equal(done.ok, true);
      // ...while a totally unrelated dir is still rejected.
      const other = state.publishTask({
        from_session_key: publisher.session_key,
        from_secret: publisher.session_secret,
        title: "second",
        payload: validPayload(fixture),
      });
      state.claimTask({ session_key: worker.session_key, session_secret: worker.session_secret });
      assert.throws(
        () =>
          state.completeTask({
            session_key: worker.session_key,
            session_secret: worker.session_secret,
            task_id: other.task_id,
            status: "done",
            summary: "bad path",
            report_file: path.join(fixture.dir, "elsewhere.md"),
          }),
        /own registered session_dir or a session it has adopted/,
      );
    });
});

// ---------------------------------------------------------------------------
// task-contract.js
// ---------------------------------------------------------------------------

test("hub: task contract rejects missing addresses, relative paths, and escapes", (t) => {
  const fixture = makeFixture(t);
  const { validateTaskPayload } = require(path.join(ROOT, "mcp", "lib", "hub", "task-contract.js"));

  assert.equal(validateTaskPayload(validPayloadFor(fixture)).ok, true);

  const noKey = validPayloadFor(fixture);
  delete noKey.repo_key;
  assert.match(validateTaskPayload(noKey).errors.join(" "), /repo_key/);

  const badAgent = validPayloadFor(fixture, { agent_hint: "not-an-agent" });
  assert.match(validateTaskPayload(badAgent).errors.join(" "), /not a shipped agent/);

  const relative = validPayloadFor(fixture);
  relative.source.phase_file = "plans/phase.md";
  assert.match(validateTaskPayload(relative).errors.join(" "), /absolute/);

  const escape = validPayloadFor(fixture);
  escape.source.phase_file = path.join(fixture.dir, "outside.md");
  assert.match(validateTaskPayload(escape).errors.join(" "), /inside the publisher's session dir/);

  const bloated = validPayloadFor(fixture, { blob: "x".repeat(33 * 1024) });
  assert.match(validateTaskPayload(bloated).errors.join(" "), /pass file paths/);

  function validPayloadFor(fx, overrides = {}) {
    return {
      agent_hint: "implement",
      task: "Do the thing.",
      repo_root: fx.repoRoot,
      repo_key: "repo",
      source: {
        session_dir: fx.sessionDir,
        phase_file: path.join(fx.sessionDir, "phase.md"),
      },
      ...overrides,
    };
  }
});

// ---------------------------------------------------------------------------
// config.js + lock.js
// ---------------------------------------------------------------------------

test("hub: provision is idempotent, 0600, and rotateToken changes only the token", (t) => {
  const fixture = makeFixture(t);
  const config = require(path.join(ROOT, "mcp", "lib", "hub", "config.js"));

  const first = config.provision();
  const second = config.provision();
  assert.equal(first.token, second.token);
  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.ok(config.hubInfoPath().startsWith(fixture.hubHome));
  const mode = fs.statSync(config.hubInfoPath()).mode & 0o777;
  assert.equal(mode, 0o600);

  const rotated = config.rotateToken();
  assert.notEqual(rotated.token, first.token);
  assert.equal(rotated.port, first.port);
});

// ---------------------------------------------------------------------------
// Live daemon: REST surface, long-poll, MCP-over-HTTP, lifecycle
// ---------------------------------------------------------------------------

// Boots a real hub daemon on an ephemeral port under the fixture's machine
// state root and returns a HubClient bound to it (env is already pointed at
// the fixture by makeFixture).
async function startDaemon(t) {
  process.env.ULTRACODE_HUB_PORT = "0";
  t.after(() => {
    delete process.env.ULTRACODE_HUB_PORT;
  });
  const { HubClient } = require(path.join(ROOT, "mcp", "lib", "hub", "client.js"));
  const client = new HubClient();
  const health = await client.ensureRunning({ timeoutMs: 8000 });
  assert.ok(health, "daemon should become healthy");
  // Kill by captured pid, not via the lock file: the fixture dir (and the
  // lock inside it) may already be deleted by the time after-hooks run, and a
  // stopDaemon that finds no lock holder would leak the daemon.
  const { currentHolder } = require(path.join(ROOT, "mcp", "lib", "hub", "lock.js"));
  const holderPid = (currentHolder() || {}).pid;
  t.after(() => {
    if (holderPid) {
      try {
        process.kill(holderPid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  });
  return client;
}

async function registerViaClient(client, fixture, overrides = {}) {
  return client.registerSession({
    harness: "claude",
    session_id: "test-abc123",
    repo_roots: [fixture.repoRoot],
    session_dir: fixture.sessionDir,
    ...overrides,
  });
}

test("hub daemon: healthz is open, everything else requires the bearer token", async (t) => {
  const fixture = makeFixture(t);
  const client = await startDaemon(t);
  const config = require(path.join(ROOT, "mcp", "lib", "hub", "config.js"));
  const info = config.readHubInfo();

  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const open = await fetch(`${info.url}/healthz`);
  assert.equal(open.status, 200);

  const noToken = await fetch(`${info.url}/api/v1/sessions`);
  assert.equal(noToken.status, 401);
  const badToken = await fetch(`${info.url}/api/v1/sessions`, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(badToken.status, 401);

  const oversized = await fetch(`${info.url}/api/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: JSON.stringify({ pad: "x".repeat(3 * 1024 * 1024) }),
  });
  assert.equal(oversized.status, 413);

  const reg = await registerViaClient(client, fixture);
  assert.equal(reg.session_key, "claude:test-abc123");
});

test("hub daemon: msg_wait long-poll resolves when a concurrent send lands", async (t) => {
  const fixture = makeFixture(t);
  const client = await startDaemon(t);

  const alice = await registerViaClient(client, fixture);
  const bobDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-bob-lp");
  fs.mkdirSync(bobDir, { recursive: true });
  const bob = await registerViaClient(client, fixture, {
    harness: "grok",
    session_id: "bob-lp",
    session_dir: bobDir,
  });

  const waitPromise = client.waitMessages({
    session_key: bob.session_key,
    session_secret: bob.session_secret,
    cursor: bob.cursor,
    timeout_ms: 15000,
  });
  // Give the long-poll a moment to park before sending.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const started = Date.now();
  const sent = await client.sendMessage({
    from_session_key: alice.session_key,
    from_secret: alice.session_secret,
    to_session_key: bob.session_key,
    body: "report ready at ultracode-implement-phase-1.md",
  });
  assert.equal(sent.pushed, true);
  assert.equal(sent.channel, "long-poll");
  const waited = await waitPromise;
  assert.ok(Date.now() - started < 5000, "long-poll should resolve promptly, not at timeout");
  assert.equal(waited.timed_out, false);
  assert.equal(waited.messages.length, 1);
  assert.equal(waited.messages[0].body, "report ready at ultracode-implement-phase-1.md");
});

test("hub daemon: MCP-over-HTTP lists all 15 tools and core tools behave as on stdio", async (t) => {
  const fixture = makeFixture(t);
  await startDaemon(t);
  const config = require(path.join(ROOT, "mcp", "lib", "hub", "config.js"));
  const info = config.readHubInfo();

  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const {
    StreamableHTTPClientTransport,
  } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(`${info.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${info.token}` } },
  });
  const mcpClient = new Client({ name: "hub-test", version: "0.0.0" });
  await mcpClient.connect(transport);
  t.after(() => mcpClient.close());

  const { tools } = await mcpClient.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "ultracode_gate",
    "ultracode_memory",
    "ultracode_memory_forget",
    "ultracode_memory_recall",
    "ultracode_msg_send",
    "ultracode_msg_wait",
    "ultracode_report",
    "ultracode_session_adopt",
    "ultracode_session_heartbeat",
    "ultracode_session_list",
    "ultracode_session_query",
    "ultracode_session_register",
    "ultracode_task_claim",
    "ultracode_task_complete",
    "ultracode_task_publish",
  ]);

  // Core-tool parity: a rejected gate decision lands in the same gates.json a
  // stdio ultracode_gate call writes.
  const gateResult = await mcpClient.callTool({
    name: "ultracode_gate",
    arguments: {
      session_dir: fixture.sessionDir,
      repo_key: "repo",
      gate: "spec",
      decision: "rejected",
      notes: "over http",
    },
  });
  assert.notEqual(gateResult.isError, true);
  const gates = JSON.parse(fs.readFileSync(path.join(fixture.sessionDir, "gates.json"), "utf-8"));
  assert.equal(gates.spec.decision, "rejected");
  assert.equal(gates.spec.repo, "repo");

  // Hub tools work over the same endpoint.
  const registered = await mcpClient.callTool({
    name: "ultracode_session_register",
    arguments: {
      harness: "codex",
      session_id: "mcp-http-1",
      repo_roots: [fixture.repoRoot],
      session_dir: fixture.sessionDir,
    },
  });
  const parsed = JSON.parse(registered.content[0].text);
  assert.equal(parsed.session_key, "codex:mcp-http-1");
});

test("hub daemon: ensure is idempotent and SIGTERM resolves a parked long-poll with shutdown", async (t) => {
  const fixture = makeFixture(t);
  const client = await startDaemon(t);
  const { currentHolder } = require(path.join(ROOT, "mcp", "lib", "hub", "lock.js"));

  const firstPid = currentHolder().pid;
  const again = await client.ensureRunning({ timeoutMs: 4000 });
  assert.ok(again);
  assert.equal(currentHolder().pid, firstPid, "second ensure must not start a second daemon");

  const reg = await registerViaClient(client, fixture);
  const waitPromise = client.waitMessages({
    session_key: reg.session_key,
    session_secret: reg.session_secret,
    cursor: reg.cursor,
    timeout_ms: 30000,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const started = Date.now();
  await client.stopDaemon();
  const drained = await waitPromise;
  assert.ok(Date.now() - started < 6000, "shutdown must resolve the parked long-poll");
  assert.equal(drained.shutdown, true);
  assert.equal(drained.messages.length, 0);
});

// ---------------------------------------------------------------------------
// hub-shim.js: the stdio entry point every harness registers
// ---------------------------------------------------------------------------

async function connectShim(t, env) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "mcp", "hub-shim.js")],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "shim-test", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

test("hub shim: offline boot serves core tools and actionable hub-tool errors", async (t) => {
  const fixture = makeFixture(t);
  const shim = await connectShim(t, {
    ULTRACODE_HUB_HOME: fixture.hubHome,
    ULTRACODE_HUB_DISABLE: "1",
  });

  const { tools } = await shim.listTools();
  assert.equal(tools.length, 15, "hub tools stay registered even offline");

  const gate = await shim.callTool({
    name: "ultracode_gate",
    arguments: { session_dir: fixture.sessionDir, repo_key: "repo", gate: "spec", decision: "rejected" },
  });
  assert.notEqual(gate.isError, true, "core tools must work with no hub");

  const hubTool = await shim.callTool({
    name: "ultracode_session_list",
    arguments: {},
  });
  assert.equal(hubTool.isError, true);
  assert.match(hubTool.content[0].text, /hub is not reachable/);
});

test("hub shim: lazily starts the daemon and round-trips hub tools over REST", async (t) => {
  const fixture = makeFixture(t);
  process.env.ULTRACODE_HUB_PORT = "0";
  t.after(() => {
    delete process.env.ULTRACODE_HUB_PORT;
  });
  const shim = await connectShim(t, {
    ULTRACODE_HUB_HOME: fixture.hubHome,
    ULTRACODE_HUB_PORT: "0",
  });
  // The shim spawned the daemon lazily; capture its pid for cleanup before
  // any fixture teardown can delete the lock file (see startDaemon).
  const { currentHolder } = require(path.join(ROOT, "mcp", "lib", "hub", "lock.js"));
  const deadline = Date.now() + 5000;
  let holderPid = null;
  while (Date.now() < deadline && !holderPid) {
    holderPid = (currentHolder() || {}).pid || null;
    if (!holderPid) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  t.after(() => {
    if (holderPid) {
      try {
        process.kill(holderPid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  });

  const registered = await shim.callTool({
    name: "ultracode_session_register",
    arguments: {
      harness: "grok",
      session_id: "shim-1",
      repo_roots: [fixture.repoRoot],
      session_dir: fixture.sessionDir,
    },
  });
  assert.notEqual(registered.isError, true, registered.content && registered.content[0].text);
  const parsed = JSON.parse(registered.content[0].text);
  assert.equal(parsed.session_key, "grok:shim-1");

  const listed = await shim.callTool({ name: "ultracode_session_list", arguments: {} });
  assert.match(listed.content[0].text, /grok:shim-1/);
});

// ---------------------------------------------------------------------------
// write guards: ~/.ultracode is tool-owned machine state
// ---------------------------------------------------------------------------

test("hub guards: model-issued writes into the machine state root are denied", (t) => {
  const fixture = makeFixture(t);
  const { isMachineStatePath } = require(path.join(ROOT, "hooks", "lib", "common.js"));

  assert.equal(isMachineStatePath(path.join(fixture.hubHome, "hub.json")), true);
  assert.equal(isMachineStatePath(path.join(fixture.hubHome, "hub", "hub.sqlite3")), true);
  assert.equal(isMachineStatePath(path.join(fixture.repoRoot, "hub.json")), false, "a repo's own hub.json stays writable");
  assert.equal(isMachineStatePath(path.join(fixture.repoRoot, ".ultracode", "session")), false, "repo runtime dirs are not machine state");
});

test("hub guards: session-guard accepts an adopted shared session dir, rejects an unadopted one", (t) => {
  const fixture = makeFixture(t);
  const { execFileSync } = require("node:child_process");
  const { writeLink } = require(path.join(ROOT, "hooks", "lib", "session-link.js"));

  // Generate a Claude dist so the hooks resolve target + runtime dir.
  const dist = path.join(fixture.dir, "dist");
  execFileSync("node", [
    path.join(ROOT, "scripts", "generate_definitions.js"),
    "--target", "claude",
    "--source-root", ROOT,
    "--output-dir", dist,
  ], { stdio: "ignore" });

  // Worker native session WORKER; shared session dir belongs to publisher id PUB.
  const sharedDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-PUB", "live");
  fs.mkdirSync(sharedDir, { recursive: true });
  const prompt = [
    `Primary repo root: ${fixture.repoRoot}.`,
    `Repo root: ${fixture.repoRoot}.`,
    `Session dir: ${sharedDir}.`,
    `Repo key: live.`,
    `Phase file: ${path.join(fixture.repoRoot, ".ultracode/session/ultracode-session-PUB/live/ultracode-plan-x-phase-2.md")}.`,
    `Report file: ${path.join(sharedDir, "ultracode-implement-phase-2.md")}.`,
    `Task: implement phase 2.`,
  ].join("\n");
  const payload = JSON.stringify({
    session_id: "WORKER",
    cwd: fixture.repoRoot,
    tool_name: "Task",
    tool_input: { subagent_type: "ultracode:implement", prompt },
  });

  const runGuard = () =>
    execFileSync("node", [path.join(dist, "hooks", "session-guard.js")], {
      input: payload,
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: "WORKER", ULTRACODE_HUB_HOME: fixture.hubHome },
    });

  // No adoption yet: the shared dir (id PUB) is not this native session's, so it is rejected.
  const denied = runGuard();
  assert.match(denied, /not under the primary repository session root|PUB/);

  // Record the adoption link; now the same spawn is allowed (empty output).
  writeLink("claude", "WORKER", {
    ultracode_session_id: "PUB",
    primary_repo_root: fixture.repoRoot,
    session_dir: path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-PUB"),
  });
  const allowed = runGuard();
  assert.equal(allowed, "", "adopted shared session dir must pass session-guard");
});

// ---------------------------------------------------------------------------
// push adapters
// ---------------------------------------------------------------------------

test("hub push: unavailable codex CLI degrades to pull without losing the message", async (t) => {
  const fixture = makeFixture(t);
  const state = freshHubState(fixture);
  t.after(() => state.close());
  const { HubFacade } = require(path.join(ROOT, "mcp", "lib", "hub", "http.js"));
  const codexAdapter = require(path.join(ROOT, "mcp", "lib", "push", "codex.js"));

  // Point PATH at an empty dir so `codex` cannot exist, then re-detect.
  const emptyBin = path.join(fixture.dir, "empty-bin");
  fs.mkdirSync(emptyBin);
  const oldPath = process.env.PATH;
  process.env.PATH = emptyBin;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  codexAdapter._resetAvailability();
  t.after(() => codexAdapter._resetAvailability());

  const facade = new HubFacade(state);
  const alice = registerDefault(state, fixture);
  const codexDir = path.join(fixture.repoRoot, ".ultracode", "session", "ultracode-session-cx-1");
  fs.mkdirSync(codexDir, { recursive: true });
  const codexSession = registerDefault(state, fixture, {
    harness: "codex",
    session_id: "cx-1",
    session_dir: codexDir,
    native_channel: "codex-queue",
    native_address: "cx-worker",
  });

  const sent = await facade.sendMessage({
    from_session_key: alice.session_key,
    from_secret: alice.session_secret,
    to_session_key: codexSession.session_key,
    body: "wake up",
  });
  assert.equal(sent.pushed, false);

  const fetched = state.fetchMessages({
    session_key: codexSession.session_key,
    session_secret: codexSession.session_secret,
    cursor: codexSession.cursor,
  });
  assert.equal(fetched.messages.length, 1, "undelivered push must remain fetchable");
});

test("hub push: claude adapter speaks the real UDS protocol when flag-enabled", async (t) => {
  const fixture = makeFixture(t);
  const crypto = require("node:crypto");
  const claudeAdapter = require(path.join(ROOT, "mcp", "lib", "push", "claude.js"));
  const session = {
    session_key: "claude:x",
    native_channel: "claude-uds",
    native_address: "my-session",
  };

  delete process.env.ULTRACODE_HUB_CLAUDE_PUSH;
  assert.equal(await claudeAdapter.push(session, "notice"), false, "disabled by default");

  // Stand up a fixture matching Claude Code's real ~/.claude/sessions layout:
  // a <pid>.json record + a <pid>.<sha256(socketPath)>.key with a peerToken,
  // and a UDS listener that captures the newline-delimited auth + user frames.
  const sessDir = path.join(fixture.dir, "claude-sessions");
  fs.mkdirSync(sessDir, { recursive: true });
  const socketPath = path.join(fixture.dir, "claude.sock");
  const pid = 424242;
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const peerToken = "0123456789abcdef0123456789abcdef";
  fs.writeFileSync(
    path.join(sessDir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, name: "my-session", messagingSocketPath: socketPath }),
  );
  const hash = crypto.createHash("sha256").update(socketPath).digest("hex");
  fs.writeFileSync(path.join(sessDir, `${pid}.${hash}.key`), JSON.stringify({ peerToken }));

  const frames = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) frames.push(JSON.parse(line));
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());

  process.env.ULTRACODE_HUB_CLAUDE_PUSH = "1";
  process.env.ULTRACODE_CLAUDE_SESSIONS_DIR = sessDir;
  t.after(() => {
    delete process.env.ULTRACODE_HUB_CLAUDE_PUSH;
    delete process.env.ULTRACODE_CLAUDE_SESSIONS_DIR;
  });

  assert.equal(await claudeAdapter.push(session, "hub wake notice"), true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(frames.length, 2, "an auth frame then a user frame");
  assert.deepEqual(frames[0], { type: "auth", token: peerToken });
  assert.equal(frames[1].type, "user");
  assert.equal(frames[1].session_id, sessionId);
  assert.equal(frames[1].message.role, "user");
  assert.match(frames[1].message.content, /hub wake notice/);

  assert.equal(
    await claudeAdapter.push({ ...session, native_address: "unknown" }, "notice"),
    false,
    "unknown session name degrades to pull",
  );
  // A record without a readable key file also degrades to pull.
  fs.writeFileSync(
    path.join(sessDir, "999.json"),
    JSON.stringify({ pid: 999, sessionId: "x", name: "keyless", messagingSocketPath: socketPath }),
  );
  assert.equal(
    await claudeAdapter.push({ ...session, native_address: "keyless" }, "notice"),
    false,
    "missing peer token degrades to pull",
  );
});

test("hub: lock is exclusive, stale locks are reclaimed", (t) => {
  makeFixture(t);
  const { acquireLock, releaseLock } = require(path.join(ROOT, "mcp", "lib", "hub", "lock.js"));

  const first = acquireLock({ pid: process.pid, port: 1 });
  assert.equal(first.acquired, true);
  const second = acquireLock({ pid: process.pid, port: 2 });
  assert.equal(second.acquired, false);
  assert.equal(second.holder.pid, process.pid);
  releaseLock({ pid: process.pid });

  // A lock held by a dead pid is stale and gets reclaimed.
  const config = require(path.join(ROOT, "mcp", "lib", "hub", "config.js"));
  fs.mkdirSync(path.dirname(config.hubLockPath()), { recursive: true });
  fs.writeFileSync(config.hubLockPath(), JSON.stringify({ pid: 999999999, port: 3 }));
  const reclaimed = acquireLock({ pid: process.pid, port: 4 });
  assert.equal(reclaimed.acquired, true);
  releaseLock({ pid: process.pid });
});
