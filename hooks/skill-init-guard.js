#!/usr/bin/env node
// Hard-enforces the "repo must be initialized" check skills/orchestrate/prompt.md's Step
// 0 used to state only in prose (a model can talk itself past a sentence; it cannot talk
// itself past a denied tool call). Runs on two different events, because there are two
// different ways to load the orchestrate skill and each takes a different code path:
//
// - PreToolUse, on whichever call loads it as a tool: Claude's `Skill` tool, or the
//   Bash/Read call Codex and Grok Build use instead — tool-mapping.json's `skill`
//   capability has them open the skill's SKILL.md directly, since neither harness has a
//   Skill tool.
// - UserPromptExpansion, on Claude Code only: a user typing the skill's slash form
//   directly (e.g. "/ultracode:orchestrate") expands straight into the model's prompt
//   without ever emitting a `Skill` tool_use — PreToolUse never sees it, so this event
//   is the only hook that can catch that path.
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
  denyUserPromptExpansion,
  hookToolInput,
  bareAgentName,
  isFile,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot } = require("./lib/session");

const ORCHESTRATE_SKILL_PATH = /orchestrate[\\/]SKILL\.md/i;
// Grok/Codex/Antigravity may open the generated command markdown rather than
// a SKILL.md when loading orchestrate as a skill-like entry.
const ORCHESTRATE_COMMAND_PATH = /(?:^|[\\/])(?:skills|commands)[\\/]orchestrate(?:\.md|[\\/])/i;

function isOrchestratePath(value) {
  return ORCHESTRATE_SKILL_PATH.test(value) || ORCHESTRATE_COMMAND_PATH.test(value);
}

function targetsOrchestrateSkill(toolInput) {
  const skillField = typeof toolInput.skill === "string" ? toolInput.skill : "";
  if (skillField) return bareAgentName(skillField) === "orchestrate";

  const pathField =
    (typeof toolInput.TargetFile === "string" && toolInput.TargetFile) ||
    (typeof toolInput.AbsolutePath === "string" && toolInput.AbsolutePath) ||
    (typeof toolInput.file_path === "string" && toolInput.file_path) ||
    (typeof toolInput.filePath === "string" && toolInput.filePath) ||
    (typeof toolInput.path === "string" && toolInput.path) ||
    "";
  if (pathField && isOrchestratePath(pathField)) return true;

  const command =
    (typeof toolInput.CommandLine === "string" && toolInput.CommandLine) ||
    (typeof toolInput.command === "string" && toolInput.command) ||
    "";
  return Boolean(command) && isOrchestratePath(command);
}

// UserPromptExpansion's payload has no tool_input — it carries expansion_type
// ("slash_command" | "mcp_prompt") and command_name (the typed name, prefix included).
function targetsOrchestrateExpansion(hookInput) {
  if (hookInput.expansion_type !== "slash_command") return false;
  const commandName = typeof hookInput.command_name === "string" ? hookInput.command_name : "";
  return Boolean(commandName) && bareAgentName(commandName) === "orchestrate";
}

function missingInventoryReason(repoRoot, info) {
  if (isFile(path.join(repoRoot, info.runtimeDir, "INVENTORY.md"))) return null;
  return (
    `ultracode: refusing to run the orchestrate skill — repo \`${repoRoot}\` has no ultracode ` +
    `inventory (\`${info.runtimeDir}/INVENTORY.md\`). Run /init-kit in it first to scout it and ` +
    "generate skills."
  );
}

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput || typeof hookInput !== "object") return 0;

  if (hookInput.hook_event_name === "UserPromptExpansion") {
    if (!targetsOrchestrateExpansion(hookInput)) return 0;
    const info = pluginTargetInfo();
    if (!info) return 0;
    const repoRoot = resolveRepoRoot(hookInput, "");
    const reason = missingInventoryReason(repoRoot, info);
    if (reason) denyUserPromptExpansion(reason);
    return 0;
  }

  const toolInput = hookToolInput(hookInput);
  if (!toolInput || typeof toolInput !== "object") return 0;
  if (!targetsOrchestrateSkill(toolInput)) return 0;

  const info = pluginTargetInfo();
  if (!info) return 0;

  const repoRoot = resolveRepoRoot(hookInput, "");
  const reason = missingInventoryReason(repoRoot, info);
  if (reason) denyPreToolUse(reason);
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
