"use strict";

// Pure gate-decision logic for the ultracode_gate MCP tool, split out from
// mcp/gate-server.js so it's unit-testable without spinning up a real MCP
// stdio transport (mirrors mcp/lib/memory.js).
//
// Both files this touches are resolved from (session dir, repo key) rather than
// from the session dir alone:
//
//   * factcheck.json — {session-base}/{repo-key}/, exactly where
//     hooks/factcheck-record.js writes the verdict for that repo key. A spawn
//     scoped to `{SESSION_DIR}/{repo-key}` and a gate call passing `{SESSION_DIR}`
//     used to resolve two different paths, so a real PASS read back here as "none
//     recorded" and the pipeline deadlocked at the spec gate.
//   * gates.json — {session-base}/, because a spec/plan approval is one
//     session-level decision covering every repo in scope (one spec, one plan),
//     and hooks/pipeline-gate.js normalizes to the same base before reading it.

const path = require("node:path");
const { writeJsonAtomic, readJsonIfFile } = require("../../hooks/lib/common");
const { normalizeRepoKey, sessionBaseDir, repoStateDir } = require("../../hooks/lib/session");

function factCheckVerdict(sessionDir, repoKey, gate) {
  const stateDir = repoStateDir(sessionDir, repoKey);
  if (!stateDir) return null;
  const factcheck = readJsonIfFile(path.join(stateDir, "factcheck.json"));
  return (factcheck && factcheck[gate] && factcheck[gate].verdict) || null;
}

function recordGateDecision(sessionDir, repoKey, gate, decision, notes) {
  const key = normalizeRepoKey(repoKey);
  if (!key) {
    return {
      ok: false,
      message:
        `ultracode: refusing to record a ${gate} decision — repo_key is required and ` +
        `"${repoKey === undefined || repoKey === null ? "" : repoKey}" is not a repo key. ` +
        "Pass the same lowercase slug the pipeline used for this repo (the `Repo key:` line in its " +
        "spawn prompts, and the repo-key subdirectory of its session dir): without it there is no " +
        "one place this tool and hooks/factcheck-record.js agree the fact-check verdict lives.",
    };
  }

  if (decision === "approved") {
    const verdict = factCheckVerdict(sessionDir, key, gate);
    if (verdict !== "PASS") {
      return {
        ok: false,
        message:
          `ultracode: refusing to record ${gate} approval — ultracode:fact-check has not returned a ` +
          `PASS for "${gate}" in ${repoStateDir(sessionDir, key)} (current: ${verdict || "none recorded"}). ` +
          `Spawn ultracode:fact-check on the ${gate} file with the same "Repo key: ${key}", resolve any ` +
          "findings, and try again once it passes. If it already returned PASS, re-check that its spawn " +
          `carried "Repo key: ${key}" — a verdict recorded under a different key is not this gate's.`,
      };
    }
  }

  const gatesPath = path.join(sessionBaseDir(sessionDir), "gates.json");
  const current = readJsonIfFile(gatesPath) || {};
  current[gate] = { decision, notes: notes || "", repo: key, ts: new Date().toISOString() };
  writeJsonAtomic(gatesPath, current);
  return {
    ok: true,
    message: `Recorded ${gate} gate decision "${decision}" for ${sessionBaseDir(sessionDir)} (repo key ${key}).`,
  };
}

module.exports = { factCheckVerdict, recordGateDecision };
