"use strict";

// Pure gate-decision logic for the ultracode_gate MCP tool, split out from
// mcp/gate-server.js so it's unit-testable without spinning up a real MCP
// stdio transport (mirrors mcp/lib/memory.js).

const path = require("node:path");
const { writeJsonAtomic, readJsonIfFile } = require("../../hooks/lib/common");

function factCheckVerdict(sessionDir, gate) {
  const factcheck = readJsonIfFile(path.join(sessionDir, "factcheck.json"));
  return (factcheck && factcheck[gate] && factcheck[gate].verdict) || null;
}

function recordGateDecision(sessionDir, gate, decision, notes) {
  if (decision === "approved" && factCheckVerdict(sessionDir, gate) !== "PASS") {
    const verdict = factCheckVerdict(sessionDir, gate);
    return {
      ok: false,
      message:
        `ultracode: refusing to record ${gate} approval — ultracode:fact-check has not returned a ` +
        `PASS for "${gate}" in ${sessionDir} (current: ${verdict || "none recorded"}). Spawn ` +
        `ultracode:fact-check on the ${gate} file, resolve any findings, and try again once it passes.`,
    };
  }
  const gatesPath = path.join(sessionDir, "gates.json");
  const current = readJsonIfFile(gatesPath) || {};
  current[gate] = { decision, notes: notes || "", ts: new Date().toISOString() };
  writeJsonAtomic(gatesPath, current);
  return { ok: true, message: `Recorded ${gate} gate decision "${decision}" for ${sessionDir}.` };
}

module.exports = { factCheckVerdict, recordGateDecision };
