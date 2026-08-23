#!/usr/bin/env node
// Shared write policy for ultracode's pipeline *ledgers* — the state files the
// pipeline reads back to make decisions. Distinct from scope-policy.js, which
// answers "may this agent write in this directory at all"; this answers "may
// this writer touch this specific ledger, wherever it lives".
//
// The threat this closes is a writer forging pipeline state rather than earning
// it. factcheck.json is the sharp case: mcp/gate-server.js refuses to record an
// "approved" spec/plan decision unless that file already carries a fact-check
// PASS, so anyone able to write the file can approve their own spec in one call.
// Before this policy, artifact-guard.js protected only spec/plan filenames and
// bash-scope-guard.js ignored the orchestrator entirely, so both a Write and a
// shell redirect could forge it.
//
// Three ownership classes:
//   * hook-owned  — written ONLY by ultracode's own PostToolUse hooks
//                   (factcheck-record.js, spawn-log.js, build-streak.js). No
//                   model-issued write is ever legitimate, from any agent or
//                   from the orchestrator.
//   * tool-owned  — written ONLY by the bundled MCP server (mcp/gate-server.js)
//                   as the record of a call it accepted. Same rule as hook-owned:
//                   a hand-authored copy is a decision that was never made.
//   * agent-owned — written by the agent(s) whose prompt.md documents the file
//                   as their output. Everyone else, orchestrator included, is
//                   denied so pipeline state can only be authored by the role
//                   that actually did the work.

"use strict";

const path = require("node:path");

const HOOK_OWNED = [
  {
    pattern: /^factcheck\.json$/,
    writer: "hooks/factcheck-record.js, from ultracode:fact-check's own returned verdict",
    stakes:
      "mcp/gate-server.js reads it to decide whether a spec/plan approval may be recorded at all",
  },
  {
    pattern: /^progress\.json$/,
    writer: "hooks/spawn-log.js, from each completed spawn",
    stakes: "it is the post-compaction record of which spawns actually ran",
  },
  {
    pattern: /^build-streak\.json$/,
    writer: "hooks/build-streak.js, from real build/test exit results",
    stakes:
      "hooks/build-streak-gate.js reads it to decide when a subagent must stop retrying and escalate",
  },
  {
    pattern: /^spawn-scope\.json$/,
    writer: "hooks/spawn-scope.js, from the phase file each spawn declares",
    stakes:
      "scope-guard.js and bash-scope-guard.js read it for work-repo identity; the phase path list is a hint, not a write allowlist",
  },
];

// Written by mcp/gate-server.js itself, in-process, so denying every tool-issued
// write costs the pipeline nothing. gates.json is the file hooks/pipeline-gate.js
// reads to decide whether ultracode:plan or a phase-driven ultracode:implement
// may be spawned at all — hand-writing it approves your own spec or plan and
// skips the fact-check requirement mcp/lib/gate.js enforces on the real call.
const TOOL_OWNED = [
  {
    pattern: /^gates\.json$/,
    writer: "the ultracode_gate MCP tool (mcp/gate-server.js), from a decision it accepted",
    stakes:
      "hooks/pipeline-gate.js reads it to decide whether ultracode:plan and a phase-driven " +
      "ultracode:implement may be spawned, and the tool records an approval only once " +
      "ultracode:fact-check has returned PASS",
  },
  {
    pattern: /^knowledge\.sqlite3(-wal|-shm|-journal)?$/,
    writer: "the ultracode_memory MCP tools (mcp/lib/memory.js)",
    stakes:
      "it is the repo's durable lesson store that later sessions recall as fact, and gate-server.js " +
      "documents it as never hand-edited",
  },
];

const AGENT_OWNED = [
  {
    pattern: /^ultracode-review-ledger(-[\w.-]+)?\.md$/,
    owners: ["code-reviewer", "implement", "write-test"],
    stakes: "hooks/review-cap.js counts its iterations to cap the review loop",
  },
  {
    pattern: /^ultracode-security-block\.json$/,
    owners: ["code-reviewer"],
    stakes:
      "it records unwaivable BLOCKER findings, and review-cap.js honors it to keep a blocked review alive",
  },
  {
    pattern: /^ultracode-implement-progress(-[\w.-]+)?\.md$/,
    owners: ["implement"],
    stakes: "re-spawns read it to learn which steps already succeeded",
  },
];

// `agent` is the bare agent name (no "ultracode:" prefix) when the write happens
// inside a subagent's turn, or "" for the orchestrator's own turn.
// `targetPath` may be absolute or relative — only the basename is matched, so a
// ledger is protected wherever it sits.
// Returns { allowed: true } or { allowed: false, reason }.
function checkLedger(agent, targetPath) {
  const base = path.basename(String(targetPath || "").replace(/\\/g, "/"));
  if (!base) return { allowed: true };

  for (const entry of [...HOOK_OWNED, ...TOOL_OWNED]) {
    if (!entry.pattern.test(base)) continue;
    return {
      allowed: false,
      reason:
        `"${base}" is pipeline state owned by ${entry.writer} — never written by hand. ` +
        `${entry.stakes}, so a hand-authored value would forge a pipeline decision ` +
        "rather than record one. Let the hook record it: do the underlying work and the " +
        "file updates itself.",
    };
  }

  for (const entry of AGENT_OWNED) {
    if (!entry.pattern.test(base)) continue;
    if (agent && entry.owners.includes(agent)) return { allowed: true };
    const owners = entry.owners.map((o) => `ultracode:${o}`).join(", ");
    return {
      allowed: false,
      reason:
        `"${base}" is owned by ${owners}` +
        (agent ? `, not ultracode:${agent}` : ", not the orchestrator") +
        `. ${entry.stakes}, so only the role that did the work may write it. ` +
        "Re-spawn the owning agent with the change instead of editing its ledger.",
    };
  }

  return { allowed: true };
}

// The review ledger a spawn's review loop belongs to, from its `Phase:` value.
// The cap in hooks/review-cap.js is per review loop, and a session runs one loop
// per phase's implementation plus one per phase's requested tests, so each gets
// its own ledger — a shared file would count phase 1's iterations against phase
// 2's first review, and a phase's implementation passes against its test passes.
// A review not tied to a plan phase ("none") keeps the unsuffixed name.
function reviewLedgerName(phase) {
  const value = String(phase || "").trim().toLowerCase();
  return /^\d+(-tests)?$/.test(value)
    ? `ultracode-review-ledger-phase-${value}.md`
    : "ultracode-review-ledger.md";
}

// Matches every review ledger name reviewLedgerName can produce, for callers
// enumerating a session dir rather than resolving one spawn's ledger.
const REVIEW_LEDGER_PATTERN = /^ultracode-review-ledger(?:-phase-(\d+(?:-tests)?))?\.md$/;

// One regex matching every protected ledger name, for callers that must scan
// free text rather than a path — hooks/lib/plugin-policy.js looks for a ledger
// named inside an interpreter's inline code, where there is no path argument to
// check. Built from the same entries above so a ledger added there is covered
// here without a second list to keep in step.
function ledgerNamePattern() {
  const sources = [...HOOK_OWNED, ...TOOL_OWNED, ...AGENT_OWNED].map((entry) =>
    entry.pattern.source.replace(/^\^/, "").replace(/\$$/, ""),
  );
  return new RegExp(`(?:${sources.join("|")})`, "i");
}

module.exports = {
  checkLedger,
  ledgerNamePattern,
  reviewLedgerName,
  REVIEW_LEDGER_PATTERN,
  HOOK_OWNED,
  TOOL_OWNED,
  AGENT_OWNED,
};
