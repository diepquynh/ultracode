#!/usr/bin/env node
// Shared per-agent write-scope policy used by scope-guard.js (Write/Edit) and
// bash-scope-guard.js (Bash) — one source of truth so a subagent cannot escape
// its documented working path through whichever tool call the model reaches for.
//
// The policy is deliberately conservative: agents whose own prompt.md says they
// never touch project source (code-reviewer, plan, execution-path-analyzer,
// explore, fact-check, generate-spec) are hard-confined to their session
// directory. initializer and module-documentation get one extra named subtree
// each, matching the exact paths their prompt.md documents. implement,
// prompt-generation, and write-test keep full repo-root write access beyond
// that — their jobs genuinely require writing anywhere in the repo, and their
// legitimate file-naming conventions vary too widely (fixtures, conftest.py,
// snapshots, arbitrary source files carrying prompt text) to allowlist safely
// without breaking real work. implement additionally may never touch a path
// that looks like a test file — agents/implement/prompt.md Constraint 6 — which
// is enforced here rather than only in the implement agent's own prompt so a
// weaker or misled model cannot talk its way around it.

"use strict";

const path = require("node:path");
const { isInside } = require("./common");

const SESSION_ONLY_AGENTS = new Set([
  "code-reviewer",
  "plan",
  "execution-path-analyzer",
  "explore",
  "fact-check",
  "generate-spec",
]);

// agent -> (repoRoot, info) => extra absolute directories that agent may write
// under, in addition to its session dir. `info` is a pluginTargetInfo() result
// ({ skillsDir, runtimeDir, ... }), which is harness-specific (claude/codex/grok
// each mount skills/runtime at a different path).
const EXTRA_ALLOWED_SUBTREES = {
  initializer: (repoRoot, info) =>
    [info.skillsDir, info.runtimeDir].filter(Boolean).map((rel) => path.join(repoRoot, rel)),
  "module-documentation": (repoRoot, info) =>
    info.skillsDir ? [path.join(repoRoot, info.skillsDir, "module-hub", "references")] : [],
};

const TEST_DIR_PATTERN = /(^|[\\/])(__tests__|__mocks__|tests?)([\\/])/i;
const TEST_FILE_PATTERN =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|(^test_.+\.py$)|(_test\.py$)|(_test\.go$)|(_spec\.rb$)|(^spec_.+\.rb$)|([_.]?[Tt]ests?\.(java|kt|kts|cs)$)/;

function isTestPath(targetPath) {
  const normalized = targetPath.replace(/\\/g, "/");
  const base = path.basename(normalized);
  return TEST_DIR_PATTERN.test(normalized) || TEST_FILE_PATTERN.test(base);
}

// Returns { allowed: true } or { allowed: false, reason }. `targetPath` must
// already be an absolute, resolved path. `ctx` = { repoRoot, sessionDir, info }.
function checkScope(agent, targetPath, ctx) {
  const { repoRoot, sessionDir, info } = ctx;

  if (agent === "implement" && isTestPath(targetPath)) {
    return {
      allowed: false,
      reason:
        "a test file/directory path — agents/implement/prompt.md Constraint 6 prohibits ultracode:implement " +
        "from writing or fixing tests, absolutely, with no override; tests are ultracode:write-test's job, " +
        "only after the user requests them at the closing gate",
    };
  }

  if (!isInside(repoRoot, targetPath)) {
    return { allowed: false, reason: `outside the repo root ("${repoRoot}")` };
  }

  if (isInside(sessionDir, targetPath)) return { allowed: true };

  const extra = EXTRA_ALLOWED_SUBTREES[agent];
  if (extra) {
    const roots = extra(repoRoot, info || {});
    if (roots.some((root) => isInside(root, targetPath))) return { allowed: true };
    return {
      allowed: false,
      reason:
        `outside its allowed scope — only "${sessionDir}" and ` +
        `${roots.map((root) => `"${root}"`).join(" or ")} are writable by ultracode:${agent}`,
    };
  }

  if (SESSION_ONLY_AGENTS.has(agent)) {
    return {
      allowed: false,
      reason: `outside its session directory ("${sessionDir}") — ultracode:${agent} never modifies project source`,
    };
  }

  return { allowed: true };
}

module.exports = { SESSION_ONLY_AGENTS, EXTRA_ALLOWED_SUBTREES, isTestPath, checkScope };
