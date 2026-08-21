#!/usr/bin/env node
// Shared build/test signal extraction for hooks/build-streak.js (PostToolUse,
// counts) and hooks/build-streak-gate.js (PreToolUse, denies). One source of
// truth so the hook that counts a failure and the hook that acts on the count
// can never disagree about what a build command is.
//
// Three jobs:
//
//   1. isBuildCommand — is this Bash call a build/test invocation? Driven by the
//      repo's OWN repo-profile.json `commands` / `testTypes` strings rather than
//      a guessed regex, so it is exact per repo. Placeholders ({MODULE}, {TEST},
//      {PATH}) become wildcards. A conservative well-known-tool fallback covers
//      repos with no profile yet (a repo mid-/init-kit still deserves the guard).
//
//   2. failedFrom — did it fail? Claude Code does not put an exit code in the
//      PostToolUse `tool_response` object for a successful call ({ stdout,
//      stderr, interrupted, isImage, noOutputExpected }), but a FAILED Bash call
//      surfaces as is_error with the result text prefixed "Exit code N". That
//      prefix is the harness's own report and is toolchain-agnostic, so it is
//      preferred over output sniffing. Marker matching is a documented fallback
//      for the compound-command case (`cmd 2>&1 | tee`, `set +e`) where a real
//      failure still exits 0.
//
//   3. diagnosticSignature — a normalized one-line fingerprint of WHY it failed,
//      stable across runs and repos (paths, line/column numbers, and version
//      numbers stripped). This is the recall key and the lesson key: the same
//      root cause hit in a later session produces the same signature, which is
//      what lets a recorded lesson be found again.

"use strict";

// Purposes in repo-profile.json `commands` that represent compiling or testing.
// format/lint/typecheck count too: they gate the same "is my change valid" loop.
const BUILD_PURPOSES = new Set([
  "build",
  "test",
  "testOne",
  "integrationTest",
  "integrationTestOne",
  "format",
  "lint",
  "typecheck",
]);

// Only used when the repo has no repo-profile.json yet. Deliberately narrow:
// a false positive here would start counting failures against an unrelated
// command, so this lists build drivers only, never generic shell utilities.
const FALLBACK_BUILD = new RegExp(
  "(^|[\\s|;&(])(" +
    [
      "\\./mvnw",
      "mvn",
      "\\./gradlew",
      "gradle",
      "tsc",
      "cargo",
      "dotnet",
      "make",
      "pytest",
      "go\\s+(build|test|vet)",
      "npm\\s+run\\s+\\S+",
      "npm\\s+(test|run-script)",
      "pnpm\\s+(test|run|build)",
      "yarn\\s+(test|run|build)",
      "uv\\s+run\\s+(pytest|mypy|ruff)",
      "python\\s+-m\\s+(pytest|mypy|unittest)",
    ].join("|") +
    ")\\b",
);

function commandStringsFromProfile(profile) {
  const out = [];
  if (!profile || typeof profile !== "object") return out;
  const commands = profile.commands;
  if (commands && typeof commands === "object") {
    for (const [purpose, value] of Object.entries(commands)) {
      if (!BUILD_PURPOSES.has(purpose)) continue;
      if (typeof value === "string" && value.trim()) out.push({ purpose, command: value.trim() });
    }
  }
  // testTypes.<name>.{command,commandOne} — richer per-runner strings that a
  // repo may carry instead of, or alongside, the flat `commands` block.
  const testTypes = profile.testTypes;
  if (testTypes && typeof testTypes === "object") {
    for (const [name, entry] of Object.entries(testTypes)) {
      if (!entry || typeof entry !== "object") continue;
      for (const key of ["command", "commandOne"]) {
        const value = entry[key];
        if (typeof value === "string" && value.trim()) {
          out.push({ purpose: `test:${name}`, command: value.trim() });
        }
      }
    }
  }
  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A configured command becomes a matcher by treating {PLACEHOLDER} tokens as
// wildcards and allowing flexible whitespace, so `./mvnw test -Ptest -pl {MODULE}
// -am -Dtest={TEST}` still matches the concrete invocation the agent ran.
function commandMatcher(configured) {
  const parts = configured.split(/\{[A-Za-z_][A-Za-z0-9_]*\}/g);
  const pattern = parts
    .map((part) => escapeRegExp(part.trim()).replace(/\\ +/g, "\\s+").replace(/ +/g, "\\s+"))
    .filter(Boolean)
    .join("[\\s\\S]*?");
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

// Returns { build: boolean, purpose: string|null }.
function isBuildCommand(command, profile) {
  const text = String(command || "");
  if (!text.trim()) return { build: false, purpose: null };

  const configured = commandStringsFromProfile(profile);
  for (const { purpose, command: candidate } of configured) {
    const matcher = commandMatcher(candidate);
    if (matcher && matcher.test(text)) return { build: true, purpose };
  }
  // Also match on the driver head of a configured command ("./mvnw", "uv run
  // pytest"): agents legitimately vary flags (-pl, -Dtest, -q) around the same
  // build tool, and those variants are still the same build loop.
  for (const { purpose, command: candidate } of configured) {
    const head = candidate.split(/\s+/).slice(0, 2).join(" ");
    if (head.length > 2 && text.includes(head)) return { build: true, purpose };
  }
  if (!configured.length && FALLBACK_BUILD.test(text)) {
    return { build: true, purpose: "unprofiled" };
  }
  return { build: false, purpose: null };
}

// Failure markers, used only when no explicit exit code is available.
const FAILURE_MARKERS = [
  /BUILD FAILURE/i,
  /BUILD FAILED/i,
  /Compilation failure/i,
  /COMPILATION ERROR/i,
  /\bFAILURES!+/,
  /Tests? run:.*?(?:Failures|Errors):\s*[1-9]/i,
  /\b\d+ failed\b/i,
  /^\s*FAIL\b/m,
  /npm ERR!/,
  /error TS\d+/,
  /^error(\[E\d+\])?:/m,
  /\bmypy\b.*\berror\b/i,
  /Traceback \(most recent call last\)/,
  /=+ FAILURES =+/,
  /spotless.*violations/i,
];

function responseText(toolResponse) {
  if (toolResponse == null) return "";
  if (typeof toolResponse === "string") return toolResponse;
  if (typeof toolResponse !== "object") return "";
  const pieces = [];
  for (const key of ["result", "stdout", "stderr", "output", "content"]) {
    const value = toolResponse[key];
    if (typeof value === "string" && value) pieces.push(value);
  }
  return pieces.join("\n");
}

// Each harness reports the exit status in its own words. Claude Code prefixes a
// failed call's result text "Exit code N"; Antigravity's transcript says "The
// command exited with code N" and its hook payload carries `error: "exit status
// N"`. All three are the harness's own report, so all three are read here rather
// than left to output sniffing.
const EXIT_CODE_PATTERNS = [
  /^\s*Exit code (\d+)/m,
  /\bexited with code (\d+)/i,
  /\bexit status (\d+)/i,
];

function exitCodeFrom(text) {
  for (const pattern of EXIT_CODE_PATTERNS) {
    const match = String(text || "").match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

// Returns { failed: boolean, exitCode: number|null, text: string }.
function failedFrom(toolResponse, hookInput) {
  const text = responseText(toolResponse);
  // AGY states failure in the payload's `error` ("exit status 1"), with no result
  // object anywhere; a hook that only read `toolResponse` counted no failures at
  // all there.
  const hookError =
    hookInput && typeof hookInput.error === "string" && hookInput.error.trim()
      ? hookInput.error
      : "";

  // A timed-out/interrupted call is not evidence the code is wrong, so it
  // neither counts as a failure nor clears an existing streak.
  const interrupted =
    (toolResponse && typeof toolResponse === "object" && toolResponse.interrupted === true) ||
    /\b(timed out|interrupted|canceled|cancelled)\b/i.test(hookError);
  if (interrupted) return { failed: null, exitCode: null, text };

  const exitCode = exitCodeFrom(text) ?? exitCodeFrom(hookError);
  if (exitCode !== null) {
    return { failed: exitCode !== 0, exitCode, text };
  }

  const explicitError =
    (toolResponse && typeof toolResponse === "object" &&
      (toolResponse.isError === true || toolResponse.is_error === true)) ||
    (hookInput && (hookInput.isError === true || hookInput.is_error === true)) ||
    Boolean(hookError);
  if (explicitError) return { failed: true, exitCode: null, text };

  if (FAILURE_MARKERS.some((marker) => marker.test(text))) {
    return { failed: true, exitCode: null, text };
  }
  return { failed: false, exitCode: null, text };
}

// Diagnostic lines worth fingerprinting — a real complaint from a compiler,
// type checker, linter or test runner, not a banner or a progress line.
const DIAGNOSTIC = new RegExp(
  [
    "cannot find symbol",
    "does not exist",
    "incompatible type",
    "argument lists differ",
    "is not assignable",
    "no suitable method",
    "has private access",
    "unreported exception",
    "duplicate class",
    "cannot be applied",
    "Unresolved reference",
    "Cannot resolve",
    "error TS\\d+",
    "error\\[E\\d+\\]",
    "AssertionError",
    "NullPointerException",
    "IllegalStateException",
    "IllegalArgumentException",
    "UnsatisfiedDependency",
    "NoSuchBean",
    "BeanCreation",
    "ImportError",
    "ModuleNotFoundError",
    "AttributeError",
    "TypeError",
    "NameError",
    "violations",
    "expected .{0,40} but",
  ].join("|"),
  "i",
);

function normalizeDiagnostic(line) {
  return line
    .replace(/^\s*\[?(ERROR|WARN|E|FAIL)\]?\s*/i, "")
    .replace(/\/[\w.@/-]+/g, "<path>")
    .replace(/\[\d+[,:]\d+\]/g, "")
    .replace(/:\d+(?::\d+)?/g, "")
    .replace(/\b\d[\d.]{2,}\b/g, "<v>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// The first real diagnostic in the output, normalized. Null when the output
// carries no recognizable complaint (a bare nonzero exit, say) — callers must
// treat a null signature as "unknown cause", never as a match against anything.
function diagnosticSignature(text) {
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length < 12 || trimmed.length > 400) continue;
    if (!DIAGNOSTIC.test(trimmed)) continue;
    const normalized = normalizeDiagnostic(trimmed);
    if (normalized.length >= 8) return normalized;
  }
  return null;
}

module.exports = {
  BUILD_PURPOSES,
  isBuildCommand,
  failedFrom,
  exitCodeFrom,
  diagnosticSignature,
  normalizeDiagnostic,
  responseText,
  commandMatcher,
};
