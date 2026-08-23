#!/usr/bin/env node
// Shared per-agent write-scope policy used by scope-guard.js (Write/Edit) and
// bash-scope-guard.js (Bash) — one source of truth so a subagent cannot escape
// its documented working path through whichever tool call the model reaches for.
//
// The policy is deliberately conservative: agents whose own prompt.md says they
// never touch project source (code-reviewer, plan, execution-path-analyzer,
// explore, fact-check, generate-spec) are hard-confined to their session
// directory, plus OS-temp scratch outside every governed root — the shell is a
// first-class way to produce a session artifact, not a loophole around the
// write tool. initializer and module-documentation get one extra named subtree
// each, matching the exact paths their prompt.md documents. implement,
// prompt-generation, and write-test keep full work-repo-root write access beyond
// that — their jobs genuinely require writing anywhere in the checkout, and a
// phase file's path list is only a hint (plans miss skill-required companions
// such as DTOs, enums, wiring). hooks/spawn-scope.js still records those paths
// for observability; this policy does not deny writes for leaving that set.
// implement additionally may never touch a path that looks like a test file —
// agents/implement/prompt.md Constraint 6 — which is enforced here rather than
// only in the implement agent's own prompt so a weaker or misled model cannot
// talk its way around it.

"use strict";

const os = require("node:os");
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

function scopeRecordFor(state, { agent, repoKey = "", repoRoot = "", targetPath = "" }) {
  const scopes = state && state.scopes && state.scopes[agent];
  if (scopes && typeof scopes === "object") {
    if (repoKey && scopes[repoKey]) return scopes[repoKey];
    const records = Object.values(scopes).filter((record) => record && typeof record === "object");
    // Prefer the spawn whose recorded work-repo contains the write target. Cross-repo
    // sessions keep several implement/write-test scopes under one spawn-scope.json; a
    // blank actor.repoKey used to fall through to the first/primary record and confine
    // a secondary-repo spawn to the wrong phase file.
    if (targetPath) {
      const resolvedTarget = path.resolve(targetPath);
      const byTarget = records.find(
        (record) => record.repoRoot && isInside(path.resolve(record.repoRoot), resolvedTarget),
      );
      if (byTarget) return byTarget;
    }
    if (repoRoot) {
      const resolvedRoot = path.resolve(repoRoot);
      const match = records.find(
        (record) => record.repoRoot && path.resolve(record.repoRoot) === resolvedRoot,
      );
      if (match) return match;
    }
    if (records.length === 1) return records[0];
  }
  return (state && state.agents && state.agents[agent]) || null;
}

// Work-repo root + declared phase scope for one write. Guards use this so a
// secondary-repo spawn can write code under its own checkout while reports stay
// under the primary session dir, even when the harness payload only names the
// primary project as cwd/agent context.
function resolveWriteScope(state, actor, targetPath) {
  const declaredScope = scopeRecordFor(state, {
    agent: actor.agent,
    repoKey: actor.repoKey || "",
    repoRoot: actor.repoRoot || "",
    targetPath,
  });
  const workRepoRoot = path.resolve(
    (declaredScope && declaredScope.repoRoot) || actor.repoRoot || process.cwd(),
  );
  return { declaredScope, workRepoRoot };
}

// Returns { allowed: true } or { allowed: false, reason }. `targetPath` must
// already be an absolute, resolved path. `ctx` = { repoRoot, sessionDir, info }.
//
// Cross-repo spawns safeguard two roots, not one: `sessionDir` (primary pipeline
// artifacts / reports) and `repoRoot` (the work checkout named by `Repo root:`).
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

  // Reports live under the primary session dir, which may sit outside the work repo.
  if (sessionDir && isInside(sessionDir, targetPath)) return { allowed: true };

  if (!repoRoot || !isInside(repoRoot, targetPath)) {
    // Session-only agents may use OS-temp scratch outside every governed root:
    // it is not project source, and ledger basenames stay protected wherever
    // they sit (ledger-policy.js). Denying it forced generate-spec, verifying
    // its own artifact (`sort … > /tmp/got.txt`), to contort shell work into
    // pipes or route every intermediate file through the write tool. Repo-
    // writing agents (implement, write-test, …) keep strict confinement.
    if (
      SESSION_ONLY_AGENTS.has(agent) &&
      (isInside(os.tmpdir(), targetPath) || isInside("/tmp", targetPath))
    ) {
      return { allowed: true };
    }
    return { allowed: false, reason: `outside the repo root ("${repoRoot}")` };
  }

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

  // Phase-declared paths are a hint for implement/write-test, not a write
  // allowlist. spawn-scope.js still records them; confining to that set blocked
  // skill-driven companions the plan omitted. Repo-root / session-only /
  // subtree / test-path rules above remain the hard boundaries.
  return { allowed: true };
}

module.exports = {
  SESSION_ONLY_AGENTS,
  EXTRA_ALLOWED_SUBTREES,
  isTestPath,
  scopeRecordFor,
  resolveWriteScope,
  checkScope,
  declaredPathsFrom,
  withinDeclaredScope,
};
