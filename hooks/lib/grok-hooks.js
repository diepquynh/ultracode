"use strict";

// Grok Build hook policy, in one place. Everything here follows from four
// facts of grok-build's hook engine (source-verified 2026-08-30 against
// xai-org/grok-build@main; details in docs/harness-limitations.md):
//
//   1. Deny/ask reasons are clipped to 256 characters (MAX_REASON_CHARS,
//      crates/codegen/xai-grok-hooks/src/event.rs `clip_reason`). Grok clips
//      blindly from the front, so a long ultracode denial would keep the
//      preamble and lose the "do this instead" tail — the part the model
//      needs to self-correct. `fitGrokReason` re-clips on our side first,
//      keeping the head AND the final sentence.
//
//   2. Hook payloads are capped at 128 KiB (MAX_PAYLOAD_SIZE, event.rs
//      `truncate_payload`): past the cap the whole `toolInput` value is
//      replaced by a truncated STRING and `toolInputTruncated: true` is set.
//      Our adapters then see no spawn entries at all and every PreToolUse
//      guard silently allows. `truncatedSpawnDenial` turns that fail-open
//      into an explicit refusal on spawn calls.
//
//   3. Observe-kind events (SessionStart, PostToolUse, PreCompact,
//      PostCompact, ...) never read hook stdout beyond a user-facing
//      `systemMessage` toast (runner/command.rs `GateKind::Observe`), so a
//      hook cannot inject model context from them. SessionStart's `source`
//      is also only ever "new"/"load" (agent_ops.rs), never "compact". The
//      post-compaction pipeline checkpoint therefore rides the one channel
//      grok does read — PreToolUse `additionalContext` on an allow — via the
//      compaction marker below: PreCompact records the marker, and the first
//      PreToolUse afterwards consumes it and emits the checkpoint.
//
//   4. The spawn tool's result is usually a launch ack (`run_in_background`
//      defaults to true in TaskToolInput, and foreground spawns
//      auto-background when the wait budget expires), so a PostToolUse
//      recorder rarely sees a child's final message. The fact-check verdict
//      is recorded by the verdict author instead, through the
//      ultracode_factcheck MCP tool — same solution as codex, see
//      mcp/sealed-channel-tools.js and the {{#codex,grok}} block in
//      agents/fact-check/prompt.md.
//
// This module is required by hooks/lib/common.js (fitGrokReason), so it must
// not require common.js at module scope — the marker store lazy-requires it
// inside the functions instead (same no-cycle discipline as codex-spawn.js).

const fs = require("node:fs");
const path = require("node:path");

// Grok's clip_reason cap. A reason at or under this survives verbatim.
const GROK_REASON_MAX = 256;

// Refit a denial/ask reason to grok's 256-char cap, preserving the final
// sentence — ultracode denials end with the corrective instruction, which
// grok's own front-anchored truncation would drop. The head keeps priority:
// it carries the claim (what was refused and why), and a refit that traded
// the claim for a long instruction would leave the model with an order it
// cannot connect to its own call. When the final sentence would squeeze the
// head below MIN_HEAD, fall back to a plain head clip — same outcome grok
// itself would produce, minus its "[+N chars]" suffix.
const MIN_HEAD = 120;

function fitGrokReason(reason) {
  if (typeof reason !== "string" || reason.length <= GROK_REASON_MAX) return reason;
  const flat = reason.replace(/\s+/g, " ").trim();
  if (flat.length <= GROK_REASON_MAX) return flat;
  const sentences = flat.match(/[^.!?]+[.!?]*/g) || [flat];
  const tail = sentences[sentences.length - 1].trim();
  const joiner = " … ";
  const headBudget = GROK_REASON_MAX - tail.length - joiner.length;
  if (headBudget < MIN_HEAD) return flat.slice(0, GROK_REASON_MAX);
  return `${flat.slice(0, headBudget).trimEnd()}${joiner}${tail}`;
}

// Denial for a spawn call whose tool input grok truncated away (fact 2).
// Returns "" when the payload is intact. Any harness that ever sets the
// flag gets the same treatment; today only grok sends it.
function truncatedSpawnDenial(hookInput) {
  if (!hookInput || typeof hookInput !== "object") return "";
  const truncated =
    hookInput.toolInputTruncated === true || hookInput.tool_input_truncated === true;
  if (!truncated) return "";
  return (
    "ultracode: this spawn's tool input exceeded the harness's 128 KiB hook payload cap, " +
    "so its parameter contract cannot be inspected. Shrink the spawn prompt — reference " +
    "files by path instead of inlining their content — and re-spawn."
  );
}

function markerPath(target, sessionId) {
  const { machineStateRoot, sanitizeSessionId } = require("./common");
  return path.join(
    machineStateRoot(),
    "compaction-markers",
    `${target}:${sanitizeSessionId(sessionId)}.json`,
  );
}

// PreCompact side of fact 3: remember that this session is about to lose its
// working memory. Lives in machine state (model-write-guarded), like
// spawn tickets.
function recordCompaction(target, sessionId) {
  const file = markerPath(target, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ts: new Date().toISOString() }), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// PreToolUse side of fact 3: true exactly once per recorded compaction — the
// caller then emits the pipeline checkpoint as PreToolUse additionalContext.
function consumeCompactionMarker(target, sessionId) {
  const file = markerPath(target, sessionId);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  GROK_REASON_MAX,
  fitGrokReason,
  truncatedSpawnDenial,
  recordCompaction,
  consumeCompactionMarker,
};
