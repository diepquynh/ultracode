"use strict";
// Spawn tickets: the plaintext contract side-channel for harnesses whose
// spawn messages are end-to-end encrypted (codex with OpenAI models). These
// tests pin the whole chain: ciphertext detection, the machine-state ticket
// store, session-guard requiring/consuming a ticket for an opaque spawn, and
// model-router never touching a sealed message while still stripping the
// plaintext fork_turns argument.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const GENERATOR = path.join(ROOT, "scripts", "generate_definitions.js");

// A realistic sealed message: single Fernet-style token, no whitespace.
const CIPHERTEXT = `gAAAA${crypto.randomBytes(180).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "x")}`;

let WORKSPACE;
let CODEX_ROOT;
let CLAUDE_ROOT;
let GROK_ROOT;

before(() => {
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-ticket-"));
  CODEX_ROOT = path.join(WORKSPACE, "codex");
  CLAUDE_ROOT = path.join(WORKSPACE, "claude");
  GROK_ROOT = path.join(WORKSPACE, "grok");
  for (const [target, output] of [
    ["codex", CODEX_ROOT],
    ["claude", CLAUDE_ROOT],
    ["grok", GROK_ROOT],
  ]) {
    execFileSync("node", [GENERATOR, "--target", target, "--output-dir", output], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
});

after(() => {
  if (WORKSPACE) fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

function makeStateHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-ticket-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// A repo whose session dir matches what session-guard derives for this
// native session id, mirroring the layout every harness uses.
function makeSessionFixture(t, sessionId) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-ticket-repo-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const sessionDir = path.join(
    repoRoot,
    ".ultracode",
    "session",
    `ultracode-session-${sessionId}`,
    "repo",
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  return { repoRoot, sessionDir };
}

function ticketParameters(fixture) {
  return {
    primary_repo_root: fixture.repoRoot,
    repo_root: fixture.repoRoot,
    session_dir: fixture.sessionDir,
    repo_key: "repo",
    task: "Write the spec for the widget service",
  };
}

function runHook(pluginRoot, hookName, input, stateHome) {
  const result = spawnSync("node", [path.join(pluginRoot, "hooks", hookName)], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...process.env, PLUGIN_ROOT: pluginRoot, ULTRACODE_HUB_HOME: stateHome },
  });
  assert.equal(result.status, 0, `${hookName} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function codexSpawnInput(fixture, sessionId, extra = {}) {
  return {
    session_id: sessionId,
    cwd: fixture.repoRoot,
    tool_input: {
      agent_type: "ultracode_generate_spec",
      fork_turns: "all",
      message: CIPHERTEXT,
      ...extra,
    },
  };
}

test("opaque ciphertext detection matches sealed messages only", () => {
  const { isOpaqueCiphertext } = require(path.join(ROOT, "hooks", "lib", "harness.js"));
  assert.equal(isOpaqueCiphertext(CIPHERTEXT), true);
  assert.equal(isOpaqueCiphertext(`Repo root: /tmp\nTask: do things`), false);
  // Short tokens and prose that merely starts with the prefix are not sealed.
  assert.equal(isOpaqueCiphertext("gAAAAshort"), false);
  assert.equal(isOpaqueCiphertext(`gAAAA but actually a sentence ${"x".repeat(90)}`), false);
  assert.equal(isOpaqueCiphertext(""), false);
});

test("ticket store: file, newest wins, TTL expiry, single-use consumption", (t) => {
  const home = makeStateHome(t);
  process.env.ULTRACODE_HUB_HOME = home;
  t.after(() => delete process.env.ULTRACODE_HUB_HOME);
  const store = require(path.join(ROOT, "hooks", "lib", "spawn-ticket.js"));

  assert.equal(store.findTicket("codex", "sess-1", "generate-spec"), null);

  const first = store.fileTicket("codex", "sess-1", "generate-spec", { task: "first" });
  const second = store.fileTicket("codex", "sess-1", "generate-spec", { task: "second" });
  assert.notEqual(first.path, second.path);

  // second was filed later in the same millisecond or after; force ordering.
  const older = JSON.parse(fs.readFileSync(first.path, "utf-8"));
  older.filed_at = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(first.path, JSON.stringify(older));

  const found = store.findTicket("codex", "sess-1", "generate-spec");
  assert.equal(found.data.parameters.task, "second", "newest ticket wins");

  // Other sessions and other agents never see it.
  assert.equal(store.findTicket("codex", "sess-2", "generate-spec"), null);
  assert.equal(store.findTicket("codex", "sess-1", "plan"), null);

  // Expired tickets are invisible.
  const stale = JSON.parse(fs.readFileSync(second.path, "utf-8"));
  stale.filed_at = new Date(Date.now() - store.TICKET_TTL_MS - 1000).toISOString();
  fs.writeFileSync(second.path, JSON.stringify(stale));
  fs.rmSync(first.path);
  assert.equal(store.findTicket("codex", "sess-1", "generate-spec"), null);

  // Consumption marks in place; the file (and its values) remain readable.
  const third = store.fileTicket("codex", "sess-1", "generate-spec", { task: "third" });
  assert.equal(store.consumeTicket(third.path), true);
  const consumed = store.findTicket("codex", "sess-1", "generate-spec");
  assert.ok(consumed.data.consumed_at, "consumed_at recorded");
  assert.equal(consumed.data.parameters.task, "third");
});

test("codex adapter: remove patch strips fork_turns without touching the message", () => {
  const { adapterFor } = require(path.join(ROOT, "hooks", "lib", "harness.js"));
  const adapter = adapterFor("codex");
  const toolInput = { agent_type: "ultracode_generate_spec", fork_turns: "all", message: CIPHERTEXT };
  const spawns = adapter.spawnEntries(toolInput, new Set(["generate-spec"]));
  assert.equal(spawns[0].agent, "generate-spec");
  assert.equal(spawns[0].promptOpaque, true);
  const rewritten = adapter.rewriteSpawns(toolInput, new Map([[0, { remove: ["fork_turns"] }]]));
  assert.equal(rewritten.fork_turns, undefined);
  assert.equal(rewritten.message, CIPHERTEXT, "sealed message byte-identical");
  assert.equal(rewritten.agent_type, "ultracode_generate_spec");
});

test("session-guard refuses an opaque spawn without a ticket, naming the tool", (t) => {
  const home = makeStateHome(t);
  const sessionId = "cdx-noticket";
  const fixture = makeSessionFixture(t, sessionId);
  const stdout = runHook(CODEX_ROOT, "session-guard.js", codexSpawnInput(fixture, sessionId), home);
  const payload = JSON.parse(stdout);
  assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /end-to-end encrypted/);
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /ultracode_spawn_ticket/);
});

test("session-guard validates and consumes a ticket for an opaque spawn", (t) => {
  const home = makeStateHome(t);
  const sessionId = "cdx-ticketed";
  const fixture = makeSessionFixture(t, sessionId);
  process.env.ULTRACODE_HUB_HOME = home;
  t.after(() => delete process.env.ULTRACODE_HUB_HOME);
  const store = require(path.join(ROOT, "hooks", "lib", "spawn-ticket.js"));
  const ticket = store.fileTicket("codex", sessionId, "generate-spec", ticketParameters(fixture));

  const allowed = runHook(CODEX_ROOT, "session-guard.js", codexSpawnInput(fixture, sessionId), home);
  assert.equal(allowed.trim(), "", "valid ticket: guard stays silent");
  const consumed = JSON.parse(fs.readFileSync(ticket.path, "utf-8"));
  assert.ok(consumed.consumed_at, "guard consumed the ticket");

  // The same ticket cannot vouch for a second spawn.
  const replay = runHook(CODEX_ROOT, "session-guard.js", codexSpawnInput(fixture, sessionId), home);
  const payload = JSON.parse(replay);
  assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /already consumed/);
});

test("session-guard rejects a ticket whose contract is incomplete", (t) => {
  const home = makeStateHome(t);
  const sessionId = "cdx-badticket";
  const fixture = makeSessionFixture(t, sessionId);
  process.env.ULTRACODE_HUB_HOME = home;
  t.after(() => delete process.env.ULTRACODE_HUB_HOME);
  const store = require(path.join(ROOT, "hooks", "lib", "spawn-ticket.js"));
  const incomplete = ticketParameters(fixture);
  delete incomplete.task;
  store.fileTicket("codex", sessionId, "generate-spec", incomplete);

  const stdout = runHook(CODEX_ROOT, "session-guard.js", codexSpawnInput(fixture, sessionId), home);
  const payload = JSON.parse(stdout);
  assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /no Task:/);
});

test("model-router leaves a sealed message untouched and strips fork_turns", (t) => {
  const home = makeStateHome(t);
  const sessionId = "cdx-routed";
  const fixture = makeSessionFixture(t, sessionId);
  fs.writeFileSync(
    path.join(fixture.repoRoot, ".ultracode", "repo-profile.json"),
    JSON.stringify({ models: { byAgent: { "generate-spec": "advanced" }, byPhaseComplexity: {} } }),
  );
  // An inventory that would normally earn the prompt a repo brief.
  fs.writeFileSync(
    path.join(fixture.repoRoot, ".ultracode", "INVENTORY.md"),
    "# repo — ultracode Inventory\n| build | `make` |\n",
  );
  process.env.ULTRACODE_HUB_HOME = home;
  t.after(() => delete process.env.ULTRACODE_HUB_HOME);
  const store = require(path.join(ROOT, "hooks", "lib", "spawn-ticket.js"));
  store.fileTicket("codex", sessionId, "generate-spec", ticketParameters(fixture));

  const stdout = runHook(CODEX_ROOT, "model-router.js", codexSpawnInput(fixture, sessionId), home);
  const payload = JSON.parse(stdout);
  const updated = payload.hookSpecificOutput.updatedInput;
  assert.equal(payload.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(updated.message, CIPHERTEXT, "ciphertext byte-identical — no brief appended");
  // Codex defaults an absent fork_turns to "all", so the router must pin an
  // explicit "none" rather than delete the key.
  assert.equal(updated.fork_turns, "none");
  // Role TOMLs carry no model on purpose; this injected argument is the
  // route (generate-spec → advanced tier for codex).
  const mapping = JSON.parse(
    fs.readFileSync(path.join(ROOT, "definitions", "model-mapping.json"), "utf-8"),
  );
  assert.equal(updated.model, mapping.tiers.advanced.codex);
});

test("model-router stays silent on an opaque spawn without a ticket", (t) => {
  const home = makeStateHome(t);
  const sessionId = "cdx-router-noticket";
  const fixture = makeSessionFixture(t, sessionId);
  fs.writeFileSync(
    path.join(fixture.repoRoot, ".ultracode", "repo-profile.json"),
    JSON.stringify({ models: { byAgent: { "generate-spec": "advanced" }, byPhaseComplexity: {} } }),
  );
  const stdout = runHook(CODEX_ROOT, "model-router.js", codexSpawnInput(fixture, sessionId), home);
  assert.equal(stdout.trim(), "", "session-guard owns the denial; router adds nothing");
});

test("ultracode_spawn_ticket tool validates the contract before filing", async (t) => {
  const home = makeStateHome(t);
  process.env.ULTRACODE_HUB_HOME = home;
  t.after(() => delete process.env.ULTRACODE_HUB_HOME);
  const fixture = makeSessionFixture(t, "cdx-tool");

  const { createUltracodeServer } = require(path.join(ROOT, "mcp", "create-server.js"));
  const { fileTicket, findTicket } = require(path.join(ROOT, "hooks", "lib", "spawn-ticket.js"));
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

  const server = createUltracodeServer({
    deps: {
      pluginTargetInfo: () => ({ target: "codex", runtimeDir: ".ultracode" }),
      fileSpawnTicket: fileTicket,
      // The repo checkout has no generated routing table to derive the agent
      // set from; the dist runtime does.
      knownAgents: () => new Set(["generate-spec"]),
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "ticket-test", version: "0.0.0" });
  await client.connect(clientTransport);
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "ultracode_spawn_ticket"));

  const unknown = await client.callTool({
    name: "ultracode_spawn_ticket",
    arguments: { harness_session_id: "cdx-tool", agent: "made-up-agent", parameters: {} },
  });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /not a known ultracode agent/);

  const incomplete = await client.callTool({
    name: "ultracode_spawn_ticket",
    arguments: {
      harness_session_id: "cdx-tool",
      agent: "ultracode_generate_spec",
      parameters: { repo_root: fixture.repoRoot },
    },
  });
  assert.equal(incomplete.isError, true);
  assert.match(incomplete.content[0].text, /contract is incomplete/);
  assert.match(incomplete.content[0].text, /no Task:/);

  const filed = await client.callTool({
    name: "ultracode_spawn_ticket",
    arguments: {
      harness_session_id: "cdx-tool",
      agent: "ultracode_generate_spec",
      parameters: ticketParameters(fixture),
    },
  });
  assert.notEqual(filed.isError, true, filed.content && filed.content[0] && filed.content[0].text);
  assert.match(filed.content[0].text, /Single-use/);
  const stored = findTicket("codex", "cdx-tool", "generate-spec");
  assert.ok(stored, "ticket landed in machine state");
  assert.equal(stored.data.parameters.repo_key, "repo");
});

test("ultracode_factcheck records the verdict where ultracode_gate reads it", async (t) => {
  const fixture = makeSessionFixture(t, "cdx-verdict");
  const { createUltracodeServer } = require(path.join(ROOT, "mcp", "create-server.js"));
  const { recordGateDecision } = require(path.join(ROOT, "mcp", "lib", "gate.js"));
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

  const server = createUltracodeServer({});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "verdict-test", version: "0.0.0" });
  await client.connect(clientTransport);
  t.after(() => client.close());

  // Approval before any verdict must refuse — that is the deadlock the live
  // codex session hit when the sealed FINAL_ANSWER never reached the hook.
  const premature = recordGateDecision(fixture.sessionDir, "repo", "spec", "approved");
  assert.equal(premature.ok, false);

  const bad = await client.callTool({
    name: "ultracode_factcheck",
    arguments: { session_dir: fixture.sessionDir, repo_key: "NOT A KEY!", target: "spec", verdict: "PASS" },
  });
  assert.equal(bad.isError, true);

  const recorded = await client.callTool({
    name: "ultracode_factcheck",
    arguments: {
      session_dir: fixture.sessionDir,
      repo_key: "repo",
      target: "spec",
      verdict: "PASS",
      findings: [],
    },
  });
  assert.notEqual(recorded.isError, true, recorded.content && recorded.content[0].text);

  const factcheckPath = path.join(fixture.sessionDir, "factcheck.json");
  const written = JSON.parse(fs.readFileSync(factcheckPath, "utf-8"));
  assert.equal(written.spec.verdict, "PASS");
  assert.equal(written.spec.rounds, 1);
  assert.equal(written.spec.source, "factcheck-tool");

  // Same file, same shape ultracode_gate checks: approval now succeeds.
  const approved = recordGateDecision(fixture.sessionDir, "repo", "spec", "approved");
  assert.equal(approved.ok, true, approved.message);

  // A second round increments, mirroring hooks/factcheck-record.js.
  await client.callTool({
    name: "ultracode_factcheck",
    arguments: { session_dir: fixture.sessionDir, repo_key: "repo", target: "spec", verdict: "FAIL", findings: ["x"] },
  });
  const second = JSON.parse(fs.readFileSync(factcheckPath, "utf-8"));
  assert.equal(second.spec.rounds, 2);
  assert.equal(second.spec.verdict, "FAIL");
});

test("codex dist alone carries the self-check preamble and ticket instructions", () => {
  const agentToml = fs.readFileSync(
    path.join(CODEX_ROOT, "agents", "generate-spec.toml"),
    "utf-8",
  );
  assert.match(agentToml, /Task Contract Self-Check/);
  assert.match(agentToml, /contract missing — exiting/);
  assert.match(agentToml, /`Task:`/);

  const codexOrchestrate = fs.readFileSync(
    path.join(CODEX_ROOT, "skills", "orchestrate", "SKILL.md"),
    "utf-8",
  );
  assert.match(codexOrchestrate, /ultracode_spawn_ticket/);
  assert.ok(!codexOrchestrate.includes("{{#codex}}"), "conditional markers resolved");

  const claudeOrchestrate = fs.readFileSync(
    path.join(CLAUDE_ROOT, "commands", "orchestrate.md"),
    "utf-8",
  );
  assert.ok(
    !claudeOrchestrate.includes("ultracode_spawn_ticket"),
    "non-codex dists spend no tokens on the ticket procedure",
  );
  const claudeAgent = fs.readFileSync(
    path.join(CLAUDE_ROOT, "agents", "generate-spec.md"),
    "utf-8",
  );
  assert.ok(!claudeAgent.includes("Task Contract Self-Check"));

  // The fact-check verdict recorder: instructed only where the child's final
  // message never reliably reaches a parent-side hook (codex: sealed agent
  // messages; grok: background-default spawns); everywhere else the
  // parent-side hook records the final message.
  const codexFactCheck = fs.readFileSync(path.join(CODEX_ROOT, "agents", "fact-check.toml"), "utf-8");
  assert.match(codexFactCheck, /ultracode_factcheck/);
  const grokFactCheck = fs.readFileSync(path.join(GROK_ROOT, "agents", "fact-check.md"), "utf-8");
  assert.match(grokFactCheck, /ultracode_factcheck/);
  assert.ok(!grokFactCheck.includes("{{#codex,grok}}"), "comma-list conditional markers resolved");
  const claudeFactCheck = fs.readFileSync(path.join(CLAUDE_ROOT, "agents", "fact-check.md"), "utf-8");
  assert.ok(!claudeFactCheck.includes("ultracode_factcheck"));

  // Grok's spawn prompts are readable, so the ticket procedure must NOT leak
  // into its dist just because it shares the fact-check block with codex.
  const grokOrchestrate = fs.readFileSync(
    path.join(GROK_ROOT, "commands", "orchestrate.md"),
    "utf-8",
  );
  assert.ok(!grokOrchestrate.includes("ultracode_spawn_ticket"));

  // DELIBERATE: factcheck-record.js is not registered on codex (the verdict
  // can never reach a hook there) or on grok (the spawn result is usually a
  // background-launch ack) — docs/harness-limitations.md has the source
  // citations; the fact-check role records via ultracode_factcheck instead.
  // Claude keeps it. If this assertion surprises you, read the doc before
  // "fixing" the registration.
  const codexHooks = fs.readFileSync(path.join(CODEX_ROOT, "hooks", "hooks.json"), "utf-8");
  assert.ok(!codexHooks.includes("factcheck-record.js"), "codex must not register factcheck-record");
  assert.ok(codexHooks.includes("spawn-log.js"), "spawn accounting stays registered on codex");
  const grokHooks = fs.readFileSync(path.join(GROK_ROOT, "hooks", "hooks.json"), "utf-8");
  assert.ok(!grokHooks.includes("factcheck-record.js"), "grok must not register factcheck-record");
  assert.ok(grokHooks.includes("spawn-log.js"), "spawn accounting stays registered on grok");
  const claudeHooks = fs.readFileSync(path.join(CLAUDE_ROOT, "hooks", "hooks.json"), "utf-8");
  assert.ok(claudeHooks.includes("factcheck-record.js"), "claude keeps the PostToolUse recorder");
});
