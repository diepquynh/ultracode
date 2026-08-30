"use strict";

// Harness-route resolution for ultracode_task_publish: the hub reads the
// repo's profile itself, AT PUBLISH TIME, instead of trusting a route the
// orchestrator resolved earlier in its turn — the same freshness rule
// hooks/model-router.js applies to model routes (re-read on every spawn), for
// the same reason: the user may edit repo-profile.json mid-session, and the
// edit must win over whatever the model remembers.
//
// Contract mirrors refs/inventory-and-profile.md `harnesses`:
//   * values are concrete harness names only — anything else is reported as
//     invalid and otherwise treated as absent (absence can never fail a task);
//   * byPhaseComplexity (keyed by the phase file's **Complexity:** line,
//     default "low" — an inline no-plan task counts as low) wins over byAgent.

const fs = require("node:fs");
const path = require("node:path");

const ROUTABLE_HARNESSES = ["claude", "codex", "grok", "antigravity"];
const RUNTIME_DIR = ".ultracode";

function readJsonIfFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// The same phase-complexity convention hooks/model-router.js reads: a
// "**Complexity:** low|medium|high" line in the plan phase file. Missing file,
// unreadable file, or no line all mean "low".
function phaseComplexity(phaseFile) {
  if (typeof phaseFile !== "string" || !phaseFile.trim()) return "low";
  try {
    const text = fs.readFileSync(path.resolve(phaseFile.trim()), "utf-8");
    const match = text.match(/\*\*Complexity:\*\*\s*(low|medium|high)\b/i);
    return match ? match[1].toLowerCase() : "low";
  } catch {
    return "low";
  }
}

// → { route: harness|null, source: "byPhaseComplexity"|"byAgent"|null,
//     invalid?: string }  — `invalid` carries a route value that was present
// but not a concrete harness name, so the caller can surface it to the user
// while still degrading to "no route".
function resolveHarnessRoute({ repoRoot, agentHint, phaseFile }) {
  if (typeof repoRoot !== "string" || !repoRoot.trim()) return { route: null, source: null };
  const profile = readJsonIfFile(path.join(path.resolve(repoRoot.trim()), RUNTIME_DIR, "repo-profile.json"));
  const section = profile && profile.harnesses;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { route: null, source: null };
  }
  const hint = typeof agentHint === "string" ? agentHint.trim() : "";
  if (!hint) return { route: null, source: null };

  let route;
  let source = null;
  const byPhase = section.byPhaseComplexity && section.byPhaseComplexity[hint];
  if (byPhase && typeof byPhase === "object" && !Array.isArray(byPhase)) {
    route = byPhase[phaseComplexity(phaseFile)];
    source = "byPhaseComplexity";
  }
  if (route === undefined && section.byAgent && typeof section.byAgent === "object") {
    route = section.byAgent[hint];
    source = "byAgent";
  }
  if (route === undefined || route === null) return { route: null, source: null };
  if (typeof route !== "string" || !ROUTABLE_HARNESSES.includes(route)) {
    return { route: null, source: null, invalid: String(route) };
  }
  return { route, source };
}

module.exports = { resolveHarnessRoute, phaseComplexity, ROUTABLE_HARNESSES };
