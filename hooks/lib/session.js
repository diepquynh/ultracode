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
