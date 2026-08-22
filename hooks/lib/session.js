#!/usr/bin/env node
// Session/target resolution shared by ultracode's Track A/B hooks.

"use strict";

const path = require("node:path");
const {
  field,
  isDirectory,
  isFile,
  isInside,
  hookToolInput,
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
    return {
      target: routing.target,
      runtimeDir: routing.runtime_dir,
      skillsDir: typeof routing.skills_dir === "string" ? routing.skills_dir : null,
      agentsDir: typeof routing.agents_dir === "string" ? routing.agents_dir : null,
    };
  } catch {
    return null;
  }
}

function extractCandidateRoots(hookInput) {
  if (!hookInput || typeof hookInput !== "object") return [];
  const candidates = [];

  for (const key of [
    "cwd",
    "Cwd",
    "workspaceRoot",
    "workspace_root",
    "workspacePath",
    "workspace_path",
  ]) {
    if (typeof hookInput[key] === "string" && hookInput[key].trim()) {
      candidates.push(hookInput[key].trim());
    }
  }

  for (const key of [
    "workspacePaths",
    "workspace_paths",
    "workspaceRoots",
    "workspace_roots",
  ]) {
    if (Array.isArray(hookInput[key])) {
      for (const item of hookInput[key]) {
        if (typeof item === "string" && item.trim()) {
          candidates.push(item.trim());
        }
      }
    }
  }

  const toolInput = hookToolInput(hookInput);
  if (toolInput && typeof toolInput === "object") {
    for (const key of ["Cwd", "cwd", "SearchDirectory", "DirectoryPath", "SearchPath"]) {
      if (typeof toolInput[key] === "string" && toolInput[key].trim()) {
        candidates.push(toolInput[key].trim());
      }
    }
  }

  return candidates;
}

function resolveRepoRoot(hookInput, prompt) {
  const declared = field(prompt, "Repo root");
  if (declared && isDirectory(declared)) return path.resolve(declared);

  const pluginRoot = pluginRootFromEnv();
  const rawCandidates = extractCandidateRoots(hookInput);
  const candidates = rawCandidates.map((c) => path.resolve(c)).filter(isDirectory);

  const toolInput = hookToolInput(hookInput);
  const targetFile =
    toolInput && typeof toolInput === "object"
      ? (typeof toolInput.TargetFile === "string" && toolInput.TargetFile) ||
        (typeof toolInput.AbsolutePath === "string" && toolInput.AbsolutePath) ||
        (typeof toolInput.file_path === "string" && toolInput.file_path) ||
        (typeof toolInput.filePath === "string" && toolInput.filePath) ||
        (typeof toolInput.path === "string" && toolInput.path) ||
        ""
      : "";

  // If targetFile is given and is NOT in plugin root, check if a candidate contains it
  if (targetFile && candidates.length > 1 && !isInside(pluginRoot, path.resolve(targetFile))) {
    const matching = candidates.find(
      (c) => !isInside(pluginRoot, c) && isInside(c, path.resolve(targetFile)),
    );
    if (matching) return matching;
  }

  // Pick first candidate that is not inside plugin root
  const nonPluginCandidate = candidates.find((c) => !isInside(pluginRoot, c));
  if (nonPluginCandidate) return nonPluginCandidate;

  if (candidates.length > 0) return candidates[0];

  const envVar =
    process.env.GROK_WORKSPACE_ROOT ||
    process.env.ANTIGRAVITY_WORKSPACE_ROOT ||
    process.env.AGY_WORKSPACE_ROOT ||
    process.env.WORKSPACE_ROOT ||
    process.env.CLAUDE_PROJECT_DIR;
  if (envVar && isDirectory(envVar)) return path.resolve(envVar);

  return path.resolve(process.cwd());
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

// The repo key a prompt's `Repo key:` line (or a tool call's `repo_key`) carries:
// the lowercase slug the orchestrator assigned that repo in Step 0. "" for
// anything that is not one — every caller treats "" as a hard failure rather than
// guessing a key, because a guessed key writes pipeline state to a directory the
// next reader will not look in.
const REPO_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function normalizeRepoKey(value) {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return REPO_KEY_PATTERN.test(key) ? key : "";
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
    REPO_KEY_PATTERN.test(relative);
  return { ok: Boolean(isRepoKeySubdir), expected };
}

// The `ultracode-session-{id}` directory itself, from a session dir that may be
// that directory or one repo-key subdirectory of it.
//
// Both forms are legitimate in a spawn prompt — Rules D2/D4 hand the cross-repo
// stages the base dir, everything else gets `{base}/{repo-key}` — so a reader
// that joins onto whichever form it happened to be handed reads a different path
// than the writer wrote. That is how a recorded fact-check PASS went missing at
// the gate: written under the repo subdir the fact-check spawn declared, looked
// for at the base dir the ultracode_gate call passed. Normalizing here first
// means (session dir, repo key) resolves to one path from either side.
function sessionBaseDir(declaredDir) {
  const resolved = path.resolve(String(declaredDir || ""));
  const parts = resolved.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].startsWith("ultracode-session-")) {
      return parts.slice(0, i + 1).join(path.sep) || path.sep;
    }
  }
  return resolved;
}

// Where one repo's gated state (factcheck.json) lives: always the repo-key
// subdirectory, whichever of the two session-dir forms the caller was handed.
function repoStateDir(declaredSessionDir, repoKey) {
  const key = normalizeRepoKey(repoKey);
  if (!key) return "";
  return path.join(sessionBaseDir(declaredSessionDir), key);
}

module.exports = {
  pluginTargetInfo,
  resolveRepoRoot,
  baseSessionDir,
  matchesSessionDir,
  normalizeRepoKey,
  sessionBaseDir,
  repoStateDir,
  isFile,
};
