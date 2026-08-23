#!/usr/bin/env node
// Best-effort extraction of filesystem paths a shell command would create,
// overwrite, move into, or delete: output redirection (`>`, `>>`, `N>`, `&>`,
// `>|`), `tee`, `rm`, `mv`, `cp`, `truncate`, `shred`, `sed -i`, and `dd of=`.
//
// This is NOT a shell parser — it is the same "good enough" regex/tokenizing
// heuristic hooks/bash-guard.js already uses for its own pattern list. It
// catches the plain, common ways a subagent would write outside its scope; it
// does not try to defeat deliberate obfuscation (command substitution, base64
// round-trips, exotic quoting). Tokens containing `$`, backticks, globs, or
// brace expansion are skipped rather than guessed at, to avoid false-denying
// ordinary commands that use a shell variable for an in-scope path.

"use strict";

const IGNORED_TOKENS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "&1", "&2", "-"]);
const DESTRUCTIVE_COMMANDS = new Set(["rm", "mv", "cp", "truncate", "shred"]);

// Commands that EXECUTE a heredoc body instead of storing it: `bash <<EOF`
// runs the body's `rm …` lines, so those bodies must stay visible to the scan.
// Interpreter bodies stay too — hooks/lib/plugin-policy.js reads the raw
// command text for its write/spawn patterns, and dropping the body here would
// be a second, disagreeing reading of the same command.
const BODY_EXECUTING_COMMANDS =
  /^(?:sh|bash|zsh|dash|ksh|fish|node|nodejs|bun|deno|ts-node|tsx|python[23]?|perl|ruby|php|Rscript|osascript)$/i;

const HEREDOC_WRAPPERS = new Set([
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
]);

// `<<WORD`, `<<-WORD`, `<<'WORD'` — but not the `<<` inside a `<<<` here-string.
const HEREDOC_START = /(?<!<)<<(-?)\s*(["'`]?)(\w+)\2/g;

function stripQuotes(token) {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function looksDynamic(token) {
  return /[$`*?[\]{}]/.test(token);
}

function candidatePaths(rawToken) {
  const cleaned = stripQuotes(rawToken.trim());
  if (!cleaned || IGNORED_TOKENS.has(cleaned) || looksDynamic(cleaned)) return [];
  // A dot-only token is prose, not a path: markdown's `--> ...` reads as a
  // redirect into "...", which denied a plan write for a file it never named.
  if (/^\.+$/.test(cleaned)) return [];
  return [cleaned];
}

// True when any command in `line` would execute a heredoc body handed to it —
// either as the heredoc's own command (`bash <<EOF`) or downstream of a pipe
// (`cat <<EOF | bash`).
function lineExecutesHeredocBody(line) {
  for (const segment of line.split(/&&|\|\||[;|]/)) {
    for (const raw of tokenize(segment)) {
      const token = stripQuotes(raw);
      if (!token || /^[A-Za-z_]\w*=/.test(token) || token.startsWith("-")) continue;
      const word = token.replace(/^.*\//, "");
      if (HEREDOC_WRAPPERS.has(word)) continue;
      if (BODY_EXECUTING_COMMANDS.test(word)) return true;
      break;
    }
  }
  return false;
}

// A heredoc body handed to a data sink (`cat > "$f" <<'EOF' … EOF`) is file
// content, not shell — yet splitSegments treats its lines as commands, so a
// body line of markdown prose (`<!-- AWS START --> ...`) read as a redirect
// into "..." and denied a plan agent's legitimate session-artifact write. Drop
// such bodies before extraction; the redirect target on the command line
// itself stays visible. Bodies fed to a shell or interpreter are kept — those
// lines really do run. An unmatched `<<` in quoted prose hides the rest of the
// command, which fails open like every other dynamic token here.
function stripHeredocBodies(command) {
  if (!command.includes("<<")) return command;
  const kept = [];
  const pending = [];
  let active = null; // { word, allowTabs, keepBody }
  for (const line of command.split("\n")) {
    if (active) {
      if (active.keepBody) kept.push(line);
      const check = active.allowTabs ? line.replace(/^\t+/, "") : line;
      if (check === active.word) active = pending.shift() || null;
      continue;
    }
    kept.push(line);
    HEREDOC_START.lastIndex = 0;
    let match;
    while ((match = HEREDOC_START.exec(line))) {
      pending.push({
        word: match[3],
        allowTabs: match[1] === "-",
        keepBody: lineExecutesHeredocBody(line),
      });
    }
    if (pending.length) active = pending.shift();
  }
  return kept.join("\n");
}

function splitSegments(command) {
  return command
    .split(/&&|\|\||[;\n|]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function tokenize(segment) {
  return segment.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
}

function targetsFromSegment(segment) {
  const targets = [];

  // `[^<>]` before the operator keeps `2>&1`-style and heredoc text out. The
  // placeholder guard below covers the other direction: prose inside a command —
  // a spawn prompt, an echoed instruction — routinely contains `<NAME>`, and
  // `...session-<ID>/factcheck.json` read as "redirect into /factcheck.json",
  // which denied a legitimate command for a write it never made.
  const redirectPattern = /(^|[^<>])(\d*>{1,2}\|?|&>{1,2})\s*(\S+)/g;
  let match;
  while ((match = redirectPattern.exec(segment))) {
    const beforeOperator = segment.slice(0, match.index + match[1].length);
    if (/<[A-Za-z_][\w.-]*$/.test(beforeOperator)) continue; // closing `<NAME>`, not a redirect
    targets.push(...candidatePaths(match[3]));
  }

  const tokens = tokenize(segment);
  if (tokens.length === 0) return targets;
  const command = tokens[0].replace(/^.*\//, "");

  if (command === "tee") {
    for (const token of tokens.slice(1)) {
      if (token.startsWith("-")) continue;
      targets.push(...candidatePaths(token));
    }
  } else if (DESTRUCTIVE_COMMANDS.has(command)) {
    for (const token of tokens.slice(1)) {
      if (token.startsWith("-")) continue;
      targets.push(...candidatePaths(token));
    }
  } else if (command === "sed" && tokens.some((token) => /^-[a-zA-Z]*i/.test(token))) {
    for (const token of tokens.slice(1)) {
      if (token.startsWith("-")) continue;
      targets.push(...candidatePaths(token));
    }
  } else if (command === "dd") {
    for (const token of tokens.slice(1)) {
      const of = token.match(/^of=(.+)$/);
      if (of) targets.push(...candidatePaths(of[1]));
    }
  }

  return targets;
}

function extractWriteTargets(command) {
  const targets = [];
  for (const segment of splitSegments(stripHeredocBodies(command))) {
    targets.push(...targetsFromSegment(segment));
  }
  return targets;
}

// splitSegments/tokenize/stripQuotes are exported for hooks/lib/plugin-policy.js,
// which needs the same "good enough" shell reading to decide what a segment runs
// — one heuristic shared by both, rather than a second copy that drifts.
module.exports = { extractWriteTargets, splitSegments, tokenize, stripQuotes };
