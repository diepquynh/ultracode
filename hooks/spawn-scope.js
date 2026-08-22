#!/usr/bin/env node
// Capture every orchestrator spawn's declared write scope in the primary repo's
// session root. The work repo is recorded separately, so cross-repo agents read
// one shared state file without losing which checkout they may modify.

"use strict";

const path = require("node:path");
const { readHookInput, readJsonIfFile, readTextIfFile, writeJsonAtomic } = require("./lib/common");
const { HookContext } = require("./lib/hook-context");
const { declaredPathsFrom } = require("./lib/scope-policy");

const SCHEMA_VERSION = 2;
const STATE_FILE = "spawn-scope.json";

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);
  if (context.currentActor().agent) return 0;

  const eligibleSpawns = context.spawns.filter(
    (spawn) => spawn.agent && spawn.repoKey && spawn.stateRoot,
  );
  if (eligibleSpawns.length === 0) return 0;

  try {
    const states = new Map();
    const phaseScopes = new Map();
    for (const spawn of eligibleSpawns) {
      const statePath = path.join(spawn.stateRoot, STATE_FILE);
      if (!states.has(statePath)) {
        const state = readJsonIfFile(statePath) || { schemaVersion: SCHEMA_VERSION, scopes: {} };
        state.schemaVersion = SCHEMA_VERSION;
        state.scopes = state.scopes || {};
        states.set(statePath, state);
      }

      const phaseFile = spawn.parameters.phase_file || "";
      if (!phaseScopes.has(phaseFile)) {
        const phaseBody = phaseFile ? readTextIfFile(phaseFile) : null;
        phaseScopes.set(phaseFile, {
          phaseBody,
          declared: phaseBody ? declaredPathsFrom(phaseBody) : { files: [], dirs: [] },
        });
      }
      const { phaseBody, declared } = phaseScopes.get(phaseFile);
      const state = states.get(statePath);
      state.scopes[spawn.agent] = state.scopes[spawn.agent] || {};
      state.scopes[spawn.agent][spawn.repoKey] = {
        repoKey: spawn.repoKey,
        repoRoot: spawn.workRepoRoot,
        primaryRepoRoot: spawn.primaryRepoRoot,
        phaseFile: phaseFile || null,
        phaseFileFound: Boolean(phaseBody),
        files: declared.files,
        dirs: declared.dirs,
        reportFile: spawn.parameters.report_file || null,
        sessionDir: spawn.effectiveSessionDir,
        recordedAt: new Date().toISOString(),
      };
    }

    for (const [statePath, state] of states) writeJsonAtomic(statePath, state);
  } catch {
    // Best-effort bookkeeping; parameter/session guards already enforce the spawn.
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
