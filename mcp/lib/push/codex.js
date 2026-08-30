"use strict";

// Codex push adapter: `codex queue` (Codex CLI ≥0.149.0) delivers a message
// to a running named session — idle sessions wake into a new turn, mid-turn
// sessions see it as the next user turn. The session name is the
// native_address the worker registered.
//
// VERIFICATION (V3, docs/hub.md): the exact invocation below was written from
// the v0.149.0 release notes, not measured on a live CLI. Before relying on
// codex push in production, verify `codex queue --help` and pin the flags
// here with a measured-on date. Any mismatch merely degrades to pull.

const { execFile } = require("node:child_process");

let availability = null;

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2500 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// Feature-detect once per daemon lifetime; a machine without the Codex CLI
// (or an older one without `queue`) permanently reports unavailable.
async function available() {
  if (availability !== null) return availability;
  try {
    await execFileAsync("codex", ["queue", "--help"]);
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

async function push(session, notice) {
  if (!(await available())) return false;
  // Never shell interpolation: the notice and session name are argv entries.
  await execFileAsync("codex", ["queue", "--session", session.native_address, notice]);
  return true;
}

module.exports = {
  push,
  available,
  // test seam
  _resetAvailability: () => {
    availability = null;
  },
};
