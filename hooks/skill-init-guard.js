#!/usr/bin/env node
// Hard-enforces the "repo must be initialized" check skills/orchestrate/prompt.md's Step
// 0 used to state only in prose (a model can talk itself past a sentence; it cannot talk
// itself past a denied tool call). Runs as a PreToolUse hook on whichever call loads the
// orchestrate skill: Claude's `Skill` tool, or the Bash/Read call Codex and Grok Build use
// instead — tool-mapping.json's `skill` capability has them open the skill's SKILL.md
// directly, since neither harness has a Skill tool.
//
// Denies only when the *current working directory's* repo has no INVENTORY.md under its
// runtime dir. A later-named repo in a multi-repo session is still checked in prose by
// skills/orchestrate/prompt.md Step 0, because this hook only sees the invocation's cwd,
// not a repo named in free text after the skill has already loaded.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  denyPreToolUse,
  hookToolInput,
  bareAgentName,
  isFile,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot } = require("./lib/session");

const ORCHESTRATE_SKILL_PATH = /orchestrate[\\/]SKILL\.md/i;

function targetsOrchestrateSkill(toolInput) {
  const skillField = typeof toolInput.skill === "string" ? toolInput.skill : "";
  if (skillField) return bareAgentName(skillField) === "orchestrate";

  const pathField =
    (typeof toolInput.file_path === "string" && toolInput.file_path) ||
    (typeof toolInput.filePath === "string" && toolInput.filePath) ||
    (typeof toolInput.path === "string" && toolInput.path) ||
    "";
  if (pathField && ORCHESTRATE_SKILL_PATH.test(pathField)) return true;

  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  return Boolean(command) && ORCHESTRATE_SKILL_PATH.test(command);
}

async function main() {
  const hookInput = await readHookInput();
  const toolInput = hookToolInput(hookInput);
  if (!toolInput || typeof toolInput !== "object") return 0;
  if (!targetsOrchestrateSkill(toolInput)) return 0;

  const info = pluginTargetInfo();
  if (!info) return 0;

  const repoRoot = resolveRepoRoot(hookInput, "");
  const inventoryPath = path.join(repoRoot, info.runtimeDir, "INVENTORY.md");
  if (isFile(inventoryPath)) return 0;

  denyPreToolUse(
    `ultracode: refusing to run the orchestrate skill — repo \`${repoRoot}\` has no ultracode ` +
      `inventory (\`${info.runtimeDir}/INVENTORY.md\`). Run /init-kit in it first to scout it and ` +
      "generate skills.",
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
