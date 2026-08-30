#!/usr/bin/env node
// SessionStart(compact) checkpoint reminder: after a context compaction the
// orchestrator's own memory of "where was I in the pipeline" is exactly what
// just got summarized away. This prints the last recorded spawn(s) and the
// current review-loop iteration count so the orchestrator can resume instead
// of re-deriving (or losing) pipeline state from a compacted summary.
//
// On Grok Build the same checkpoint takes a detour (lib/grok-hooks.js, fact
// 3): grok never reads an Observe hook's stdout and its SessionStart source
// is never "compact", so this file is registered there on PreCompact (record
// a compaction marker) and on PreToolUse matcher "*" (consume the marker once
// and emit the checkpoint as additionalContext — the one channel grok feeds
// back to the model).
//
// Never fails the session: this hook only provides context.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { emit, pick, readHookInput, readTextIfFile, readJsonIfFile } = require("./lib/common");
const { recordCompaction, consumeCompactionMarker } = require("./lib/grok-hooks");
const { HookContext } = require("./lib/hook-context");
const { REVIEW_LEDGER_PATTERN } = require("./lib/ledger-policy");

function formatRecord(record) {
  const phase = record.phase ? ` ${record.phase}` : "";
  const summary = record.summary ? ` — ${record.summary}` : "";
  return `${record.agent}${phase} [${record.status}]${summary}`;
}

// Called for the session dir and for each repo-key subdirectory of it, and reads
// every ledger in whichever it is handed: gates.json is session-level, while
// factcheck.json, progress.json and the review ledger are per repo key. Printing
// whatever is present in each place keeps this readable against a session from
// either layout rather than going silent on the other one.
// Review loops are per phase — one for its implementation, one for its tests — so
// a session dir holds a ledger per loop. Report each separately: the cap is counted
// per ledger, and a merged count would misstate where any of them stands against it.
function reviewLines(sessionDir, label) {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return [];
  }
  const lines = [];
  for (const entry of entries.sort()) {
    const match = REVIEW_LEDGER_PATTERN.exec(entry);
    if (!match) continue;
    const ledger = readTextIfFile(path.join(sessionDir, entry));
    if (!ledger) continue;
    const iterations = (ledger.match(/^## Iteration \d+/gm) || []).length;
    const scope = match[1] ? `phase ${match[1]} ` : "";
    lines.push(`  ${label}${scope}review iterations so far: ${iterations}/3`);
  }
  return lines;
}

function reportFor(sessionDir, label) {
  const lines = [];
  const progress = readJsonIfFile(path.join(sessionDir, "progress.json"));
  const records = progress && Array.isArray(progress.records) ? progress.records : [];
  if (records.length) lines.push(`  ${label}last spawn: ${formatRecord(records[records.length - 1])}`);
  lines.push(...reviewLines(sessionDir, label));
  const gates = readJsonIfFile(path.join(sessionDir, "gates.json"));
  for (const gate of ["spec", "plan"]) {
    if (gates && gates[gate]) lines.push(`  ${label}${gate} gate: ${gates[gate].decision}`);
  }
  const factcheck = readJsonIfFile(path.join(sessionDir, "factcheck.json"));
  for (const target of ["spec", "plan"]) {
    if (factcheck && factcheck[target]) {
      lines.push(`  ${label}${target} fact-check: ${factcheck[target].verdict} (round ${factcheck[target].rounds})`);
    }
  }
  return lines;
}

function checkpointLines(context) {
  const baseDir = context.sessionRoot;
  if (!baseDir) return [];
  const found = [...reportFor(baseDir, "")];
  let repoKeys = [];
  try {
    repoKeys = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    repoKeys = [];
  }
  for (const key of repoKeys) {
    found.push(...reportFor(path.join(baseDir, key), `${key}: `));
  }
  return found;
}

function checkpointText(context) {
  const found = checkpointLines(context);
  if (!found.length) return "";
  return [
    "ultracode :: resuming after compaction — pipeline checkpoint:",
    ...found,
    "Resume from here; do not redo work these records show as finished.",
  ].join("\n");
}

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;

  const context = new HookContext(hookInput);
  const eventName = String(pick(hookInput, "hook_event_name", "hookEventName") || "");

  if (context.target === "grok") {
    if (/^pre_?compact$/i.test(eventName)) {
      recordCompaction(context.target, context.sessionId);
      return 0;
    }
    if (/^pre_?tool_?use$/i.test(eventName)) {
      if (!consumeCompactionMarker(context.target, context.sessionId)) return 0;
      const text = checkpointText(context);
      if (text) {
        emit({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            additionalContext: text,
          },
        });
      }
      return 0;
    }
    // Any other grok event has no model-visible channel for this text.
    return 0;
  }

  const text = checkpointText(context);
  if (text) console.log(text);
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
