#!/usr/bin/env node
// Session/target resolution shared by ultracode's Track A/B hooks.

"use strict";

const path = require("node:path");
const {
  field,
  isDirectory,
  isFile,
  readTextIfFile,
  sanitizeSessionId,
  pluginRootFromEnv,
} = require("./common");

// Reads the same generated routing file hooks/model-router.js reads, so every
// hook shares one source of truth for { target, runtime_dir } instead of
// re-deriving it (and instead of guessing the harness from env vars).
function pluginTargetInfo() {
  const pluginRoot = pluginRootFromEnv();
  const routingPath = path.join(pluginRoot, "hooks", "model-routing.json");
  const text = readTextIfFile(routingPath);
  if (!text) return null;
  try {
    const routing = JSON.parse(text);
    if (!routing || typeof routing.runtime_dir !== "string" || !routing.runtime_dir) {
      return null;
    }
    return { target: routing.target, runtimeDir: routing.runtime_dir };
  } catch {
    return null;
  }
}

function resolveRepoRoot(hookInput, prompt) {
  const declared = field(prompt, "Repo root");
  if (declared && isDirectory(declared)) return path.resolve(declared);
  const cwd = (hookInput && hookInput.cwd) || process.cwd();
  return path.resolve(cwd);
}

// The session dir formula every prompt/agent already derives independently
// (skills/orchestrate/prompt.md, "Session isolation"): a pure function of the
// repo root, the runtime dir, and the harness session id — no random suffix.
function baseSessionDir(repoRoot, runtimeDir, sessionId) {
  return path.join(
    repoRoot,
    runtimeDir,
    "session",
    `ultracode-session-${sanitizeSessionId(sessionId)}`,
  );
}

// A declared "Session dir:" is valid if it is exactly the base dir, or the
// base dir plus one repo-key subdirectory (Rule: "Give each repo its own
// subdirectory"). Returns { ok, expected } — expected is the base dir, for
// use in a deny message even when ok is true.
function matchesSessionDir(declaredDir, repoRoot, runtimeDir, sessionId) {
  const expected = baseSessionDir(repoRoot, runtimeDir, sessionId);
  const resolved = path.resolve(declaredDir);
  if (resolved === expected) return { ok: true, expected };
  const relative = path.relative(expected, resolved);
  const isRepoKeySubdir =
    relative &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    /^[a-z0-9-]+$/.test(relative);
  return { ok: Boolean(isRepoKeySubdir), expected };
}

module.exports = {
  pluginTargetInfo,
  resolveRepoRoot,
  baseSessionDir,
  matchesSessionDir,
  isFile,
};
