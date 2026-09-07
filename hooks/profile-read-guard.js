#!/usr/bin/env node
// Keeps repo-profile.json out of a pipeline session's own context.
//
// The profile is configuration for the hook layer: `models` decides which model
// each spawn runs on, `harnesses` decides which harness runs each stage, and
// both are resolved per spawn by hooks/model-router.js and per publish by the
// hub. An orchestrator that reads the file instead re-decides routing from a
// snapshot: it kept work local because a route "looked local", and it turned
// one stage's route into a rule for the next. Everything else it needs from the
// repo is in INVENTORY.md (commands, skills, module map, review rules), and its
// subagents get a resolved brief injected into their spawn prompts
// (hooks/lib/context-brief.js).
//
// Scope, in three conditions, all required:
//   * the caller is the primary session, not a subagent — an agent whose prompt
//     sends it to the profile for a table the brief omits still gets there;
//   * the session loaded orchestrate or hub-listen (lib/pipeline-session.js) —
//     an ordinary session reading its own config is not this hook's business;
//   * the path is a repo-profile.json.
//
// Registered on the read tool and on the shell, because on codex reading IS a
// shell call (definitions/tool-mapping.json maps the `read` capability to
// exec_command there).
//
// ON THE SHELL, THE RULE IS THE PATH, NOT A LIST OF COMMANDS
//
// The first version of this guard listed readers (cat, head, jq, grep, …). An
// allowlist of commands can only ever be behind: `bat`, `xxd`, `git show
// HEAD:path`, `perl -pe`, a pipe into anything, an input redirect, and every
// command not yet installed all read the same bytes. So the shell rule matches
// the PATH wherever it appears in the command and refuses. One carve-out, for
// the only honest false positive: the file name used as a search PATTERN
// (`grep -rn repo-profile.json hooks/`) names no file to read.
//
// A shell write is refused too, which the tool channel already implied: Write
// and Edit require a prior read of an existing file, so a session that cannot
// read the profile cannot rewrite it either. The profile is the user's file. A
// route the pipeline wants changed goes to them as a key and a value.

"use strict";

const path = require("node:path");
const {
  commandFromToolInput,
  denyPreToolUse,
  generatedTarget,
  hookSessionId,
  readHookInput,
  writePathFromToolInput,
} = require("./lib/common");
const { HookContext } = require("./lib/hook-context");
const { isPipelineSession } = require("./lib/pipeline-session");
const { splitSegments, stripQuotes, tokenize } = require("./lib/shell-paths");

const PROFILE_FILE = "repo-profile.json";

function isProfilePath(candidate) {
  return Boolean(candidate) && path.basename(candidate.trim()) === PROFILE_FILE;
}

// Every path-like run of characters ending in repo-profile.json, wherever it
// sits: an argument, an input redirect, a redirect target, a git revision
// (`HEAD:.ultracode/repo-profile.json`), inside command substitution, inside a
// heredoc body. Shell metacharacters and quotes bound the run, so `$(cat
// .ultracode/repo-profile.json)` yields the path without the wrapper.
const PROFILE_TOKEN = /[^\s'"`;|&()<>]*repo-profile\.json\b/g;

// The commands whose first non-flag argument is a pattern or a program rather
// than a file. Only that argument is exempt, and only when the profile name is
// part of it: `grep -rn repo-profile.json hooks/` searches for the string,
// while `grep harnesses .ultracode/repo-profile.json` reads the file.
const PATTERN_FIRST = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ripgrep",
  "ag",
  "ack",
  "sed",
  "awk",
  "jq",
  "yq",
]);

function commandTouchesProfile(command) {
  for (const segment of splitSegments(command)) {
    const hits = segment.match(PROFILE_TOKEN);
    if (!hits) continue;

    const tokens = tokenize(segment).map((token) => stripQuotes(token));
    const start = tokens.findIndex((token) => !/^[A-Za-z_]\w*=/.test(token));
    const word = start >= 0 ? tokens[start].replace(/^.*\//, "") : "";
    if (PATTERN_FIRST.has(word)) {
      const args = tokens.slice(start + 1);
      const pattern = args.find((arg) => !arg.startsWith("-")) || "";
      // Exempt only when EVERY occurrence in this segment lives in that
      // pattern. A second occurrence is a file the same command would read.
      if (pattern && hits.every((hit) => pattern.includes(hit))) continue;
    }
    return true;
  }
  return false;
}

const DENIAL =
  `ultracode: refusing this call because it names ${PROFILE_FILE}. That file is routing configuration ` +
  "the hooks and the hub resolve themselves, per spawn and per publish, and a copy in your context only " +
  "lets you re-decide a route that is not yours to decide. This covers every way a shell command can " +
  "reach the bytes, not a list of readers: any command naming the path is refused, and so is a write. " +
  "Read INVENTORY.md instead for commands, skills, the module map, and the review rules. Every spawn " +
  "already comes back with the harness-routing outcome, and a stage that belongs elsewhere is refused " +
  "with the harness named. If the user wants a route changed, tell them the exact key and value to set " +
  "and let them edit the file.";

const COMPACT_DENIAL =
  `ultracode: refusing this call because it names ${PROFILE_FILE} — routing is resolved by the hooks ` +
  "and the hub, per spawn, and that file is the user's to edit. Read INVENTORY.md for commands, " +
  "skills, modules, and review rules.";

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  const context = new HookContext(hookInput);
  if (!context.toolInput) return 0;
  if (context.currentActor().agent) return 0;

  const target = generatedTarget() || context.target;
  if (!isPipelineSession(target, hookSessionId(hookInput))) return 0;

  if (isProfilePath(writePathFromToolInput(context.toolInput))) {
    denyPreToolUse(DENIAL, COMPACT_DENIAL);
    return 0;
  }

  const command = commandFromToolInput(context.toolInput);
  if (command && commandTouchesProfile(command)) {
    denyPreToolUse(DENIAL, COMPACT_DENIAL);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
