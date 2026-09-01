#!/usr/bin/env node
// Enforce the review-loop cap for every code-reviewer spawn in a tool call.
//
// The cap stops the loop from spinning on its own budget; it is not a safety
// rule, and a 4th pass is sometimes exactly what the work needs. So the spawn
// past the cap is put to the user rather than refused: the hook asks, and the
// pass runs or does not by their answer. The reason doubles as the orchestrator's
// hint — on a rejection (and in headless runs, where nobody can be prompted) it
// comes back as the tool-call failure, so the loop stops with the cap named
// instead of stalling silently. See askPreToolUse in lib/common.js for what each
// harness does with it.
//
// YOLO mode changes the shape, not the existence, of the cap. An ask is the one
// thing an unattended run cannot survive — the question parks the session until
// morning — so when the user has switched this primary session into YOLO
// (hooks/lib/yolo-state.js, written only by the hub's ultracode_yolo_set tool),
// the loop instead gets a larger automatic budget, and past it the resolution
// moves UP, not on: each further pass is denied with the instruction that the
// ORCHESTRATOR must resolve the impasse itself — read the ledger, fix the open
// findings via targeted spawns — and then exactly one verification pass is
// allowed (tracked per loop in ultracode-yolo-review-escalations.json, keyed by
// the iteration count each denial saw). The loop can still converge to clean,
// but it can never spin blind, and open findings are never carried into a
// dependent phase — skipping ahead with a broken phase breaks everything built
// on it.
//
// Known gap: the ask does not work on Grok. It has no ask decision — both shapes
// fail open there, which would delete the cap rather than soften it — so Grok
// gets the denial below and its user cannot approve a 4th pass at the prompt at
// all; only the orchestrator can put that question to them.

"use strict";

const path = require("node:path");
const {
  askPreToolUse,
  denyPreToolUse,
  readHookInput,
  readJsonIfFile,
  readTextIfFile,
  writeJsonAtomic,
} = require("./lib/common");
const { HookContext } = require("./lib/hook-context");
const { reviewLedgerName } = require("./lib/ledger-policy");
const { isYoloEnabled } = require("./lib/yolo-state");

const MAX_ITERATIONS = 3;
// The YOLO budget: unattended loops may spend more automatic passes — the user
// traded oversight for progress — but past this point the reviewer and the fix
// agent are demonstrably not converging, so every further pass costs an
// orchestrator-resolution round first.
const YOLO_MAX_ITERATIONS = 10;
const YOLO_ESCALATIONS_FILE = "ultracode-yolo-review-escalations.json";

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);

  for (const spawn of context.spawns.filter((candidate) => candidate.agent === "code-reviewer")) {
    const sessionDir = spawn.effectiveSessionDir;
    if (!sessionDir) continue;
    // Per loop, not per session: the ledger this spawn appends to is the one its
    // `Phase:` names, so a later phase — or the same phase's test loop — starts
    // its own count instead of inheriting an exhausted one.
    const phase = String(spawn.parameters.phase || "").trim();
    const ledger = readTextIfFile(path.join(sessionDir, reviewLedgerName(phase)));
    if (!ledger) continue;
    const iterations = ledger.match(/^## Iteration \d+/gm) || [];
    const yolo = isYoloEnabled(sessionDir);
    if (iterations.length < (yolo ? YOLO_MAX_ITERATIONS : MAX_ITERATIONS)) continue;
    const block = readJsonIfFile(path.join(sessionDir, "ultracode-security-block.json"));
    if (block && block.blocked === true) continue;
    const scope = /^\d+(-tests)?$/i.test(phase) ? `phase ${phase} of repo key` : "repo key";
    if (yolo) {
      // One denial per iteration count: the denial that lands at N iterations
      // authorizes exactly one verification pass (the ledger only grows when a
      // review actually runs, so the next spawn at the same count is the
      // orchestrator's post-resolution verify). A pass after that sits at N+1
      // and is denied again — every extra pass costs a resolution round.
      const ledgerName = reviewLedgerName(phase);
      const escalationsPath = path.join(sessionDir, YOLO_ESCALATIONS_FILE);
      const escalations = readJsonIfFile(escalationsPath) || {};
      const deniedAt = Number.isInteger(escalations[ledgerName]) ? escalations[ledgerName] : 0;
      if (iterations.length <= deniedAt) continue;
      escalations[ledgerName] = iterations.length;
      writeJsonAtomic(escalationsPath, escalations);
      const cappedYolo =
        `ultracode: YOLO review budget exhausted (${iterations.length}/${YOLO_MAX_ITERATIONS}) for ${scope} ` +
        `"${spawn.repoKey}".`;
      denyPreToolUse(
        `${cappedYolo} The loop is not converging on its own, and YOLO mode means there is nobody to ask — ` +
          "so resolution is now YOURS, before any re-spawn: read this loop's review ledger, diagnose why " +
          "the open findings keep recurring, apply auto-fixable ones directly, and re-spawn the fix agent " +
          "with exact per-finding instructions and rescue context — not another generic pass. Then re-spawn " +
          "the reviewer ONCE to verify; that verification pass is allowed. Open findings are never carried " +
          "forward: do not start any phase or stage that depends on this one, and never mark a finding " +
          "resolved without the reviewer confirming. If your resolution rounds are not converging either, " +
          "treat the phase as blocked (Rule D9): record the findings and the ledger path in the completion " +
          "report and continue only work that does not depend on this phase.",
        `${cappedYolo} Resolve it yourself before re-spawning: read the ledger, fix the open findings via ` +
          "targeted fix-agent spawns, then ONE verify review (allowed). Never start dependent phases while " +
          "findings are open.",
      );
      return 0;
    }
    const capped =
      `ultracode: review loop cap reached (${iterations.length}/${MAX_ITERATIONS}) for ${scope} ` +
      `"${spawn.repoKey}".`;
    askPreToolUse(
      `${capped} Approve to spend one more pass on it, or reject to end the loop — rejecting means ` +
        "the findings still open get reported to you as they stand rather than fixed automatically.",
      `${capped} Do not start another automatic pass: report the findings still open to the user, ` +
        "and let them decide whether another review pass is worth it.",
    );
    return 0;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
