#!/usr/bin/env node
// Shared helpers for ultracode's PreToolUse/PostToolUse/SessionStart hooks.
//
// Deliberately does not touch hooks/model-router.js — that file has its own
// well-tested copies of a few of these helpers; this module is for every
// hook added after it, so a regression here cannot affect model routing.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { adapterFor, bareAgentName: normalizeAgentName } = require("./harness");

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

// Which harness this copy of the plugin was generated for, read from the routing
// file that sits beside this very file. Authoritative and environment-independent:
// the generator writes one per build, so the answer is a property of the plugin
// being run rather than a guess from whatever variables happen to be exported.
let generatedRoutingCache;
function generatedRouting() {
  if (generatedRoutingCache !== undefined) return generatedRoutingCache;
  generatedRoutingCache = null;
  const text = readTextIfFile(path.join(__dirname, "..", "model-routing.json"));
  if (!text) return generatedRoutingCache;
  try {
    const routing = JSON.parse(text);
    if (routing && typeof routing === "object" && !Array.isArray(routing)) {
      generatedRoutingCache = routing;
    }
  } catch {
    // Callers apply their existing environment/fail-open fallback.
  }
  return generatedRoutingCache;
}

function generatedTarget() {
  const routing = generatedRouting();
  return routing && typeof routing.target === "string" ? routing.target : null;
}

// Antigravity needs a different deny payload than Claude Code: it validates hook
// output against a proto and rejects unknown fields outright, so sending it the
// `hookSpecificOutput` shape does not merely get ignored — the whole response is
// discarded with "unknown field", and the guard fails open.
//
// The env sniffing below cannot answer this on its own. A nested session (running
// `agy` from inside a Claude Code turn, exactly what debugging these hooks looks
// like) inherits CLAUDE_CODE_SESSION_ID, which made this return false inside a
// real AGY run and every denial from that run was thrown away by protojson. So the
// generated target decides, and the env heuristic is only the fallback for a copy
// with no routing file.
function isAntigravity() {
  const target = generatedTarget();
  if (target) return target === "antigravity";
  if (
    process.env.CLAUDE_PLUGIN_ROOT ||
    process.env.GROK_PLUGIN_ROOT ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.GROK_SESSION_ID ||
    process.env.CODEX_THREAD_ID
  ) {
    return false;
  }
  return Boolean(
    process.env.ANTIGRAVITY_PLUGIN_ROOT ||
    process.env.AGY_PLUGIN_ROOT ||
    __dirname.includes("/antigravity/ultracode/hooks") ||
    __dirname.includes("/.gemini/config/plugins/ultracode/hooks")
  );
}

function isGrok() {
  const target = generatedTarget();
  if (target) return target === "grok";
  return Boolean(process.env.GROK_PLUGIN_ROOT || process.env.GROK_SESSION_ID);
}

function denyPreToolUse(reason) {
  // Antigravity and Grok honor a top-level decision. Claude/Codex honor
  // hookSpecificOutput.permissionDecision; a top-level "deny" there is not a
  // valid Claude decision value and can drop the whole payload.
  if (isAntigravity() || isGrok()) {
    emit({ decision: "deny", reason });
    return;
  }
  const payload = {
    reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
  emit(payload);
}

// Hands the decision to the user instead of making it in the hook: the harness
// prompts, and the call runs or not by their answer. For a gate that is a budget
// rather than a safety rule — the review-loop cap — a refusal the user cannot
// overturn is the wrong shape; a denial is still right for anything unwaivable.
//
// Verified live on 2026-08-23 against Claude Code 2.1.220 and Antigravity CLI
// 1.1.18:
//   - Claude honors `permissionDecision: "ask"` even under
//     --dangerously-skip-permissions: a hook's own ask result is returned as the
//     decision before bypassPermissions mode can turn it into an allow. In
//     headless `-p` runs, where there is no one to prompt, it lands as a denial
//     carrying this reason, so the orchestrator still learns the cap was reached.
//   - Antigravity takes a top-level decision and offers both "ask" and
//     "force_ask". This uses force_ask: plain "ask" honors the always-allow
//     cache, so a user who once chose always-allow for subagent spawns would
//     never be shown the question. Measured with an allow-rule in place: a
//     silent hook let the call through, force_ask forced the confirmation.
//   - Grok has no ask at all — its PreToolUse decisions are allow/deny, and an
//     unknown value fails open, which would drop the gate entirely. There it
//     denies with `denyReason`, which should tell the orchestrator to put the
//     same question to the user itself rather than re-spawning.
function askPreToolUse(askReason, denyReason) {
  if (isAntigravity()) {
    emit({ decision: "force_ask", reason: askReason });
    return;
  }
  if (isGrok()) {
    denyPreToolUse(denyReason || askReason);
    return;
  }
  emit({
    reason: askReason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: askReason,
    },
  });
}

// Blocks a UserPromptExpansion (a user typing a skill/command's slash form
// directly, e.g. "/ultracode:orchestrate") — a different code path from a
// model-issued tool call, so PreToolUse hooks never see it. This event's
// hookSpecificOutput only carries additionalContext, not a permission
// decision; the top-level `decision: "block"` field is what actually stops it.
function denyUserPromptExpansion(reason) {
  emit({ decision: "block", reason });
}

// Feeds text back into the model's context without blocking anything. Used by
// PostToolUse hooks that need to say something to the agent mid-turn (e.g.
// build-streak.js warning that a failure streak is building). PostToolUse cannot
// deny, so additionalContext is the only channel it has.
//
// Antigravity has no equivalent: its PostToolUse output accepts `{}` and nothing
// else, and its PreToolUse output accepts only a decision (an unknown field makes
// protojson discard the whole response, which fails a guard open). So on AGY this
// is a no-op, and a hook with something to say has to route it through a channel
// AGY does have — a deny `reason`, or the `injectSteps` of an invocation hook.
// hooks/build-streak.js does the former: it files the warning for
// hooks/build-streak-gate.js to deliver when it denies.
function emitAdditionalContext(hookEventName, additionalContext) {
  if (isAntigravity()) {
    emit({});
    return;
  }
  emit({ hookSpecificOutput: { hookEventName, additionalContext } });
}

function field(text, label) {
  const pattern = new RegExp(
    `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.*?)\\s*\\.?$`,
    "m",
  );
  const match = text.match(pattern);
  return match ? match[1] : "";
}

function readTextIfFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

// True if `target` (absolute, resolved) is `root` itself or somewhere under it.
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Resolves a candidate path (from a tool call or a shell command token)
// against `baseDir`, expanding a leading `~` to the real home directory first
// — `path.resolve` treats `~` as a literal directory name, which would let
// `~/.ssh` resolve as a harmless-looking relative path under `baseDir`.
function resolvePathCandidate(baseDir, candidate) {
  if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    return path.resolve(os.homedir(), candidate.slice(2));
  }
  return path.resolve(baseDir, candidate);
}

function sanitizeSessionId(id) {
  const value = typeof id === "string" && id.trim() ? id.trim() : "no-session-id";
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "-");
  return cleaned || "no-session-id";
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", reject);
  });
}

async function readHookInput() {
  const stdin = await readStdin();
  try {
    return JSON.parse(stdin);
  } catch {
    return null;
  }
}

function pluginRootFromEnv() {
  return path.resolve(
    process.env.ANTIGRAVITY_PLUGIN_ROOT ||
      process.env.AGY_PLUGIN_ROOT ||
      process.env.GROK_PLUGIN_ROOT ||
      process.env.PLUGIN_ROOT ||
      process.env.CLAUDE_PLUGIN_ROOT ||
      path.join(__dirname, "..", ".."),
  );
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function harnessAdapter() {
  return adapterFor(generatedTarget() || (isAntigravity() ? "antigravity" : "claude"));
}

function hookToolInput(hookInput) {
  return harnessAdapter().toolInput(hookInput);
}

function commandFromToolInput(toolInput) {
  return harnessAdapter().command(toolInput);
}

function writePathFromToolInput(toolInput) {
  return harnessAdapter().writePath(toolInput);
}

function hookToolResponse(hookInput) {
  return harnessAdapter().toolResponse(hookInput);
}

function hookSessionId(hookInput) {
  return (
    harnessAdapter().sessionId(hookInput) ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    process.env.AGY_CONVERSATION_ID ||
    process.env.GROK_SESSION_ID ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    "no-session-id"
  );
}

function hookAgentType(hookInput) {
  return harnessAdapter().actor(hookInput);
}

function hookTranscriptPath(hookInput) {
  return harnessAdapter().transcriptPath(hookInput);
}

function bareAgentName(value) {
  return normalizeAgentName(value);
}

// The agent names this plugin actually defines, read from the generated routing
// file (its `defaults` keys are exactly one per shipped agent). Cached for the
// life of the process; an unreadable file yields an empty set, which degrades to
// positional resolution rather than failing.
let knownAgentCache = null;
function knownAgents() {
  if (knownAgentCache) return knownAgentCache;
  knownAgentCache = new Set();
  const routing = generatedRouting();
  if (routing && routing.defaults && typeof routing.defaults === "object") {
    for (const name of Object.keys(routing.defaults)) knownAgentCache.add(name);
  }
  return knownAgentCache;
}

// Antigravity spawns carry BOTH a canonical `TypeName` ("ultracode-fact-check")
// and a free-text `Role` the model writes itself ("Fact Checker", "Implementation
// Planner"). Preferring either field positionally is a trap: a label-derived name
// ("fact-checker", "implementation-planner") matches no agent, so every hook keyed
// on the agent — pipeline-gate's spec/plan gate, factcheck-record, model-router's
// route lookup — silently skips instead of enforcing, and the model can turn any of
// them off just by renaming its own spawn.
//
// So candidates are collected from every field that could carry the name and the
// first one that IS a shipped agent wins, whichever field it came from. Only when
// none matches (a non-ultracode subagent) does the first readable candidate win,
// canonical field first.
function spawnsFromToolInput(toolInput) {
  return harnessAdapter().spawnEntries(toolInput, knownAgents());
}

function agentFromToolInput(toolInput) {
  const first = spawnsFromToolInput(toolInput)[0];
  return first ? first.agent : "";
}

function promptFromToolInput(toolInput) {
  const first = spawnsFromToolInput(toolInput)[0];
  return first ? first.prompt : "";
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function textFromContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  const pieces = [];
  for (const block of blocks) {
    if (typeof block === "string" && block) {
      pieces.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string" && block.text) pieces.push(block.text);
    else if (typeof block.content === "string" && block.content) pieces.push(block.content);
  }
  return pieces.join("\n");
}

function textFromToolResponse(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse;
  if (Array.isArray(toolResponse)) return textFromContentBlocks(toolResponse);
  if (toolResponse && typeof toolResponse === "object") {
    if (typeof toolResponse.result === "string") return toolResponse.result;
    if (typeof toolResponse.content === "string") return toolResponse.content;
    if (Array.isArray(toolResponse.content)) return textFromContentBlocks(toolResponse.content);
  }
  return "";
}

// Tolerant JSON extraction for a leaf agent's raw text return (code-reviewer,
// fact-check): accepts an already-parsed object, Claude content-block arrays,
// a bare JSON string, JSON wrapped in a markdown fence, or JSON with stray
// text around it.
function extractJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (
      Object.prototype.hasOwnProperty.call(value, "verdict") ||
      Object.prototype.hasOwnProperty.call(value, "findings")
    ) {
      return value;
    }
  }
  const text = textFromToolResponse(value) || (typeof value === "string" ? value : "");
  if (!text) return null;
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function readJsonIfFile(filePath) {
  const text = readTextIfFile(filePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = {
  emit,
  generatedRouting,
  generatedTarget,
  harnessAdapter,
  isAntigravity,
  denyPreToolUse,
  askPreToolUse,
  denyUserPromptExpansion,
  emitAdditionalContext,
  field,
  readTextIfFile,
  isDirectory,
  isFile,
  isInside,
  resolvePathCandidate,
  sanitizeSessionId,
  readStdin,
  readHookInput,
  pluginRootFromEnv,
  pick,
  hookToolInput,
  hookToolResponse,
  commandFromToolInput,
  writePathFromToolInput,
  hookSessionId,
  hookAgentType,
  hookTranscriptPath,
  bareAgentName,
  knownAgents,
  spawnsFromToolInput,
  agentFromToolInput,
  promptFromToolInput,
  writeJsonAtomic,
  readJsonIfFile,
  textFromToolResponse,
  extractJsonObject,
};
