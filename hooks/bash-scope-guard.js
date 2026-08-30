#!/usr/bin/env node
// Apply ledger ownership and per-agent write scope to shell write intents using
// the same normalized actor/work-repo/primary-session context as Write/Edit.

"use strict";

const path = require("node:path");
const {
  commandFromToolInput,
  denyPreToolUse,
  isInside,
  isMachineStatePath,
  MACHINE_STATE_DENIAL,
  readHookInput,
  readJsonIfFile,
  resolvePathCandidate,
} = require("./lib/common");
const { HookContext } = require("./lib/hook-context");
const { sessionBaseDir } = require("./lib/session");
const { checkLedger } = require("./lib/ledger-policy");
const { checkScope, resolveWriteScope } = require("./lib/scope-policy");
const { checkReportWrite } = require("./lib/report-policy");
const { extractWriteTargets } = require("./lib/shell-paths");

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);
  const actor = context.currentActor();
  const command = commandFromToolInput(context.toolInput);
  if (!command) return 0;

  const writeTargets = extractWriteTargets(command);
  for (const candidate of writeTargets) {
    const ledger = checkLedger(actor.agent, candidate);
    if (!ledger.allowed) {
      denyPreToolUse(
        `ultracode: refusing this shell command — it writes, moves, or deletes "${candidate}". ${ledger.reason}`,
      );
      return 0;
    }
    if (isMachineStatePath(candidate)) {
      denyPreToolUse(
        `ultracode: refusing this shell command — it writes, moves, or deletes "${candidate}", and ${MACHINE_STATE_DENIAL}`,
      );
      return 0;
    }
  }

  const sessionRoot = actor.sessionDir ? sessionBaseDir(actor.sessionDir) : context.sessionRoot;
  if (!actor.agent || !context.targetInfo || !sessionRoot) return 0;
  const state = readJsonIfFile(path.join(sessionRoot, "spawn-scope.json"));

  for (const candidate of writeTargets) {
    const provisional = resolvePathCandidate(sessionRoot, candidate);
    const { declaredScope, workRepoRoot } = resolveWriteScope(state, actor, provisional);
    const target = isInside(workRepoRoot, provisional)
      ? provisional
      : resolvePathCandidate(workRepoRoot, candidate);
    const { allowed, reason } = checkScope(actor.agent, target, {
      repoRoot: workRepoRoot,
      sessionDir: sessionRoot,
      info: context.targetInfo,
      declaredScope,
    });
    if (!allowed) {
      denyPreToolUse(
        `ultracode: refusing this shell command for ultracode:${actor.agent} — it writes, moves, or deletes ` +
          `"${candidate}", which is ${reason}.`,
      );
      return 0;
    }

    // A shell heredoc is a legitimate way to produce a report — the declared path
    // is the constraint, not the tool that writes it.
    const report = checkReportWrite(actor.agent, target, { sessionRoot, declaredScope, state });
    if (!report.allowed) {
      denyPreToolUse(
        `ultracode: refusing this shell command for ultracode:${actor.agent} — it writes "${candidate}", ` +
          `which is ${report.reason}.`,
        report.compact && `ultracode: ${report.compact}`,
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
