#!/usr/bin/env node
// Transcript discovery and parsing for the ultracode bench harness.
//
// Two harnesses record sessions in different shapes:
//
//   Claude Code / Codex — ~/.claude/projects/<project>/<session>.jsonl for the
//     main conversation, plus ~/.claude/projects/<project>/<session>/subagents/
//     agent-<agentId>.jsonl per subagent run. A subagent transcript does NOT
//     record which agent type it is; the only authoritative link is the parent's
//     Agent/Task tool_use (which carries subagent_type) paired with the
//     tool_result that echoes "agentId: <id>". linkSpawns() rebuilds that map.
//     Matching on the spawn prompt's text instead is unreliable — orchestrators
//     write freeform prompts, and a "Session dir: .../ultracode/session/..."
//     line makes a naive /ultracode[:/](\w+)/ match read "session" as the agent.
//
//   Grok Build — ~/.grok/sessions/<url-encoded-cwd>/<session>/chat_history.jsonl,
//     a flat event list where assistant events carry a tool_calls array and
//     results arrive as separate tool_result events keyed by tool_call_id.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");
const GROK_ROOT = path.join(os.homedir(), ".grok", "sessions");

function walk(dir, predicate, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(entry.name, full)) out.push(full);
  }
  return out;
}

function claudeTranscripts(root = CLAUDE_ROOT) {
  const all = walk(root, (name) => name.endsWith(".jsonl"));
  return {
    main: all.filter((f) => !f.includes(`${path.sep}subagents${path.sep}`)),
    subagents: all.filter((f) => f.includes(`${path.sep}subagents${path.sep}`)),
  };
}

function grokTranscripts(root = GROK_ROOT) {
  return walk(root, (name) => name === "chat_history.jsonl");
}

async function eachJsonLine(file, onEvent) {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    onEvent(event);
  }
}

function resultText(block) {
  if (!block) return "";
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

// agentId -> { subagentType, prompt, promptChars, model, parentSession, project }
async function linkSpawns(mainFiles) {
  const map = new Map();
  for (const file of mainFiles) {
    const pending = new Map();
    await eachJsonLine(file, (event) => {
      const content = event.message && event.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type === "tool_use" && (block.name === "Agent" || block.name === "Task")) {
          const input = block.input || {};
          pending.set(block.id, {
            subagentType: typeof input.subagent_type === "string" ? input.subagent_type : null,
            prompt: typeof input.prompt === "string" ? input.prompt : "",
            model: input.model || null,
          });
        }
        if (block.type === "tool_result") {
          const meta = pending.get(block.tool_use_id);
          if (!meta) continue;
          const match = resultText(block).match(/agentId:?\s*"?([a-f0-9]{10,})/i);
          if (!match) continue;
          map.set(match[1], {
            ...meta,
            promptChars: meta.prompt.length,
            parentSession: path.basename(file, ".jsonl"),
            project: path.basename(path.dirname(file)),
          });
        }
      }
    });
  }
  return map;
}

function agentIdOf(subagentFile) {
  return path.basename(subagentFile, ".jsonl").replace(/^agent-/, "");
}

function parentSessionOf(subagentFile) {
  return path.basename(path.dirname(path.dirname(subagentFile)));
}

module.exports = {
  CLAUDE_ROOT,
  GROK_ROOT,
  walk,
  claudeTranscripts,
  grokTranscripts,
  eachJsonLine,
  resultText,
  linkSpawns,
  agentIdOf,
  parentSessionOf,
};
