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

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

// Which harness this copy of the plugin was generated for, read from the routing
// file that sits beside this very file. Authoritative and environment-independent:
// the generator writes one per build, so the answer is a property of the plugin
// being run rather than a guess from whatever variables happen to be exported.
let generatedTargetCache;
function generatedTarget() {
  if (generatedTargetCache !== undefined) return generatedTargetCache;
  generatedTargetCache = null;
  const text = readTextIfFile(path.join(__dirname, "..", "model-routing.json"));
  if (text) {
    try {
      const routing = JSON.parse(text);
      if (routing && typeof routing.target === "string") generatedTargetCache = routing.target;
    } catch {
      // fall through to the env heuristic
    }
  }
  return generatedTargetCache;
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

function denyPreToolUse(reason) {
  if (isAntigravity()) {
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

function hookToolInput(hookInput) {
  if (hookInput && hookInput.toolCall && typeof hookInput.toolCall === "object") {
    return hookInput.toolCall.args || hookInput.toolCall.input || null;
  }
  return pick(hookInput, "tool_input", "toolInput") || null;
}

// The shell command a tool call carries, under whichever key the harness uses:
// Claude/Codex/Grok say `command`, Antigravity says `CommandLine`. Hooks that read
// only `command` are silently inert on AGY — that is how the whole build-streak
// feature (counting a subagent's consecutive build failures, and the gate that
// forces escalation) never fired there.
function commandFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  for (const key of ["CommandLine", "command", "Command"]) {
    if (typeof toolInput[key] === "string" && toolInput[key]) return toolInput[key];
  }
  return "";
}

function hookToolResponse(hookInput) {
  const value = pick(hookInput, "tool_response", "toolResponse", "tool_result", "toolResult");
  return value === undefined ? null : value;
}

function hookSessionId(hookInput) {
  return (
    pick(hookInput, "conversationId", "conversation_id", "session_id", "sessionId") ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    process.env.AGY_CONVERSATION_ID ||
    process.env.GROK_SESSION_ID ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    "no-session-id"
  );
}

function hookAgentType(hookInput) {
  return pick(hookInput, "agent_type", "agentType") || "";
}

function bareAgentName(value) {
  if (typeof value !== "string") return "";
  let val = value.trim();
  if (val.startsWith("ultracode:")) val = val.slice("ultracode:".length);
  else if (val.startsWith("ultracode-")) val = val.slice("ultracode-".length);
  else if (val.startsWith("ultracode_")) val = val.slice("ultracode_".length);
  val = val.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return val;
}

// The agent names this plugin actually defines, read from the generated routing
// file (its `defaults` keys are exactly one per shipped agent). Cached for the
// life of the process; an unreadable file yields an empty set, which degrades to
// positional resolution rather than failing.
let knownAgentCache = null;
function knownAgents() {
  if (knownAgentCache) return knownAgentCache;
  knownAgentCache = new Set();
  const text = readTextIfFile(path.join(pluginRootFromEnv(), "hooks", "model-routing.json"));
  if (text) {
    try {
      const routing = JSON.parse(text);
      if (routing && routing.defaults && typeof routing.defaults === "object") {
        for (const name of Object.keys(routing.defaults)) knownAgentCache.add(name);
      }
    } catch {
      // keep the empty set
    }
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
function agentFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  const raw = [];
  if (Array.isArray(toolInput.Subagents) && toolInput.Subagents.length > 0) {
    const first = toolInput.Subagents[0] || {};
    raw.push(first.TypeName, first.typeName, first.Role, first.role);
  }
  for (const key of [
    "subagent_type",
    "subagentType",
    "agent_type",
    "agentType",
    "task_name",
    "taskName",
    "TypeName",
    "typeName",
    "Role",
    "role",
  ]) {
    raw.push(toolInput[key]);
  }

  const candidates = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const name = bareAgentName(value);
    // "self"/"research" are Antigravity's own built-in subagent kinds, never ours.
    if (!name || name === "self" || name === "research") continue;
    if (!candidates.includes(name)) candidates.push(name);
  }

  const known = knownAgents();
  return candidates.find((name) => known.has(name)) || candidates[0] || "";
}

function promptFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  if (Array.isArray(toolInput.Subagents) && toolInput.Subagents.length > 0) {
    const first = toolInput.Subagents[0];
    if (typeof first.Prompt === "string") return first.Prompt;
    if (typeof first.prompt === "string") return first.prompt;
  }
  return (
    ["prompt", "Prompt", "message", "Message"].map((key) => toolInput[key]).find((v) => typeof v === "string") || ""
  );
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function textFromToolResponse(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse;
  if (toolResponse && typeof toolResponse === "object" && typeof toolResponse.result === "string") {
    return toolResponse.result;
  }
  return "";
}

// Tolerant JSON extraction for a leaf agent's raw text return (code-reviewer,
// fact-check): accepts an already-parsed object, a bare JSON string, JSON
// wrapped in a markdown fence, or JSON with stray text around it.
function extractJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
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
  isAntigravity,
  denyPreToolUse,
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
  hookSessionId,
  hookAgentType,
  bareAgentName,
  agentFromToolInput,
  promptFromToolInput,
  writeJsonAtomic,
  readJsonIfFile,
  textFromToolResponse,
  extractJsonObject,
};
