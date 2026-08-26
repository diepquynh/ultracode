#!/usr/bin/env node
// Enforce per-agent Write/Edit scope using normalized actor and session context.

"use strict";

const path = require("node:path");
const {
  denyPreToolUse,
  isInside,
  readHookInput,
  readJsonIfFile,
  resolvePathCandidate,
  writePathFromToolInput,
} = require("./lib/common");
const { HookContext } = require("./lib/hook-context");
const { sessionBaseDir } = require("./lib/session");
const { checkScope, resolveWriteScope } = require("./lib/scope-policy");
const { checkReportWrite } = require("./lib/report-policy");

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);
  const actor = context.currentActor();
  const sessionRoot = actor.sessionDir ? sessionBaseDir(actor.sessionDir) : context.sessionRoot;
  if (!actor.agent || !context.targetInfo || !sessionRoot) return 0;

  const filePath = writePathFromToolInput(context.toolInput);
  if (!filePath) return 0;

  // Resolve against the primary session first so a report path under the primary
  // checkout is absolute before we pick the work-repo root for code writes.
  const provisional = resolvePathCandidate(sessionRoot, filePath);
  const state = readJsonIfFile(path.join(sessionRoot, "spawn-scope.json"));
  const { declaredScope, workRepoRoot } = resolveWriteScope(state, actor, provisional);
  const target = isInside(workRepoRoot, provisional)
    ? provisional
    : resolvePathCandidate(workRepoRoot, filePath);
  const { allowed, reason } = checkScope(actor.agent, target, {
    repoRoot: workRepoRoot,
    sessionDir: sessionRoot,
    info: context.targetInfo,
    declaredScope,
  });
  if (!allowed) {
    denyPreToolUse(
      `ultracode: refusing to let ultracode:${actor.agent} write "${filePath}" — ${reason}. ` +
        "If this file genuinely needs to change, route it through the agent and repo scope that owns it.",
    );
    return 0;
  }

  // Any tool may write the report; the path is what is held fixed.
  const report = checkReportWrite(actor.agent, target, { sessionRoot, declaredScope, state });
  if (!report.allowed) {
    denyPreToolUse(
      `ultracode: refusing to let ultracode:${actor.agent} write "${filePath}" — it is ${report.reason}.`,
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
