#!/usr/bin/env node
// Shared policy that makes ultracode's own installed code un-runnable and
// un-writable from a model-issued tool call, on every harness.
//
// The threat this closes was demonstrated in a real Antigravity session: the
// pipeline's write guards (artifact-guard.js, bash-scope-guard.js, and the
// ledger policy behind both) all reason about *paths named in a tool call*, so
// the orchestrator route around them was simply to stop naming the path and run
// ultracode's own privileged code instead —
//
//   run_command  node <plugin>/mcp/gate-server.js
//   run_command  node -e "require('<plugin>/hooks/lib/common.js')
//                           .writeJsonAtomic('<session>/factcheck.json', {...})"
//   run_command  node -e "require('<plugin>/mcp/lib/gate.js')
//                           .recordGateDecision('<session>', 'spec', 'approved')"
//
// The first two calls forged a fact-check PASS the fact-check agent never
// returned; the third recorded its own spec approval. Every one of them was a
// plain Bash-family tool call with no protected path anywhere in an argument
// position, so no existing hook had anything to match on.
//
// Two independent rules, both applying to EVERY caller — subagents and the
// orchestrator alike, because the orchestrator is the caller that did this:
//
//   1. A plugin tree is read-only and non-executable. Reading ultracode's own
//      source is legitimate (debugging a denial, quoting a rule), so plain
//      readers stay allowed by name; anything else that so much as mentions a
//      path inside a plugin tree is denied — running it, loading it, patching
//      it, chmod-ing it, deleting it.
//   2. An interpreter fed inline code (`node -e`, `python3 -c`, a heredoc, a
//      pipe) is an opaque write channel: hooks/lib/shell-paths.js can see
//      `> file` and `rm file`, but not `fs.writeFileSync` inside a JS string.
//      Such a body is denied when it writes files, spawns processes, or names a
//      pipeline ledger — the three things that would otherwise let arbitrary
//      code do what the guarded tools may not.
//
// A plugin tree is identified by the marker files the generator emits into every
// generated plugin (`hooks/model-routing.json` + `hooks/lib/common.js`), not by
// a hardcoded install path — so this holds for Claude Code, Codex, Grok, and
// Antigravity, for a copy installed anywhere, and it deliberately does NOT fire
// in ultracode's own source checkout, where `hooks/model-routing.json` does not
// exist and running `node hooks/<hook>.js` by hand is normal development.

"use strict";

const path = require("node:path");
const { isFile, isInside, pluginRootFromEnv, resolvePathCandidate } = require("./common");
const { ledgerNamePattern } = require("./ledger-policy");
const { splitSegments, tokenize, stripQuotes } = require("./shell-paths");

// Present in every tree scripts/generate_definitions.js emits, and in no source
// checkout — model-routing.json is generated per harness, never committed.
const PLUGIN_MARKERS = [
  ["hooks", "model-routing.json"],
  ["hooks", "lib", "common.js"],
];

const MAX_ANCESTOR_WALK = 30;

// Commands that can only read what they are pointed at. Everything absent from
// this set is treated as capable of running or changing the file, which is the
// safe default: a new tool the model reaches for is denied, not allowed.
const READ_ONLY_COMMANDS = new Set([
  "cat",
  "bat",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "ls",
  "find",
  "fd",
  "tree",
  "stat",
  "wc",
  "file",
  "du",
  "cksum",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "diff",
  "cmp",
  "jq",
  "yq",
  "cut",
  "tr",
  "sort",
  "uniq",
  "strings",
  "xxd",
  "od",
  "readlink",
  "realpath",
  "dirname",
  "basename",
  "test",
  "true",
  "echo",
  "printf",
  "sed", // only without -i; checked below
]);

// Stripped before the command word is read, so `sudo node x.js` and
// `timeout 5 node x.js` are judged on `node`, not on the wrapper.
const WRAPPER_COMMANDS = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "nice",
  "ionice",
  "stdbuf",
  "time",
  "timeout",
  "command",
  "exec",
  "xargs",
  "strace",
  "watch",
]);

const INTERPRETERS =
  "node|nodejs|bun|deno|ts-node|tsx|python|python2|python3|perl|ruby|php|Rscript|osascript";

// `node -e`, `python3 -c`, `perl -E`, `deno eval`, … — code handed to an
// interpreter as an argument rather than as a file the guards can see.
const INLINE_EVAL_PATTERN = new RegExp(
  `(?:^|[\\s;&|(])(?:${INTERPRETERS})\\b(?:\\s+-{0,2}[\\w=.-]+)*?\\s+(?:-e|-E|--eval|-c|--command|-p|--print|-r|--exec|eval)\\b`,
  "i",
);

// Same channel, fed through stdin: a heredoc (`python3 - <<'PY'`) or a pipe
// (`echo '…' | node`). Both leave no script path in the command either.
const HEREDOC_PATTERN = new RegExp(`(?:${INTERPRETERS})\\b[^\\n;&|]*<<-?\\s*['"\`]?\\w+`, "i");
const PIPED_INTERPRETER_PATTERN = new RegExp(
  `\\|\\s*(?:(?:${[...WRAPPER_COMMANDS].join("|")})\\s+)*(?:${INTERPRETERS})\\b\\s*(?:-\\s*)?(?:$|[;&|])`,
  "i",
);

const WRITE_API_PATTERN =
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|writeJsonAtomic|copyFileSync|copyFile|renameSync|rename|unlinkSync|unlink|rmSync|rmdirSync|mkdirSync|mkdtempSync|truncateSync|ftruncate|chmodSync|utimesSync|write_text|write_bytes|writelines|shutil\.|os\.remove|os\.unlink|os\.rename|os\.replace|os\.mkdir|os\.makedirs|os\.rmdir|os\.chmod|Deno\.writeTextFile|Deno\.writeFile|Deno\.remove|File\.write|IO\.write|FileUtils\.|file_put_contents|fopen)\b/;
// `open(path, "w")` / `open(path, 'a')` in Python, spelled either order.
const PYTHON_OPEN_WRITE_PATTERN = /\bopen\s*\([^)]*['"][rbt]*[wax][rbt+]*['"]/;
const SPAWN_API_PATTERN =
  /\b(?:child_process|execSync|execFileSync|spawnSync|execFile|subprocess|os\.system|os\.popen|popen|Deno\.Command|Deno\.run|Kernel#system|Process\.spawn|shell_exec|passthru|proc_open)\b/;

function isPluginTreeRoot(dir) {
  return PLUGIN_MARKERS.every((parts) => isFile(path.join(dir, ...parts)));
}

// True when `absPath` is the running plugin itself or sits inside any generated
// ultracode plugin tree — including one belonging to a different harness, which
// is exactly what the recorded bypass reached for (a Claude-side session can run
// the Antigravity-side copy, and vice versa).
function isPluginPath(absPath) {
  if (!absPath) return false;
  const target = path.resolve(absPath);
  if (isInside(pluginRootFromEnv(), target)) return true;
  let dir = target;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth += 1) {
    if (isPluginTreeRoot(dir)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

// Path-ish tokens worth resolving. Prefiltered so an ordinary build command does
// no filesystem work at all: a plugin-internal path either carries the plugin
// directory name or is a relative reference into the plugin's own layout.
function looksPluginish(token) {
  if (!token.includes("/")) return false;
  return /ultracode/i.test(token) || /(?:^|[^\w./])(?:\.{0,2}\/)?(?:hooks|mcp)\//.test(token);
}

// Every substring of `text` that could name a file, quotes stripped — run over
// whole command text (not just argv tokens) so a path buried inside an inline
// eval body or a require() call is seen too.
function pathCandidates(text) {
  const found = new Set();
  const pattern = /[~\w./@-]*\/[~\w./@-]+/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const token = stripQuotes(match[0]).replace(/[),;:'"`]+$/, "");
    if (token) found.add(token);
  }
  return [...found];
}

// Plugin-internal paths named anywhere in `text`, resolved against the shell's
// cwd — which is the cwd the tool call itself declares, so a call that runs
// `./hooks/<hook>.js` from inside the plugin directory resolves there and is
// caught. Reaching that directory first (`cd <plugin> && node ./hooks/x.js`) is
// caught too: the `cd` segment names the plugin path with a non-reader.
function pluginPathsIn(text, cwd) {
  const hits = [];
  for (const candidate of pathCandidates(text)) {
    if (!looksPluginish(candidate)) continue;
    if (isPluginPath(resolvePathCandidate(cwd, candidate))) hits.push(candidate);
  }
  return hits;
}

// The command word a segment actually runs, with wrappers and leading
// `VAR=value` assignments stripped, and any directory part dropped.
function effectiveCommandWord(tokens) {
  for (const raw of tokens) {
    const token = stripQuotes(raw);
    if (!token || /^[A-Za-z_][\w]*=/.test(token)) continue;
    const word = token.replace(/^.*\//, "");
    if (WRAPPER_COMMANDS.has(word)) continue;
    if (word.startsWith("-")) continue;
    return word;
  }
  return "";
}

function isReadOnlySegment(tokens) {
  const word = effectiveCommandWord(tokens);
  if (!READ_ONLY_COMMANDS.has(word)) return false;
  // `sed -i` edits in place, and `sed 'w file'` writes — neither is a read.
  if (word === "sed") {
    return !tokens.some((token) => /^-[a-zA-Z]*i/.test(stripQuotes(token)));
  }
  return true;
}

const PLUGIN_TREE_RULE =
  "ultracode's installed plugin tree is read-only and never executed from a tool call: its hooks and " +
  "its ultracode_gate MCP server are the things that enforce the pipeline, so running or editing them " +
  "from inside the pipeline would let a caller grant itself whatever the guards exist to withhold. " +
  "Reading these files is fine (cat/grep/head); running, loading, patching, or deleting them is not. " +
  "If a hook or the gate tool is behaving wrongly, say so and let the user fix the plugin — do not " +
  "reach around it.";

// Denies running, loading, or modifying plugin-internal code from a shell
// command. Returns { allowed: true } or { allowed: false, reason }.
function checkPluginCommand(command, cwd) {
  if (!command) return { allowed: true };
  for (const segment of splitSegments(command)) {
    const hits = pluginPathsIn(segment, cwd);
    if (hits.length === 0) continue;
    if (isReadOnlySegment(tokenize(segment))) continue;
    return {
      allowed: false,
      reason:
        `this command touches ultracode's own plugin code ("${hits[0]}") with something other than a ` +
        `plain reader. ${PLUGIN_TREE_RULE}`,
    };
  }
  return { allowed: true };
}

// Denies a write/move/delete whose target is inside a plugin tree, for callers
// that name the path outright (Write/Edit, `rm`, `>`, `sed -i`, …).
function checkPluginWrite(absPath) {
  if (!isPluginPath(absPath)) return { allowed: true };
  return {
    allowed: false,
    reason: `"${absPath}" is inside ultracode's installed plugin tree. ${PLUGIN_TREE_RULE}`,
  };
}

// Classifies the inline-code channel a command uses, if any.
function inlineCodeChannel(command) {
  if (INLINE_EVAL_PATTERN.test(command)) return "inline code (`-e`/`-c`/`eval`)";
  if (HEREDOC_PATTERN.test(command)) return "a heredoc";
  if (PIPED_INTERPRETER_PATTERN.test(command)) return "piped stdin";
  return null;
}

// Denies interpreter-eval bodies that write, spawn, or name pipeline state. A
// body that only reads or prints is left alone: `node -e "console.log(...)"`
// stays a legitimate way to inspect something.
function checkOpaqueWriteChannel(command) {
  if (!command) return { allowed: true };
  const channel = inlineCodeChannel(command);
  if (!channel) return { allowed: true };

  const ledger = command.match(ledgerNamePattern());
  if (ledger) {
    return {
      allowed: false,
      reason:
        `this command hands an interpreter ${channel} that names "${ledger[0]}" — pipeline state whose one ` +
        "legitimate author is the hook or tool that observes the underlying work. Code passed to an " +
        "interpreter this way is invisible to ultracode's write guards, so a value written from here would " +
        "forge a pipeline decision rather than record one. Do the work that makes the file update itself.",
    };
  }
  if (WRITE_API_PATTERN.test(command) || PYTHON_OPEN_WRITE_PATTERN.test(command)) {
    return {
      allowed: false,
      reason:
        `this command hands an interpreter ${channel} that writes to the filesystem. That channel is opaque ` +
        "to ultracode's write guards — they read the paths a tool call names, and there are none here — so " +
        "it is not an allowed way to create or change a file. Use the Write/Edit tool, or a plain shell " +
        "redirect naming the path, so the write is visible to the same rules as every other write.",
    };
  }
  if (SPAWN_API_PATTERN.test(command)) {
    return {
      allowed: false,
      reason:
        `this command hands an interpreter ${channel} that spawns another process. A spawned child is not ` +
        "seen by ultracode's tool hooks at all, so this is a way to run anything unobserved. Run the " +
        "command you actually want directly, as its own tool call.",
    };
  }
  return { allowed: true };
}

module.exports = {
  READ_ONLY_COMMANDS,
  isPluginPath,
  pluginPathsIn,
  checkPluginCommand,
  checkPluginWrite,
  checkOpaqueWriteChannel,
  inlineCodeChannel,
};
