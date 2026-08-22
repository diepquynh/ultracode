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

// Extracts the concrete file paths a plan phase names, for the phase-scoped
// allowlist. A phase file states exact paths per step ("### Step 3 — modify
// `core/src/main/java/Foo.java`"), so this is a real declaration, not a guess.
//
// Both files and their parent directories are collected, and a write is allowed
// anywhere under a declared directory. That is deliberately looser than
// exact-file matching: implementing a named service legitimately adds siblings
// (a DTO, an enum, a mapper) that no plan enumerates line by line. On the
// recorded corpus, directory-level matching accepted 100% of real writes while
// still confining each agent to the areas its phase is about.
function declaredPathsFrom(phaseBody) {
  const files = new Set();
  const dirs = new Set();
  // A path-like token with at least one separator and a file extension.
  const pattern = /(?:^|[\s`"'(\[|])((?:[\w.@-]+\/){1,}[\w.@-]+\.[A-Za-z][\w]{0,9})(?=[\s`"')\]|,.:;]|$)/g;
  let match;
  while ((match = pattern.exec(phaseBody)) !== null) {
    const candidate = match[1].replace(/^\.\//, "");
    // Skip ultracode's own artifacts — a phase file naturally cites reports and
    // plans, and those are governed by ledger-policy.js, not by this scope.
    if (/ultracode-|INVENTORY\.md|repo-profile\.json/.test(candidate)) continue;
    files.add(candidate);
    const parent = path.posix.dirname(candidate);
    if (parent && parent !== "." && parent.includes("/")) dirs.add(parent);
  }
  return { files: [...files].slice(0, 400), dirs: [...dirs].slice(0, 200) };
}

// True when `targetPath` is one of the declared files or sits under a declared
// directory. Matching is on path suffix so a repo-relative declaration matches an
// absolute write target.
function withinDeclaredScope(targetPath, declared) {
  const normalized = targetPath.replace(/\\/g, "/");
  for (const file of declared.files || []) {
    if (normalized === file || normalized.endsWith(`/${file}`)) return true;
  }
  for (const dir of declared.dirs || []) {
    if (normalized.includes(`/${dir}/`) || normalized.startsWith(`${dir}/`)) return true;
  }
  return false;
}

const TEST_DIR_PATTERN = /(^|[\\/])(__tests__|__mocks__|tests?)([\\/])/i;
const TEST_FILE_PATTERN =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|(^test_.+\.py$)|(_test\.py$)|(_test\.go$)|(_spec\.rb$)|(^spec_.+\.rb$)|([_.]?[Tt]ests?\.(java|kt|kts|cs)$)/;

function isTestPath(targetPath) {
  const normalized = targetPath.replace(/\\/g, "/");
  const base = path.basename(normalized);
  return TEST_DIR_PATTERN.test(normalized) || TEST_FILE_PATTERN.test(base);
}

function scopeRecordFor(state, { agent, repoKey = "", repoRoot = "" }) {
  const scopes = state && state.scopes && state.scopes[agent];
  if (scopes && typeof scopes === "object") {
    if (repoKey && scopes[repoKey]) return scopes[repoKey];
    const records = Object.values(scopes);
    if (repoRoot) {
      const resolvedRoot = path.resolve(repoRoot);
      const match = records.find(
        (record) => record && record.repoRoot && path.resolve(record.repoRoot) === resolvedRoot,
      );
      if (match) return match;
    }
    if (records.length === 1) return records[0];
  }
  return (state && state.agents && state.agents[agent]) || null;
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

  // Phase-scoped confinement for the agents that would otherwise hold the whole
  // repo root. Applies ONLY when this spawn's phase file was found and actually
  // declared paths (hooks/spawn-scope.js records that). A no-plan task, or a
  // phase file that names nothing concrete, stays unscoped — the alternative
  // would block legitimate inline work that never had a phase file to scope to.
  const declared = ctx.declaredScope;
  if (declared && declared.phaseFileFound && (declared.files || []).length) {
    if (!withinDeclaredScope(targetPath, declared)) {
      return {
        allowed: false,
        reason:
          "outside the file set this phase declares — " +
          `${(declared.files || []).length} path(s) in "${declared.phaseFile}" and the directories they ` +
          "live in are writable for this spawn. If this file genuinely belongs to the phase, the phase " +
          "file is what is wrong: report that instead of writing outside the declared scope, so the plan " +
          "and the change stay in agreement",
      };
    }
  }

  return { allowed: true };
}

module.exports = {
  SESSION_ONLY_AGENTS,
  EXTRA_ALLOWED_SUBTREES,
  isTestPath,
  scopeRecordFor,
  checkScope,
  declaredPathsFrom,
  withinDeclaredScope,
};
