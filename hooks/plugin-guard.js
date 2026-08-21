#!/usr/bin/env node
// Hard-enforce that ultracode's own installed code is never run, loaded, or
// modified by a model-issued tool call, and that an interpreter's inline code is
// not used as an unwatched write channel. See hooks/lib/plugin-policy.js for the
// threat this closes and the exact rules; this file is only the hook wiring.
//
// Reads a PreToolUse hook payload from stdin, registered on both the Bash family
// (Bash / run_command / run_terminal_command) and the write family (Write / Edit
// / write_to_file / …), and handles whichever shape arrives:
//
//   * a command  -> plugin-code execution + opaque interpreter channel
//   * a path     -> plugin-tree tamper, plus the ledger policy applied to the
//                   write targets a shell command names (which artifact-guard.js
//                   already applies to Write/Edit and bash-scope-guard.js to
//                   Bash — repeated here so the plugin rules and the ledger
//                   rules deny at the same point, in the same message)
//
// Applies to EVERY caller, subagent and orchestrator alike: the recorded bypass
// this exists for was the orchestrator's own, and the orchestrator is the one
// caller no per-agent scope confines.

"use strict";

const {
  readHookInput,
  denyPreToolUse,
  hookToolInput,
  resolvePathCandidate,
} = require("./lib/common");
const {
  checkPluginCommand,
  checkPluginWrite,
  checkOpaqueWriteChannel,
} = require("./lib/plugin-policy");
const { extractWriteTargets } = require("./lib/shell-paths");

function commandFrom(toolInput) {
  const value = toolInput && (toolInput.CommandLine || toolInput.command || toolInput.Command);
  return typeof value === "string" ? value : "";
}

function filePathFrom(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  for (const key of ["TargetFile", "AbsolutePath", "file_path", "filePath", "path", "Path"]) {
    if (typeof toolInput[key] === "string" && toolInput[key].trim()) return toolInput[key].trim();
  }
  return "";
}

// The directory a shell command's relative paths resolve against: what the tool
// call asked for, else the harness's reported cwd, else this process's.
function commandCwd(hookInput, toolInput) {
  for (const source of [toolInput, hookInput]) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["Cwd", "cwd", "workspaceRoot", "workspace_root"]) {
      if (typeof source[key] === "string" && source[key].trim()) return source[key].trim();
    }
  }
  return process.cwd();
}

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  const toolInput = hookToolInput(hookInput);
  if (!toolInput || typeof toolInput !== "object") return 0;

  const filePath = filePathFrom(toolInput);
  if (filePath) {
    const cwd = commandCwd(hookInput, toolInput);
    const write = checkPluginWrite(resolvePathCandidate(cwd, filePath));
    if (!write.allowed) {
      denyPreToolUse(`ultracode: refusing this write — ${write.reason}`);
      return 0;
    }
  }

  const command = commandFrom(toolInput);
  if (!command) return 0;
  const cwd = commandCwd(hookInput, toolInput);

  const execution = checkPluginCommand(command, cwd);
  if (!execution.allowed) {
    denyPreToolUse(`ultracode: refusing this command — ${execution.reason}`);
    return 0;
  }

  const channel = checkOpaqueWriteChannel(command);
  if (!channel.allowed) {
    denyPreToolUse(`ultracode: refusing this command — ${channel.reason}`);
    return 0;
  }

  for (const candidate of extractWriteTargets(command)) {
    const write = checkPluginWrite(resolvePathCandidate(cwd, candidate));
    if (!write.allowed) {
      denyPreToolUse(
        `ultracode: refusing this command — it writes, moves, or deletes ${write.reason}`,
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
