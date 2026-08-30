#!/usr/bin/env node
// Capture fact-check verdicts under the primary session root and the spawn's
// explicit repo key. The work repository may be elsewhere.
//
// DELIBERATELY NOT REGISTERED in hooks/hooks.codex.json (removed 2026-08-30,
// not an omission): on codex the verdict can never reach this hook — the v2
// spawn result is an async launch ack, wait_agent returns no child content,
// and an incoming FINAL_ANSWER is a TurnInput::InterAgentCommunication for
// which codex's hook runtime dispatches nothing (source citations in
// docs/harness-limitations.md). The codex fact-check role records its own
// verdict through the ultracode_factcheck MCP tool instead.
//
// DELIBERATELY NOT REGISTERED in hooks/hooks.grok.json either (removed
// 2026-08-30, same reasoning, different mechanics): grok's spawn tool
// defaults to run_in_background: true and even foreground spawns
// auto-background when the wait budget expires, so PostToolUse usually
// carries only a launch ack; grok's SubagentStop payload has the final
// message but no spawn prompt and no child transcript path, so `Session
// dir:` / `Repo key:` are unrecoverable there (hooks/lib/grok-hooks.js,
// fact 4). The grok fact-check role also records its own verdict through
// ultracode_factcheck.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  emitAdditionalContext,
  extractJsonObject,
  pick,
  promptFromToolInput,
  readHookInput,
  readJsonIfFile,
  writeJsonAtomic,
} = require("./lib/common");
const { HookContext } = require("./lib/hook-context");

function eventNameOf(hookInput) {
  const value = pick(hookInput, "hook_event_name", "hookEventName");
  return typeof value === "string" ? value : "";
}

// Claude SubagentStop carries `agent_transcript_path` but not the original
// Agent-tool `prompt`. The leaf transcript's first user turn is that spawn
// prompt — the only place the `Repo key:` / `Session dir:` lines still live
// once PostToolUse has already returned the launch ack.
function firstUserPromptFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return "";
  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return "";
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || entry.type !== "user") continue;
    const content = entry.message && entry.message.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const pieces = [];
      for (const block of content) {
        if (typeof block === "string" && block) pieces.push(block);
        else if (block && typeof block.text === "string" && block.text) pieces.push(block.text);
      }
      if (pieces.length) return pieces.join("\n");
    }
  }
  return "";
}

// Fallback when SubagentStop omits `last_assistant_message`: walk the leaf
// transcript for the final assistant text (the fact-check JSON body). Prefer
// the event field — the docs warn the transcript can lag the stop event.
function lastAssistantTextFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return "";
  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return "";
  }
  let last = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || entry.type !== "assistant") continue;
    const content = entry.message && entry.message.content;
    if (typeof content === "string" && content.trim()) {
      last = content;
      continue;
    }
    if (Array.isArray(content)) {
      const pieces = [];
      for (const block of content) {
        if (typeof block === "string" && block) pieces.push(block);
        else if (block && typeof block.text === "string" && block.text) pieces.push(block.text);
      }
      if (pieces.length) last = pieces.join("\n");
    }
  }
  return last;
}

// Claude Code's Agent tool is async by default: PostToolUse:Agent fires on the
// launch ack ("Async agent launched successfully…") and never again when the
// leaf finishes, so a PostToolUse-only reader never sees the verdict. The
// completion event is SubagentStop, which carries `last_assistant_message` and
// `agent_transcript_path` but no tool_input/tool_response. Rebuild the shape
// HookContext already understands from the leaf's spawn prompt + final message;
// hooks.claude.json registers this same file on both events.
function inputForRecording(hookInput) {
  const eventName = eventNameOf(hookInput);
  if (eventName !== "SubagentStop") return { hookInput, eventName: eventName || "PostToolUse" };

  const agentTranscript =
    pick(hookInput, "agent_transcript_path", "agentTranscriptPath") || "";
  const existingPrompt = promptFromToolInput(hookInput) || "";
  const prompt = existingPrompt || firstUserPromptFromTranscript(agentTranscript);
  const lastMessage =
    pick(hookInput, "last_assistant_message", "lastAssistantMessage") ||
    lastAssistantTextFromTranscript(agentTranscript);
  if (!prompt || !lastMessage) return { hookInput: null, eventName };

  const agentType =
    pick(hookInput, "agent_type", "agentType") || "ultracode:fact-check";
  return {
    eventName,
    hookInput: {
      ...hookInput,
      tool_input: {
        subagent_type: agentType,
        prompt,
      },
      tool_response: lastMessage,
    },
  };
}

async function main() {
  const rawInput = await readHookInput();
  const { hookInput, eventName } = inputForRecording(rawInput);
  if (!hookInput) return 0;

  const context = new HookContext(hookInput);
  const payload = extractJsonObject(context.toolResponse);
  const target = payload && (payload.target === "spec" || payload.target === "plan") ? payload.target : null;
  const verdict = payload && (payload.verdict === "PASS" || payload.verdict === "FAIL") ? payload.verdict : null;
  if (!target || !verdict) return 0;

  for (const spawn of context.spawns.filter((candidate) => candidate.agent === "fact-check")) {
    if (!spawn.repoKey || !spawn.stateRoot) {
      emitAdditionalContext(
        eventName,
        `ultracode: fact-check returned ${verdict} for ${target}, but no valid \`Repo key:\` line was available; ` +
          "re-spawn with the required parameter contract.",
      );
      continue;
    }
    try {
      const factcheckPath = path.join(spawn.stateRoot, spawn.repoKey, "factcheck.json");
      const current = readJsonIfFile(factcheckPath) || {};
      const priorRounds = (current[target] && current[target].rounds) || 0;
      current[target] = {
        verdict,
        rounds: priorRounds + 1,
        findings: Array.isArray(payload.findings) ? payload.findings : [],
        repo: spawn.repoKey,
        workRepoRoot: spawn.workRepoRoot,
        ts: new Date().toISOString(),
        ...(eventName === "SubagentStop"
          ? {
              source: "subagent-stop",
              agentId: pick(hookInput, "agent_id", "agentId") || "",
            }
          : {}),
      };
      writeJsonAtomic(factcheckPath, current);
    } catch {
      // Best-effort capture only.
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
