#!/usr/bin/env node
// Shared helpers for ultracode's PreToolUse/PostToolUse/SessionStart hooks.
//
// Deliberately does not touch hooks/model-router.js — that file has its own
// well-tested copies of a few of these helpers; this module is for every
// hook added after it, so a regression here cannot affect model routing.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function denyPreToolUse(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
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
    process.env.PLUGIN_ROOT ||
      process.env.CLAUDE_PLUGIN_ROOT ||
      path.join(__dirname, "..", ".."),
  );
}

function bareAgentName(value) {
  if (typeof value !== "string") return "";
  return value.startsWith("ultracode:") ? value.slice("ultracode:".length) : value;
}

function agentFromToolInput(toolInput) {
  const value = ["subagent_type", "agent_type", "task_name"]
    .map((key) => toolInput[key])
    .find((v) => typeof v === "string");
  return bareAgentName(value || "");
}

function promptFromToolInput(toolInput) {
  return (
    ["prompt", "message"].map((key) => toolInput[key]).find((v) => typeof v === "string") || ""
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
  denyPreToolUse,
  field,
  readTextIfFile,
  isDirectory,
  isFile,
  sanitizeSessionId,
  readStdin,
  readHookInput,
  pluginRootFromEnv,
  bareAgentName,
  agentFromToolInput,
  promptFromToolInput,
  writeJsonAtomic,
  readJsonIfFile,
  textFromToolResponse,
  extractJsonObject,
};
