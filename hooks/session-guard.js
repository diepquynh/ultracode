#!/usr/bin/env node
// Hard-enforce "Session isolation" (skills/orchestrate/prompt.md) and Hard rule 3:
// every spawn that names a Repo root: must also carry a Session dir: and a
// Repo key:, the dir must be the derived path (or one repo-key subdirectory of
// it) — never a random or invented location the next stage will not look in —
// and the two must agree.
//
// The Repo key: line is what makes per-repo pipeline state addressable by the
// hook that writes it and the tool that reads it alike: hooks/factcheck-record.js
// records a fact-check verdict under (session dir, repo key), and ultracode_gate
// looks for it under the same pair. A spawn with no key records nothing, so the
// gate later reports a PASS that arrived as "none recorded" and refuses an
// approval the user did give — a failure that surfaces stages later, in a hook
// that cannot explain it. Denying the spawn now puts the error where the fix is.
//
// Reads a PreToolUse hook payload (matcher: Task|Agent / Agent) from stdin.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  denyPreToolUse,
  promptFromToolInput,
  field,
  hookToolInput,
  hookSessionId,
} = require("./lib/common");
const {
  pluginTargetInfo,
  resolveRepoRoot,
  matchesSessionDir,
  normalizeRepoKey,
} = require("./lib/session");

async function main() {
  const hookInput = await readHookInput();
  const toolInput = hookToolInput(hookInput);
  if (!toolInput || typeof toolInput !== "object") return 0;

  const prompt = promptFromToolInput(toolInput);
  const declaredRepoRoot = field(prompt, "Repo root");
  if (!declaredRepoRoot) return 0; // nothing to validate — not every tool call is a repo-scoped spawn

  const declaredSessionDir = field(prompt, "Session dir");
  if (!declaredSessionDir) {
    denyPreToolUse(
      "ultracode: this spawn names a Repo root: but no Session dir: line. " +
        "Every subagent prompt must carry both (Hard rule 3) — add the derived " +
        "Session dir: and re-spawn.",
    );
    return 0;
  }

  const declaredRepoKey = field(prompt, "Repo key");
  if (!declaredRepoKey) {
    denyPreToolUse(
      "ultracode: this spawn names a Repo root: but no Repo key: line. Every subagent prompt must " +
        "carry all three of Repo root:, Session dir:, and Repo key: (Hard rule 3) — the repo key is " +
        "how this stage's fact-check verdict and the ultracode_gate call that reads it resolve to the " +
        "same file. Add `Repo key: {the lowercase slug you assigned this repo in Step 0}` and re-spawn.",
    );
    return 0;
  }

  const repoKey = normalizeRepoKey(declaredRepoKey);
  if (!repoKey) {
    denyPreToolUse(
      `ultracode: Repo key: "${declaredRepoKey}" is not a repo key. Use the lowercase slug you ` +
        'assigned this repo in Step 0 — letters, digits and dashes only, e.g. "backend" or "web" — ' +
        "and the same one in every spawn and every ultracode_gate call for this repo.",
    );
    return 0;
  }

  const info = pluginTargetInfo();
  if (!info) return 0; // no generated routing yet (repo not initialized) — nothing to validate against

  const repoRoot = resolveRepoRoot(hookInput, prompt);
  const { ok, expected } = matchesSessionDir(
    declaredSessionDir,
    repoRoot,
    info.runtimeDir,
    hookSessionId(hookInput),
  );
  if (!ok) {
    denyPreToolUse(
      `ultracode: Session dir: "${declaredSessionDir}" is not the derived session ` +
        `directory for this repo and session. Use "${expected}" (or "${path.join(expected, "{repo-key}")}" ` +
        "for a multi-repo session) — never a random or timestamped suffix — and re-spawn.",
    );
    return 0;
  }

  // A session dir that names a repo-key subdirectory must name THIS repo's key.
  // Two different keys in one prompt is not a harmless inconsistency: the reports
  // land under one and the fact-check verdict under the other, so the gate reads
  // an empty directory.
  const subdir = path.relative(path.resolve(expected), path.resolve(declaredSessionDir));
  if (subdir && subdir !== repoKey) {
    denyPreToolUse(
      `ultracode: this spawn's Repo key: "${repoKey}" and its Session dir: subdirectory "${subdir}" ` +
        "name different repos. Make them the same key — the session dir is " +
        `"${path.join(expected, repoKey)}" for repo key "${repoKey}" — and re-spawn.`,
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
