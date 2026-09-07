"use strict";
// Harness routing enforcement. `harnesses` in repo-profile.json says which
// harness runs each stage; these tests pin that the decision is taken in the
// hook rather than by the orchestrator:
//
//   * a stage routed to another harness that IS listening cannot be spawned
//     locally, and the denial names the harness and the publish call;
//   * every other case (routed here, unrouted, routed at nothing) is allowed
//     WITH a note, so a local run is something the session was told, not
//     something it decided;
//   * repo-profile.json itself is unreadable from a pipeline session, in every
//     channel the harnesses read files through.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const GENERATOR = path.join(ROOT, "scripts", "generate_definitions.js");
const { HubState } = require(path.join(ROOT, "mcp", "lib", "hub", "state.js"));

let WORKSPACE;
const ROOTS = {};

before(() => {
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-routing-"));
  for (const target of ["claude", "codex", "grok", "antigravity"]) {
    ROOTS[target] = path.join(WORKSPACE, target);
    execFileSync("node", [GENERATOR, "--target", target, "--output-dir", ROOTS[target]], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
});

after(() => {
  if (WORKSPACE) fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

function makeStateHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-routing-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// A repo with a profile and the session layout the hub validates against.
function makeRepo(t, { harnesses, sessionId = "sess-routing" }) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-routing-repo-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const runtimeDir = path.join(repoRoot, ".ultracode");
  const sessionDir = path.join(runtimeDir, "session", `ultracode-session-${sessionId}`, "repo");
  fs.mkdirSync(sessionDir, { recursive: true });
  const profile = {
    schemaVersion: 1,
    commands: { build: "npm run build", test: "npm test" },
    models: {
      byAgent: { "code-reviewer": "balanced" },
      byPhaseComplexity: { implementer: { low: "balanced", medium: "balanced", high: "advanced" } },
    },
    ...(harnesses ? { harnesses } : {}),
  };
  fs.writeFileSync(path.join(runtimeDir, "repo-profile.json"), JSON.stringify(profile), "utf-8");
  fs.writeFileSync(path.join(runtimeDir, "INVENTORY.md"), "# demo — ultracode Inventory\n", "utf-8");
  return { repoRoot, runtimeDir, sessionDir, sessionId };
}

// One active, heartbeating session of `harness` registered for this repo —
// what makes a route reachable. Uses the hub's own registration path so the
// row matches the schema the daemon writes.
function registerListener(stateHome, harness, repo) {
  const previous = process.env.ULTRACODE_HUB_HOME;
  process.env.ULTRACODE_HUB_HOME = stateHome;
  const { hubDatabasePath } = require(path.join(ROOT, "mcp", "lib", "hub", "config.js"));
  const state = new HubState(hubDatabasePath());
  try {
    return state.registerSession({
      harness,
      session_id: `${harness}-worker-1`,
      display_name: `${harness} worker`,
      repo_roots: [repo.repoRoot],
      session_dir: repo.sessionDir,
      capabilities: [],
    });
  } finally {
    state.close();
    if (previous === undefined) delete process.env.ULTRACODE_HUB_HOME;
    else process.env.ULTRACODE_HUB_HOME = previous;
  }
}

function ageHeartbeat(stateHome, minutes) {
  const previous = process.env.ULTRACODE_HUB_HOME;
  process.env.ULTRACODE_HUB_HOME = stateHome;
  const { hubDatabasePath } = require(path.join(ROOT, "mcp", "lib", "hub", "config.js"));
  const state = new HubState(hubDatabasePath());
  try {
    state.db
      .prepare("UPDATE sessions SET last_heartbeat_at = ?")
      .run(new Date(Date.now() - minutes * 60 * 1000).toISOString());
  } finally {
    state.close();
    if (previous === undefined) delete process.env.ULTRACODE_HUB_HOME;
    else process.env.ULTRACODE_HUB_HOME = previous;
  }
}

function runHook(target, hookName, input, stateHome, extraEnv = {}) {
  const pluginRoot = ROOTS[target];
  const result = spawnSync("node", [path.join(pluginRoot, "hooks", hookName)], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      GROK_PLUGIN_ROOT: pluginRoot,
      ULTRACODE_HUB_HOME: stateHome,
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, `${hookName} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function spawnInput(repo, agent, extra = {}) {
  return {
    session_id: repo.sessionId,
    cwd: repo.repoRoot,
    tool_input: {
      subagent_type: `ultracode:${agent}`,
      prompt: `Repo root: ${repo.repoRoot}\nSession dir: ${repo.sessionDir}\nRepo key: repo\nTask: review`,
      ...extra,
    },
  };
}

function payload(stdout) {
  return stdout ? JSON.parse(stdout) : null;
}

function note(stdout) {
  const parsed = payload(stdout);
  const output = parsed && parsed.hookSpecificOutput;
  return (output && output.additionalContext) || "";
}

function reason(parsed) {
  if (!parsed) return "";
  if (typeof parsed.reason === "string" && parsed.reason) return parsed.reason;
  const output = parsed.hookSpecificOutput;
  return (output && output.permissionDecisionReason) || "";
}

test("a stage routed to a listening harness cannot be spawned locally", (t) => {
  const home = makeStateHome(t);
  const repo = makeRepo(t, { harnesses: { byAgent: { "code-reviewer": "codex" } } });
  registerListener(home, "codex", repo);

  const denied = payload(runHook("claude", "model-router.js", spawnInput(repo, "code-reviewer"), home));
  assert.match(reason(denied), /routes code-reviewer to codex/);
  assert.match(reason(denied), /ultracode_task_publish/);
  assert.equal(
    denied.hookSpecificOutput.permissionDecision,
    "deny",
    "the local spawn is refused, not merely discouraged",
  );
});

test("a route with nothing listening falls back to a local run, and says so", (t) => {
  const home = makeStateHome(t);
  const repo = makeRepo(t, { harnesses: { byAgent: { "code-reviewer": "codex" } } });

  // Nobody registered at all.
  const empty = runHook("claude", "model-router.js", spawnInput(repo, "code-reviewer"), home);
  assert.match(note(empty), /no codex session is listening/);
  assert.equal(payload(empty).hookSpecificOutput.permissionDecision, undefined);

  // A codex session that stopped heartbeating is not a listener either.
  registerListener(home, "codex", repo);
  ageHeartbeat(home, 30);
  assert.match(
    note(runHook("claude", "model-router.js", spawnInput(repo, "code-reviewer"), home)),
    /no codex session is listening/,
  );

  // A listener on a DIFFERENT harness than the route does not make it reachable.
  const other = makeRepo(t, { harnesses: { byAgent: { "code-reviewer": "grok" } } });
  registerListener(home, "codex", other);
  assert.match(
    note(runHook("claude", "model-router.js", spawnInput(other, "code-reviewer"), home)),
    /no grok session is listening/,
  );
});

test("every allowed spawn carries the routing outcome and its expiry", (t) => {
  const home = makeStateHome(t);
  const unrouted = makeRepo(t, {});
  const local = makeRepo(t, { harnesses: { byAgent: { "code-reviewer": "claude" } } });
  const bogus = makeRepo(t, { harnesses: { byAgent: { "code-reviewer": "local" } } });

  const unroutedNote = note(runHook("claude", "model-router.js", spawnInput(unrouted, "code-reviewer"), home));
  assert.match(unroutedNote, /no harnesses route in the profile, so this spawn runs here \(claude\)/);
  // The point of the note: it authorizes ONE spawn and forbids generalizing.
  assert.match(unroutedNote, /applies to this spawn call only/);
  assert.match(unroutedNote, /re-read on every spawn/);
  assert.match(unroutedNote, /do not open repo-profile\.json/);

  assert.match(
    note(runHook("claude", "model-router.js", spawnInput(local, "code-reviewer"), home)),
    /routes it to claude \(byAgent\), this harness/,
  );

  const invalid = note(runHook("claude", "model-router.js", spawnInput(bogus, "code-reviewer"), home));
  assert.match(invalid, /"local", which is not a harness name/);
  assert.match(invalid, /Tell the user to fix the profile/);
});

test("phase complexity picks the route, and an unroutable agent is never routed away", (t) => {
  const home = makeStateHome(t);
  const repo = makeRepo(t, {
    harnesses: {
      byAgent: { implementer: "claude" },
      byPhaseComplexity: { implementer: { low: "claude", high: "codex" } },
    },
  });
  registerListener(home, "codex", repo);

  const phaseFile = path.join(repo.sessionDir, "ultracode-phase-1.md");
  fs.writeFileSync(phaseFile, "# Phase 1\n\n**Complexity:** high\n", "utf-8");
  const highInput = spawnInput(repo, "implementer");
  highInput.tool_input.prompt += `\nPhase file: ${phaseFile}\nPhase: 1`;
  const denied = payload(runHook("claude", "model-router.js", highInput, home));
  assert.match(reason(denied), /routes implementer to codex \(harnesses.byPhaseComplexity\)/);

  fs.writeFileSync(phaseFile, "# Phase 1\n\n**Complexity:** low\n", "utf-8");
  assert.match(
    note(runHook("claude", "model-router.js", highInput, home)),
    /routes it to claude \(byPhaseComplexity\), this harness/,
  );

  // initializer belongs to /init-kit, outside the hub's task flow; a byAgent
  // route for it is ignored, not obeyed.
  const local = makeRepo(t, { harnesses: { byAgent: { initializer: "codex" } } });
  registerListener(home, "codex", local);
  const unroutable = runHook("claude", "model-router.js", spawnInput(local, "initializer"), home);
  assert.equal(note(unroutable), "", "no routing note for an unroutable agent");
  assert.notEqual(payload(unroutable).hookSpecificOutput.permissionDecision, "deny");
});

test("a hub-listen worker runs its claimed task without re-checking the route", (t) => {
  const home = makeStateHome(t);
  const repo = makeRepo(t, { harnesses: { byAgent: { "code-reviewer": "codex" } } });
  registerListener(home, "codex", repo);

  // Same spawn an orchestrate session would be denied for.
  markPipelineSession(home, "claude", repo.sessionId, "hub-listen");
  const worker = runHook("claude", "model-router.js", spawnInput(repo, "code-reviewer"), home);
  assert.notEqual(payload(worker).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(note(worker), "", "the claim already settled the harness; no note to give");

  markPipelineSession(home, "claude", repo.sessionId, "orchestrate");
  assert.match(
    reason(payload(runHook("claude", "model-router.js", spawnInput(repo, "code-reviewer"), home))),
    /routes code-reviewer to codex/,
  );
});

test("antigravity gets the enforcement without a note it cannot deliver", (t) => {
  const home = makeStateHome(t);
  const repo = makeRepo(t, { harnesses: { byAgent: { "code-reviewer": "codex" } } });
  registerListener(home, "codex", repo);

  const denied = payload(runHook("antigravity", "model-router.js", spawnInput(repo, "code-reviewer"), home));
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /routes code-reviewer to codex/);

  // AGY's PreToolUse output has no additionalContext field, and an unknown key
  // makes protojson discard the whole response — so the note is dropped, never
  // sent under another name.
  const allowed = runHook("antigravity", "model-router.js", spawnInput(makeRepo(t, {}), "code-reviewer"), home);
  assert.ok(!allowed.includes("additionalContext"), allowed);
  const parsed = payload(allowed);
  if (parsed) assert.equal(parsed.decision, "allow");
});

// ---- repo-profile.json is not the session's to read -----------------------

function markPipelineSession(stateHome, target, sessionId, command = "orchestrate") {
  const previous = process.env.ULTRACODE_HUB_HOME;
  process.env.ULTRACODE_HUB_HOME = stateHome;
  try {
    const { recordPipelineSession } = require(path.join(ROOT, "hooks", "lib", "pipeline-session.js"));
    assert.equal(recordPipelineSession(target, sessionId, command), true);
  } finally {
    if (previous === undefined) delete process.env.ULTRACODE_HUB_HOME;
    else process.env.ULTRACODE_HUB_HOME = previous;
  }
}

function readInput(repo, file, extra = {}) {
  return {
    session_id: repo.sessionId,
    cwd: repo.repoRoot,
    tool_input: { file_path: path.join(repo.runtimeDir, file) },
    ...extra,
  };
}

function shellInput(repo, command, extra = {}) {
  return {
    session_id: repo.sessionId,
    cwd: repo.repoRoot,
    tool_input: { command },
    ...extra,
  };
}

test("a pipeline session cannot read repo-profile.json, by tool or by shell", (t) => {
  const home = makeStateHome(t);
  const repo = makeRepo(t, {});
  markPipelineSession(home, "claude", repo.sessionId);
  const guard = (input) => payload(runHook("claude", "profile-read-guard.js", input, home));

  const denied = guard(readInput(repo, "repo-profile.json"));
  assert.match(reason(denied), /refusing this call because it names repo-profile\.json/);
  assert.match(reason(denied), /INVENTORY\.md/);

  // The inventory is the file it is supposed to read.
  assert.equal(guard(readInput(repo, "INVENTORY.md")), null);

  // The shell rule is the path, not a list of readers: every one of these
  // reaches the same bytes, and an allowlist of commands would miss most.
  const profilePath = path.join(repo.runtimeDir, "repo-profile.json");
  for (const command of [
    `cat ${profilePath}`,
    `bat --plain ${profilePath}`,
    `xxd ${profilePath} | head`,
    `jq '.harnesses' ${profilePath}`,
    `grep -n harnesses ${profilePath}`,
    `grep -e harnesses ${profilePath}`,
    `head -40 < ${profilePath}`,
    `perl -pe 's/a/b/' ${profilePath}`,
    `git show HEAD:${path.relative(repo.repoRoot, profilePath)}`,
    `git diff -- ${profilePath}`,
    `awk '{print}' ${profilePath}`,
    `sed -n '1,5p' ${profilePath}`,
    `echo "$(cat ${profilePath})"`,
    `cp ${profilePath} /tmp/copy.json && cat /tmp/copy.json`,
    `cd ${repo.runtimeDir} && cat repo-profile.json`,
    `cd ${repo.runtimeDir} && grep harnesses repo-profile.json`,
    `bash <<'EOF'\ncat ${profilePath}\nEOF`,
    // A write is refused too: Write and Edit already need a read the session
    // cannot make, so the shell is not a way around that.
    `jq '.a = 1' input.json > ${profilePath}`,
    `cp /tmp/new.json ${profilePath}`,
  ]) {
    assert.match(reason(guard(shellInput(repo, command))), /refusing this call/, command);
  }

  // The other harnesses' payload shapes reach the same decision: grok sends
  // camelCase keys and its own read tool's path field, AGY nests the args.
  markPipelineSession(home, "grok", repo.sessionId);
  const grokDenied = payload(
    runHook("grok", "profile-read-guard.js", {
      sessionId: repo.sessionId,
      cwd: repo.repoRoot,
      toolInput: { TargetFile: profilePath },
    }, home),
  );
  assert.equal(grokDenied.decision, "deny");
  assert.match(grokDenied.reason, /refusing this call/);

  markPipelineSession(home, "antigravity", repo.sessionId);
  const agyDenied = payload(
    runHook("antigravity", "profile-read-guard.js", {
      conversationId: repo.sessionId,
      cwd: repo.repoRoot,
      toolCall: { name: "view_file", args: { AbsolutePath: profilePath } },
    }, home),
  );
  assert.equal(agyDenied.decision, "deny");
  assert.match(agyDenied.reason, /refusing this call/);

  // The one carve-out: the file name as a search PATTERN names no file to read.
  for (const command of [
    `grep -rn repo-profile.json ${ROOT}/hooks`,
    `rg repo-profile.json`,
    `grep -rn ".ultracode/repo-profile.json" ${ROOT}/docs`,
    `cat ${path.join(repo.runtimeDir, "INVENTORY.md")}`,
    "ls .ultracode",
  ]) {
    assert.equal(guard(shellInput(repo, command)), null, command);
  }
});

test("the profile stays readable for subagents and for ordinary sessions", (t) => {
  const home = makeStateHome(t);
  const repo = makeRepo(t, {});
  const guard = (input) => payload(runHook("claude", "profile-read-guard.js", input, home));

  // No marker: this session never loaded orchestrate or hub-listen.
  assert.equal(guard(readInput(repo, "repo-profile.json")), null);

  // Marked, but the caller is a subagent whose brief may be missing a table.
  markPipelineSession(home, "claude", repo.sessionId);
  assert.equal(
    guard(readInput(repo, "repo-profile.json", { agent_type: "ultracode:plan" })),
    null,
  );
});

test("loading orchestrate or hub-listen is what marks the session", (t) => {
  const home = makeStateHome(t);
  const repo = makeRepo(t, {});
  const { isPipelineSession } = require(path.join(ROOT, "hooks", "lib", "pipeline-session.js"));
  const check = (sessionId) => {
    const previous = process.env.ULTRACODE_HUB_HOME;
    process.env.ULTRACODE_HUB_HOME = home;
    try {
      return isPipelineSession("claude", sessionId);
    } finally {
      if (previous === undefined) delete process.env.ULTRACODE_HUB_HOME;
      else process.env.ULTRACODE_HUB_HOME = previous;
    }
  };

  for (const commandName of ["ultracode:orchestrate", "/ultracode:orchestrate"]) {
    const sessionId = `expansion-${commandName.replace(/\W/g, "")}`;
    runHook("claude", "skill-init-guard.js", {
      session_id: sessionId,
      cwd: repo.repoRoot,
      hook_event_name: "UserPromptExpansion",
      expansion_type: "slash_command",
      command_name: commandName,
    }, home);
    assert.equal(check(sessionId), true, commandName);
  }

  runHook("claude", "skill-init-guard.js", {
    session_id: "skill-tool",
    cwd: repo.repoRoot,
    tool_input: { skill: "ultracode:hub-listen" },
  }, home);
  assert.equal(check("skill-tool"), true);

  // Another skill leaves the session unmarked.
  runHook("claude", "skill-init-guard.js", {
    session_id: "other-skill",
    cwd: repo.repoRoot,
    tool_input: { skill: "ultracode:init-kit" },
  }, home);
  assert.equal(check("other-skill"), false);
});
