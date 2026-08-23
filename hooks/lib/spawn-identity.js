#!/usr/bin/env node
// Read a leaf subagent's spawn identity from its own transcript.
//
// Harnesses differ on whether a leaf tool hook carries agent_type / cwd for the
// work repo. The spawn prompt always does: `Repo root:`, `Session dir:`,
// `Repo key:`, and (on AGY) `Ultracode agent:`. This module is the shared reader
// for those lines across transcript shapes — it is not Antigravity-specific.
// AGY message pairing and tool-result recovery stay in agy-transcript.js.

"use strict";

const fs = require("node:fs");
const { bareAgentName, field } = require("./common");

function readJsonl(transcriptPath) {
  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return [];
  }
  const steps = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const step = JSON.parse(trimmed);
      if (step && typeof step === "object") steps.push(step);
    } catch {
      // A partially flushed final line is normal while the session is live.
    }
  }
  return steps;
}

function emptyContext() {
  return { agent: "", sessionDir: "", repoRoot: "", repoKey: "", primaryRepoRoot: "" };
}

function contextFromPrompt(content) {
  if (!content) return emptyContext();
  return {
    agent: bareAgentName(field(content, "Ultracode agent")),
    sessionDir: field(content, "Session dir"),
    repoRoot: field(content, "Repo root"),
    repoKey: field(content, "Repo key"),
    primaryRepoRoot: field(content, "Ultracode primary repo") || field(content, "Primary repo root"),
  };
}

// Prompt text from the first user turn:
// - Antigravity: `{ type: "USER_INPUT", content: "..." }`
// - Claude Code leaf: `{ type: "user", message: { content: "..." | [{type:"text",text:"..."}] } }`
function promptTextOf(step) {
  if (!step || typeof step !== "object") return "";
  if (typeof step.content === "string" && step.content) return step.content;
  const message = step.message;
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isUserTurn(step) {
  return step && (step.type === "USER_INPUT" || step.type === "user") && Boolean(promptTextOf(step));
}

function spawnContextFromTranscript(transcriptPath) {
  const first = readJsonl(transcriptPath).find(isUserTurn);
  return contextFromPrompt(first ? promptTextOf(first) : "");
}

module.exports = {
  contextFromPrompt,
  spawnContextFromTranscript,
};
