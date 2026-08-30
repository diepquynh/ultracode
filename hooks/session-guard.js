#!/usr/bin/env node
// Enforce the declarative parameter contract for every Ultracode subagent in a
// spawn call. Work may target another repository; all ephemeral state must still
// resolve beneath the primary repository's deterministic session root.

"use strict";

const path = require("node:path");
const { denyPreToolUse, knownAgents, readHookInput } = require("./lib/common");
const { HookContext } = require("./lib/hook-context");
const { validateSubagentParameters } = require("./lib/subagent-params");
const { matchesSessionDir, sessionBaseDir } = require("./lib/session");
const { isAdoptedSessionDir } = require("./lib/session-link");

function spawnLabel(spawn, count) {
  return count > 1 ? `ultracode:${spawn.agent} (Subagents[${spawn.index}])` : `ultracode:${spawn.agent}`;
}

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);
  const routedAgents = knownAgents();
  const spawns = context.spawns.filter((spawn) => routedAgents.has(spawn.agent));

  for (const spawn of spawns) {
    const validation = validateSubagentParameters(spawn.agent, spawn.parameters);
    if (!validation.ok) {
      const missing = validation.errors.map((error) => `- ${error}`).join("\n");
      denyPreToolUse(
        `ultracode: refusing ${spawnLabel(spawn, spawns.length)} because its required parameter contract is incomplete:\n` +
          `${missing}\nEvery Ultracode spawn is self-contained. Add the named \`Label: value\` lines and re-spawn.`,
      );
      return 0;
    }

    if (!context.targetInfo) continue;
    const declaredSessionDir = validation.values.session_dir;
    const { ok, expected } = matchesSessionDir(
      declaredSessionDir,
      validation.values.primary_repo_root,
      context.targetInfo.runtimeDir,
      context.sessionId,
    );
    // A session dir whose id is not this native session's is normally rejected.
    // The exception is a shared ultracode session this native session has
    // adopted through the hub (ultracode_session_adopt): the hub-written link
    // authorizes working in that dir, so a harness can pick up or resume a
    // session it could never inherit by native id. The link lives in machine
    // state that models cannot write, so it cannot be forged to smuggle a spawn
    // into an arbitrary dir. The repo-key subdirectory is still checked below.
    if (
      !ok &&
      isAdoptedSessionDir(
        context.target,
        context.sessionId,
        declaredSessionDir,
        validation.values.primary_repo_root,
      )
    ) {
      const base = sessionBaseDir(declaredSessionDir);
      const relative = path.relative(path.resolve(base), path.resolve(declaredSessionDir));
      if (!relative || relative === spawn.repoKey) continue;
    }
    if (!ok) {
      denyPreToolUse(
        `ultracode: refusing ${spawnLabel(spawn, spawns.length)} because Session dir: ` +
          `"${declaredSessionDir}" is not under the primary repository session root. ` +
          `Use "${expected}" for session-wide stages or "${path.join(expected, spawn.repoKey)}" for repo-scoped ` +
          `stages. Repo root: may point at another repository; Session dir: may not.`,
      );
      return 0;
    }

    const relative = path.relative(path.resolve(expected), path.resolve(declaredSessionDir));
    if (relative && relative !== spawn.repoKey) {
      denyPreToolUse(
        `ultracode: refusing ${spawnLabel(spawn, spawns.length)} because Repo key: "${spawn.repoKey}" ` +
          `does not match Session dir: subdirectory "${relative}". Use ` +
          `"${path.join(expected, spawn.repoKey)}" or the session root for a cross-repo stage.`,
      );
      return 0;
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
