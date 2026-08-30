"use strict";

// Codex push adapter: `codex queue` delivers a message to a running session —
// idle sessions wake into a new turn, mid-turn sessions see it as the next
// user turn.
//
// VERIFIED 2026-08-30 on codex-cli 0.151.0 (V3 in docs/hub.md):
//   codex queue --thread <SESSION-UUID-or-exact-name> --message <TEXT>
// `--thread` takes the session UUID, which is exactly the harness session id
// every hub registration already carries — so codex push needs no explicit
// native_address; one is used only when the worker registered a named session.
//
// ON BY DEFAULT; ULTRACODE_HUB_CODEX_PUSH=0 opts a daemon out. A machine
// whose codex CLI predates `queue` (<0.149.0) feature-detects as unavailable
// and degrades to pull, as does any invocation failure.

const { execFile } = require("node:child_process");

let availability = null;

function enabled() {
  return process.env.ULTRACODE_HUB_CODEX_PUSH !== "0";
}

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
  if (!enabled()) return false;
  const target = session.native_address || session.harness_session_id;
  if (!target) return false;
  if (!(await available())) return false;
  // Never shell interpolation: the target and notice are argv entries.
  await execFileAsync("codex", ["queue", "--thread", target, "--message", notice]);
  return true;
}

module.exports = {
  push,
  available,
  enabled,
  // test seam
  _resetAvailability: () => {
    availability = null;
  },
};
