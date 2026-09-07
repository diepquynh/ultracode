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
//
// Second job, on the same two events: record which sessions drive the pipeline
// (lib/pipeline-session.js). This hook is already the one place that sees every
// load path of orchestrate and hub-listen, so the marker is written here rather
// than from a second hook that would have to re-derive the same detection.

"use strict";

const path = require("node:path");
const {
  readHookInput,
  denyPreToolUse,
  denyUserPromptExpansion,
  hookSessionId,
  hookToolInput,
  bareAgentName,
  isFile,
} = require("./lib/common");
const { pluginTargetInfo, resolveRepoRoot } = require("./lib/session");
const { PIPELINE_COMMANDS, recordPipelineSession } = require("./lib/pipeline-session");

const PIPELINE_SKILL_PATH = /(orchestrate|hub-listen)[\\/]SKILL\.md/i;
// Grok/Codex/Antigravity may open the generated command markdown rather than
// a SKILL.md when loading one of these as a skill-like entry.
const PIPELINE_COMMAND_PATH =
  /(?:^|[\\/])(?:skills|commands)[\\/](orchestrate|hub-listen)(?:\.md|[\\/])/i;

// The pipeline command a path or command line loads, or "".
function pipelineCommandInText(value) {
  const match = PIPELINE_SKILL_PATH.exec(value) || PIPELINE_COMMAND_PATH.exec(value);
  return match ? bareAgentName(match[1]) : "";
}

function pipelineCommandFromToolInput(toolInput) {
  const skillField = typeof toolInput.skill === "string" ? toolInput.skill : "";
  if (skillField) {
    const name = bareAgentName(skillField);
    return PIPELINE_COMMANDS.has(name) ? name : "";
  }

  const pathField =
    (typeof toolInput.TargetFile === "string" && toolInput.TargetFile) ||
    (typeof toolInput.AbsolutePath === "string" && toolInput.AbsolutePath) ||
    (typeof toolInput.file_path === "string" && toolInput.file_path) ||
    (typeof toolInput.filePath === "string" && toolInput.filePath) ||
    (typeof toolInput.path === "string" && toolInput.path) ||
    "";
  if (pathField) {
    const fromPath = pipelineCommandInText(pathField);
    if (fromPath) return fromPath;
  }

  const command =
    (typeof toolInput.CommandLine === "string" && toolInput.CommandLine) ||
    (typeof toolInput.command === "string" && toolInput.command) ||
    "";
  return command ? pipelineCommandInText(command) : "";
}

// UserPromptExpansion's payload has no tool_input — it carries expansion_type
// ("slash_command" | "mcp_prompt") and command_name (the typed name, prefix included).
function pipelineCommandFromExpansion(hookInput) {
  if (hookInput.expansion_type !== "slash_command") return "";
  const commandName = typeof hookInput.command_name === "string" ? hookInput.command_name : "";
  if (!commandName) return "";
  // Claude passes the command's own name ("ultracode:orchestrate"); a leading
  // slash comes off first so the typed form resolves the same.
  const name = bareAgentName(commandName.replace(/^\/+/, ""));
  return PIPELINE_COMMANDS.has(name) ? name : "";
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
  const expansion = hookInput.hook_event_name === "UserPromptExpansion";

  const toolInput = expansion ? null : hookToolInput(hookInput);
  if (!expansion && (!toolInput || typeof toolInput !== "object")) return 0;
  const command = expansion
    ? pipelineCommandFromExpansion(hookInput)
    : pipelineCommandFromToolInput(toolInput);
  if (!command) return 0;

  const info = pluginTargetInfo();
  if (!info) return 0;

  const repoRoot = resolveRepoRoot(hookInput, "");
  // The inventory check is orchestrate's: hub-listen runs the work another
  // session already planned, and its own Step 1 refuses an uninitialized repo.
  const reason = command === "orchestrate" ? missingInventoryReason(repoRoot, info) : null;
  if (reason) {
    if (expansion) denyUserPromptExpansion(reason);
    else denyPreToolUse(reason);
    return 0;
  }

  recordPipelineSession(info.target, hookSessionId(hookInput), command);
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
