#!/usr/bin/env node
// Enforce per-agent Write/Edit scope using normalized actor and session context.

"use strict";

const path = require("node:path");
const {
  denyPreToolUse,
  readHookInput,
  readJsonIfFile,
  resolvePathCandidate,
  writePathFromToolInput,
} = require("./lib/common");
const { HookContext } = require("./lib/hook-context");
const { sessionBaseDir } = require("./lib/session");
const { checkScope, scopeRecordFor } = require("./lib/scope-policy");

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);
  const actor = context.currentActor();
  const sessionRoot = actor.sessionDir ? sessionBaseDir(actor.sessionDir) : context.sessionRoot;
  if (!actor.agent || !context.targetInfo || !sessionRoot) return 0;

  const filePath = writePathFromToolInput(context.toolInput);
  if (!filePath) return 0;

  const repoRoot = path.resolve(actor.repoRoot);
  const target = resolvePathCandidate(repoRoot, filePath);
  const state = readJsonIfFile(path.join(sessionRoot, "spawn-scope.json"));
  const { allowed, reason } = checkScope(actor.agent, target, {
    repoRoot,
    sessionDir: sessionRoot,
    info: context.targetInfo,
    declaredScope: scopeRecordFor(state, {
      agent: actor.agent,
      repoKey: actor.repoKey,
      repoRoot,
    }),
  });
  if (!allowed) {
    denyPreToolUse(
      `ultracode: refusing to let ultracode:${actor.agent} write "${filePath}" — ${reason}. ` +
        "If this file genuinely needs to change, route it through the agent and repo scope that owns it.",
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
