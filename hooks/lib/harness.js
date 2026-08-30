#!/usr/bin/env node
// Declarative hook-payload adapters. Policy hooks consume one canonical shape;
// only this file knows which casing/envelope each harness sends and accepts.

"use strict";

const HARNESS_DEFINITIONS = Object.freeze({
  claude: {
    toolInputPaths: [["tool_input"], ["toolInput"]],
    toolResponsePaths: [["tool_response"], ["toolResponse"], ["tool_result"], ["toolResult"]],
    sessionPaths: [["session_id"], ["sessionId"]],
    actorPaths: [["agent_type"], ["agentType"]],
    transcriptPaths: [["transcript_path"], ["transcriptPath"]],
    flatPromptKeys: ["prompt", "message", "Prompt", "Message"],
    flatModelKeys: ["model", "Model"],
  },
  codex: {
    toolInputPaths: [["tool_input"], ["toolInput"]],
    toolResponsePaths: [["tool_response"], ["toolResponse"], ["tool_result"], ["toolResult"]],
    sessionPaths: [["session_id"], ["sessionId"]],
    actorPaths: [["agent_type"], ["agentType"]],
    transcriptPaths: [["transcript_path"], ["transcriptPath"]],
    flatPromptKeys: ["prompt", "message", "Prompt", "Message"],
    flatModelKeys: ["model", "Model"],
  },
  grok: {
    toolInputPaths: [["toolInput"], ["tool_input"]],
    toolResponsePaths: [["toolResponse"], ["tool_response"], ["toolResult"], ["tool_result"]],
    sessionPaths: [["sessionId"], ["session_id"]],
    actorPaths: [["agentType"], ["agent_type"]],
    transcriptPaths: [["transcriptPath"], ["transcript_path"]],
    flatPromptKeys: ["prompt", "message", "Prompt", "Message"],
    flatModelKeys: ["model", "Model"],
  },
  antigravity: {
    toolInputPaths: [["toolCall", "args"], ["toolCall", "input"], ["toolInput"], ["tool_input"]],
    toolResponsePaths: [["toolResponse"], ["tool_response"], ["toolResult"], ["tool_result"]],
    sessionPaths: [["conversationId"], ["conversation_id"], ["sessionId"], ["session_id"]],
    actorPaths: [["agentType"], ["agent_type"]],
    transcriptPaths: [["transcriptPath"], ["transcript_path"]],
    flatPromptKeys: ["Prompt", "prompt", "Message", "message"],
    flatModelKeys: ["Model", "model"],
  },
});

const DEFAULT_TARGET = "claude";
const AGENT_KEYS = [
  "subagent_type",
  "subagentType",
  "agent_type",
  "agentType",
  "task_name",
  "taskName",
  "agent_name",
  "agentName",
  "TypeName",
  "typeName",
  "Role",
  "role",
];
const SUBAGENT_AGENT_KEYS = ["TypeName", "typeName", "Role", "role"];
const SUBAGENT_PROMPT_KEYS = ["Prompt", "prompt", "Message", "message"];
const SUBAGENT_MODEL_KEYS = ["Model", "model"];

function valueAt(object, pathParts) {
  let current = object;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function firstValue(object, paths) {
  for (const pathParts of paths) {
    const value = valueAt(object, pathParts);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstString(object, keys) {
  if (!object || typeof object !== "object") return "";
  for (const key of keys) {
    if (typeof object[key] === "string" && object[key]) return object[key];
  }
  return "";
}

function bareAgentName(value) {
  if (typeof value !== "string") return "";
  let name = value.trim();
  for (const prefix of ["ultracode:", "ultracode-", "ultracode_"]) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  return name
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function canonicalAgent(rawValues, knownAgents) {
  const candidates = [];
  for (const value of rawValues) {
    const name = bareAgentName(value);
    if (!name || name === "self" || name === "research" || candidates.includes(name)) continue;
    candidates.push(name);
  }
  return candidates.find((name) => knownAgents.has(name)) || candidates[0] || "";
}

// True when a spawn prompt is a sealed ciphertext blob rather than text.
// Codex with OpenAI models returns collaboration spawn_agent arguments
// encrypted (a single Fernet-style token, `gAAAA…`); the client — and
// therefore every hook — never sees the plaintext. A legitimate ultracode
// spawn prompt always contains spaces, newlines, and `Label:` lines, so a
// single unbroken base64url token cannot be a false positive.
function isOpaqueCiphertext(prompt) {
  return (
    typeof prompt === "string" &&
    prompt.length >= 80 &&
    /^gAAAA[A-Za-z0-9_=-]+$/.test(prompt)
  );
}

function writeField(object, existingKeys, preferredKey, value) {
  const key = existingKeys.find((candidate) => typeof object[candidate] === "string") || preferredKey;
  return { ...object, [key]: value };
}

class HarnessAdapter {
  constructor(target) {
    this.target = HARNESS_DEFINITIONS[target] ? target : DEFAULT_TARGET;
    this.definition = HARNESS_DEFINITIONS[this.target];
  }

  toolInput(hookInput) {
    const value = firstValue(hookInput, this.definition.toolInputPaths);
    return value && typeof value === "object" ? value : null;
  }

  toolResponse(hookInput) {
    const value = firstValue(hookInput, this.definition.toolResponsePaths);
    return value === undefined ? null : value;
  }

  sessionId(hookInput) {
    return firstValue(hookInput, this.definition.sessionPaths) || "";
  }

  actor(hookInput) {
    return firstValue(hookInput, this.definition.actorPaths) || "";
  }

  transcriptPath(hookInput) {
    return firstValue(hookInput, this.definition.transcriptPaths) || "";
  }

  command(toolInput) {
    return firstString(toolInput, ["CommandLine", "command", "Command"]);
  }

  writePath(toolInput) {
    return firstString(toolInput, [
      "TargetFile",
      "AbsolutePath",
      "file_path",
      "filePath",
      "path",
      "Path",
    ]);
  }

  spawnEntries(toolInput, knownAgents = new Set()) {
    if (!toolInput || typeof toolInput !== "object") return [];
    if (Array.isArray(toolInput.Subagents)) {
      return toolInput.Subagents.map((raw, index) => {
        const subagent = raw && typeof raw === "object" ? raw : {};
        const prompt = firstString(subagent, SUBAGENT_PROMPT_KEYS);
        return {
          index,
          shape: "subagents",
          agent: canonicalAgent(SUBAGENT_AGENT_KEYS.map((key) => subagent[key]), knownAgents),
          prompt,
          promptOpaque: isOpaqueCiphertext(prompt),
          model: firstString(subagent, SUBAGENT_MODEL_KEYS),
          raw: subagent,
        };
      });
    }
    const prompt = firstString(toolInput, this.definition.flatPromptKeys);
    return [{
      index: 0,
      shape: "flat",
      agent: canonicalAgent(AGENT_KEYS.map((key) => toolInput[key]), knownAgents),
      prompt,
      promptOpaque: isOpaqueCiphertext(prompt),
      model: firstString(toolInput, this.definition.flatModelKeys),
      raw: toolInput,
    }];
  }

  rewriteSpawns(toolInput, patches) {
    if (!toolInput || typeof toolInput !== "object" || !patches || patches.size === 0) return toolInput;
    if (Array.isArray(toolInput.Subagents)) {
      return {
        ...toolInput,
        Subagents: toolInput.Subagents.map((raw, index) => {
          const patch = patches.get(index);
          if (!patch) return raw;
          let updated = raw && typeof raw === "object" ? { ...raw } : {};
          if (patch.prompt !== undefined) {
            updated = writeField(updated, SUBAGENT_PROMPT_KEYS, "Prompt", patch.prompt);
          }
          if (patch.model !== undefined) {
            updated = writeField(updated, SUBAGENT_MODEL_KEYS, "Model", patch.model);
          }
          Object.assign(updated, patch.assign || {});
          for (const key of patch.remove || []) delete updated[key];
          return updated;
        }),
      };
    }

    const patch = patches.get(0);
    if (!patch) return toolInput;
    let updated = { ...toolInput };
    if (patch.prompt !== undefined) {
      updated = writeField(updated, this.definition.flatPromptKeys, this.definition.flatPromptKeys[0], patch.prompt);
    }
    if (patch.model !== undefined) {
      updated = writeField(updated, this.definition.flatModelKeys, this.definition.flatModelKeys[0], patch.model);
    }
    Object.assign(updated, patch.assign || {});
    for (const key of patch.remove || []) delete updated[key];
    return updated;
  }

  emitUpdatedInput(updatedInput) {
    if (this.target === "antigravity") {
      return { decision: "allow", overwrite: updatedInput };
    }
    // Claude validates PreToolUse output strictly: a top-level `overwrite` /
    // `decision:"allow"` pair fails schema validation and the rewrite is
    // discarded even though the spawn itself may still proceed. Keep the
    // rewrite inside hookSpecificOutput.updatedInput only.
    const hookSpecificOutput = { hookEventName: "PreToolUse", updatedInput };
    // Grok parses the same shape (xai-grok-hooks/src/runner/mod.rs
    // GateHookJson); its rewrite is schema-validated against the tool's input
    // schema and an unusable one BLOCKS the call, so nothing extra may ride
    // along. A top-level `overwrite` is not a grok field — it was only ever
    // warned-and-ignored.
    if (this.target === "codex" || this.target === "grok") {
      hookSpecificOutput.permissionDecision = "allow";
    }
    return { hookSpecificOutput };
  }
}

function adapterFor(target) {
  return new HarnessAdapter(target);
}

module.exports = {
  HARNESS_DEFINITIONS,
  HarnessAdapter,
  adapterFor,
  bareAgentName,
  firstString,
  isOpaqueCiphertext,
};
