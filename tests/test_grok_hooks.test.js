"use strict";
// Grok Build hook policy (hooks/lib/grok-hooks.js): these tests pin the four
// source-verified grok facts — the 256-char reason clip (refit keeps the
// corrective tail), the 128 KiB payload truncation (session-guard refuses an
// uninspectable spawn), the missing model channel on Observe events (the
// post-compaction checkpoint rides a PreCompact marker + PreToolUse
// additionalContext), and the ask decision (asserted in test_definitions'
// reviewCapTest). Source citations live in docs/harness-limitations.md.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const GENERATOR = path.join(ROOT, "scripts", "generate_definitions.js");
const {
  GROK_REASON_MAX,
  fitGrokReason,
  truncatedSpawnDenial,
  recordCompaction,
  consumeCompactionMarker,
} = require("../hooks/lib/grok-hooks");

let WORKSPACE;
let GROK_ROOT;

before(() => {
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-grok-"));
  GROK_ROOT = path.join(WORKSPACE, "grok");
  execFileSync("node", [GENERATOR, "--target", "grok", "--output-dir", GROK_ROOT], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
});

after(() => {
  if (WORKSPACE) fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

function runHook(hookPath, input, env = {}) {
  return execFileSync("node", [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

test("fitGrokReason keeps short reasons verbatim and refits long ones around the final sentence", () => {
  assert.equal(fitGrokReason("short and sweet."), "short and sweet.");
  assert.equal(fitGrokReason(null), null);

  const head = "ultracode: refusing ultracode:implement because its required parameter contract is incomplete: missing Repo root, missing Session dir, missing Repo key, missing Task, and several other labels this harness would otherwise truncate away entirely.";
  const tail = "Add the named `Label: value` lines and re-spawn.";
  const fitted = fitGrokReason(`${head} Every Ultracode spawn is self-contained. ${tail}`);
  assert.ok(fitted.length <= GROK_REASON_MAX, `fitted length ${fitted.length}`);
  assert.ok(fitted.startsWith("ultracode: refusing"), "head survives");
  assert.ok(fitted.endsWith(tail), "the corrective final sentence survives");
});

test("truncatedSpawnDenial fires only on the truncation flag", () => {
  assert.equal(truncatedSpawnDenial({ toolInput: { prompt: "x" } }), "");
  assert.equal(truncatedSpawnDenial(null), "");
  const denial = truncatedSpawnDenial({ toolInputTruncated: true, toolInput: "gigantic [truncated]" });
  assert.match(denial, /128 KiB/);
  assert.ok(denial.length <= GROK_REASON_MAX, "the denial itself must fit grok's clip");
  assert.match(truncatedSpawnDenial({ tool_input_truncated: true }), /cannot be inspected/);
});

test("compaction markers are single-use per (target, session)", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-grok-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prev = process.env.ULTRACODE_HUB_HOME;
  process.env.ULTRACODE_HUB_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.ULTRACODE_HUB_HOME;
    else process.env.ULTRACODE_HUB_HOME = prev;
  });

  assert.equal(consumeCompactionMarker("grok", "sess-a"), false, "nothing recorded yet");
  assert.equal(recordCompaction("grok", "sess-a"), true);
  assert.equal(consumeCompactionMarker("grok", "sess-b"), false, "other session unaffected");
  assert.equal(consumeCompactionMarker("grok", "sess-a"), true, "consumed once");
  assert.equal(consumeCompactionMarker("grok", "sess-a"), false, "single-use");
});

test("session-guard refuses a spawn whose tool input grok truncated away", () => {
  const output = runHook(
    path.join(GROK_ROOT, "hooks", "session-guard.js"),
    {
      cwd: WORKSPACE,
      session_id: "testsess",
      hook_event_name: "pre_tool_use",
      toolName: "spawn_subagent",
      toolInputTruncated: true,
      tool_input_truncated: true,
      toolInput: "…enormous serialized input… [truncated]",
    },
    { PLUGIN_ROOT: GROK_ROOT },
  );
  const payload = JSON.parse(output);
  assert.equal(payload.decision, "deny");
  assert.match(payload.reason, /128 KiB/);
  assert.ok(payload.reason.length <= GROK_REASON_MAX);
});

// The post-compaction checkpoint on grok: PreCompact records a marker (grok
// reads no Observe stdout), and the first PreToolUse afterwards consumes it
// and emits the checkpoint as additionalContext — exactly once.
test("grok checkpoint rides PreCompact marker + PreToolUse additionalContext", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-grok-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-grok-repo-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const sessionDir = path.join(repo, ".ultracode", "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "progress.json"),
    JSON.stringify({
      records: [
        { ts: "2026-08-30T00:00:00Z", agent: "implement", phase: "phase-1", status: "ok", summary: "landed phase 1" },
      ],
    }),
  );

  const env = { PLUGIN_ROOT: GROK_ROOT, ULTRACODE_HUB_HOME: home };
  const hook = path.join(GROK_ROOT, "hooks", "session-resume.js");
  const base = { cwd: repo, session_id: "testsess", sessionId: "testsess" };

  // PreCompact: marker only, no stdout (grok would ignore it anyway).
  const preCompactOut = runHook(hook, { ...base, hook_event_name: "pre_compact", source: "auto" }, env);
  assert.equal(preCompactOut, "");
  const markers = fs.readdirSync(path.join(home, "compaction-markers"));
  assert.equal(markers.length, 1);
  assert.match(markers[0], /^grok:testsess\.json$/);

  // First PreToolUse after compaction: checkpoint injected via the one
  // channel grok reads back to the model.
  const preToolPayload = {
    ...base,
    hook_event_name: "pre_tool_use",
    toolName: "read_file",
    toolInput: { file_path: "README.md" },
    toolInputTruncated: false,
  };
  const injected = JSON.parse(runHook(hook, preToolPayload, env));
  assert.equal(injected.hookSpecificOutput.permissionDecision, "allow");
  assert.match(injected.hookSpecificOutput.additionalContext, /resuming after compaction/);
  assert.match(injected.hookSpecificOutput.additionalContext, /implement phase-1 \[ok\]/);

  // Second PreToolUse: marker consumed, hook silent.
  assert.equal(runHook(hook, preToolPayload, env), "");

  // SessionStart on grok has no model channel: never any stdout.
  assert.equal(runHook(hook, { ...base, hook_event_name: "session_start", source: "load" }, env), "");
});
