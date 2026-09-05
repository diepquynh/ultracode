#!/usr/bin/env node
// Enforce spec/plan approvals for every requested subagent. Gates are session-
// level state under the primary repository, regardless of the work repo.

"use strict";

const path = require("node:path");
const { denyPreToolUse, readHookInput, readJsonIfFile } = require("./lib/common");
const { HookContext } = require("./lib/hook-context");

const PLAN_GATED_AGENTS = new Set([
  "implementer",
  "write-test",
  "execution-path-analyzer",
  "module-documentation",
]);

function decisionFor(gates, gate) {
  return gates && gates[gate] && gates[gate].decision;
}

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);
  const gatesByRoot = new Map();
  const loadGates = (stateRoot) => {
    if (!stateRoot) return null;
    if (!gatesByRoot.has(stateRoot)) {
      gatesByRoot.set(stateRoot, readJsonIfFile(path.join(stateRoot, "gates.json")));
    }
    return gatesByRoot.get(stateRoot);
  };

  for (const spawn of context.spawns) {
    if (!spawn.agent) continue;
    const phaseFile = spawn.parameters.phase_file;
    if (spawn.agent === "implementer" && !phaseFile && !spawn.parameters.no_plan) {
      denyPreToolUse(
        "ultracode: refusing ultracode:implementer without a plan: add Phase file: or No plan:. " +
          "A planned spawn must name its phase; an inline spawn must state why no plan is needed.",
      );
      return 0;
    }

    if (spawn.agent === "plan" && decisionFor(loadGates(spawn.stateRoot), "spec") !== "approved") {
      denyPreToolUse(
        "ultracode: refusing to spawn ultracode:plan — the spec has not been recorded as approved in the primary session. " +
          `Record approval with session_dir: "${spawn.stateRoot}" and repo_key: "${spawn.repoKey}" first.`,
      );
      return 0;
    }

    if (PLAN_GATED_AGENTS.has(spawn.agent) && phaseFile && decisionFor(loadGates(spawn.stateRoot), "plan") !== "approved") {
      denyPreToolUse(
        `ultracode: refusing to spawn ultracode:${spawn.agent} — this prompt names a Phase file: but the ` +
          "plan has not been recorded as approved in the primary session.",
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
