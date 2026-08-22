#!/usr/bin/env node
// Reader for Antigravity's own conversation transcript, used to recover what a
// subagent returned — the one thing AGY's hook payloads never carry.
//
// WHY THIS EXISTS
//
// Every other harness hands a PostToolUse hook the tool's result, so
// hooks/factcheck-record.js can read ultracode:fact-check's verdict straight off
// the spawn that produced it. Antigravity does neither half of that:
//
//   * its PostToolUse payload is {stepIdx, error?, toolCall, …common} — there is
//     no result field at all; and
//   * `invoke_subagent` is asynchronous. The call returns "Created the following
//     subagents: {conversationId: …}" immediately, and the agent's actual answer
//     arrives later as a separate SYSTEM_MESSAGE step:
//
//       [Message] timestamp=… sender=<subagent conversationId>
//                 priority=MESSAGE_PRIORITY_HIGH content={"verdict":"PASS",…}
//
// So factcheck.json was never written on AGY, the ultracode_gate tool kept
// (correctly) refusing to record an approval, and the recorded session ended with
// the orchestrator forging the file to get moving. Reading the transcript is what
// closes that liveness gap without trusting the orchestrator's word for it.
//
// WHY A TRANSCRIPT MESSAGE IS TRUSTWORTHY EVIDENCE
//
// The pairing is what makes it evidence rather than hearsay: the spawn result
// names the subagent's `conversationId`, and the message step carries
// `sender=<that same id>`, stamped by AGY's messaging system rather than written
// by the model. A verdict is therefore only accepted when its sender matches an
// id AGY reported for a spawn of that agent in this same transcript — the
// orchestrator cannot author a message from a subagent it did not spawn, and it
// cannot rename a spawn into a different agent because the agent name is read
// from the spawn call's own canonical field.
//
// Best-effort by design: an unreadable, partial, or unfamiliar transcript yields
// no records, and every caller treats "no records" as "nothing to record".

"use strict";

const fs = require("node:fs");
const { agentFromToolInput, bareAgentName, extractJsonObject, field } = require("./common");

const SPAWN_TOOLS = new Set(["invoke_subagent", "spawn_subagent"]);
const UUID = "[0-9a-fA-F-]{8,}";

function readTranscript(transcriptPath) {
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

function toolCallsOf(step) {
  return Array.isArray(step.tool_calls) ? step.tool_calls : [];
}

// The subagents one `invoke_subagent` call asks for, in call order, so they can be
// zipped against the conversation ids AGY reports back for them.
function requestedSubagents(call) {
  const args = (call && (call.args || call.arguments)) || {};
  const list = Array.isArray(args.Subagents) ? args.Subagents : [args];
  return list.map((sub) => ({
    agent: agentFromToolInput({ Subagents: [sub] }),
    prompt: (sub && (sub.Prompt || sub.prompt)) || "",
  }));
}

function contentOf(step) {
  return typeof step.content === "string" ? step.content : "";
}

// "Created the following subagents:" is followed by one JSON object per spawned
// agent; only the ids are needed, and they come back in request order.
function spawnedIdsFrom(content) {
  if (!/Created the following subagents/i.test(content)) return [];
  return [...content.matchAll(new RegExp(`"conversationId"\\s*:\\s*"(${UUID})"`, "g"))].map(
    (match) => match[1],
  );
}

// A delivered agent-to-agent message: sender id plus the raw payload text.
function messageFrom(content) {
  const match = content.match(new RegExp(`\\[Message\\][^\\n]*?sender=(${UUID})`));
  if (!match) return null;
  const bodyStart = content.indexOf("content=", match.index);
  if (bodyStart < 0) return null;
  return { sender: match[1], body: content.slice(bodyStart + "content=".length) };
}

// Every message a spawned subagent sent in this transcript, oldest first, each
// tied back to the spawn that produced it.
//
// Returns [{ step, agent, sender, body, sessionDir, repoRoot, repoKey }].
function subagentMessages(transcriptPath) {
  const steps = readTranscript(transcriptPath);
  const spawnsById = new Map();
  let pending = [];
  const records = [];

  for (const step of steps) {
    const content = contentOf(step);

    for (const call of toolCallsOf(step)) {
      if (SPAWN_TOOLS.has(call && call.name)) pending = requestedSubagents(call);
    }

    const ids = spawnedIdsFrom(content);
    if (ids.length) {
      ids.forEach((id, index) => {
        const requested = pending[index] || pending[0];
        if (requested && requested.agent) spawnsById.set(id, requested);
      });
      pending = [];
      continue;
    }

    const message = messageFrom(content);
    if (!message) continue;
    const spawn = spawnsById.get(message.sender);
    if (!spawn) continue; // unpaired sender — not evidence of anything

    records.push({
      step: typeof step.step_index === "number" ? step.step_index : records.length,
      agent: spawn.agent,
      sender: message.sender,
      body: message.body,
      sessionDir: field(spawn.prompt, "Session dir"),
      repoRoot: field(spawn.prompt, "Repo root"),
      repoKey: field(spawn.prompt, "Repo key"),
    });
  }

  return records;
}

// The subset of those messages that carry a fact-check verdict, parsed.
//
// Returns [{ step, agent, sender, verdict, target, findings, sessionDir, repoRoot, repoKey }].
function subagentVerdicts(transcriptPath) {
  const records = [];
  for (const message of subagentMessages(transcriptPath)) {
    const payload = extractJsonObject(message.body);
    if (!payload) continue;
    const verdict =
      payload.verdict === "PASS" || payload.verdict === "FAIL" ? payload.verdict : null;
    const target = payload.target === "spec" || payload.target === "plan" ? payload.target : null;
    if (!verdict || !target) continue;
    records.push({
      step: message.step,
      agent: message.agent,
      sender: message.sender,
      verdict,
      target,
      findings: Array.isArray(payload.findings) ? payload.findings : [],
      sessionDir: message.sessionDir,
      repoRoot: message.repoRoot,
      repoKey: message.repoKey,
    });
  }
  return records;
}

// Who THIS conversation is, for a hook running inside a subagent's own AGY
// conversation.
//
// AGY sends no `agent_type` (the field every other harness adds inside a
// subagent's turn) and no session context: a hook firing on the subagent's own
// build command sees only that conversation's id, which is not the pipeline's
// session id. Every per-agent hook was therefore inert inside AGY subagents —
// build-streak counted nothing, and its escalation gate could never fire.
//
// The identity comes from the spawn prompt, which is this conversation's own first
// step: hooks/model-router.js stamps `Ultracode agent:` into every AGY spawn it
// routes, alongside the `Repo root:`/`Session dir:` lines the orchestrator already
// writes. Read back here, that gives a hook its agent name and the session dir the
// pipeline actually uses. A prompt without the stamp yields nulls — callers then
// behave exactly as they did before, rather than guessing.
function selfContext(transcriptPath) {
  const steps = readTranscript(transcriptPath);
  const first = steps.find((step) => step && step.type === "USER_INPUT" && contentOf(step));
  const content = first ? contentOf(first) : "";
  if (!content) return { agent: "", sessionDir: "", repoRoot: "", repoKey: "", primaryRepoRoot: "" };
  return {
    agent: bareAgentName(field(content, "Ultracode agent")),
    sessionDir: field(content, "Session dir"),
    repoRoot: field(content, "Repo root"),
    repoKey: field(content, "Repo key"),
    primaryRepoRoot: field(content, "Ultracode primary repo"),
  };
}

// What a tool call printed, for the PostToolUse hooks AGY leaves empty-handed: its
// payload reports `stepIdx` and (on failure) `error`, never the output. In the
// transcript the output is the result step's content — "The command exited with
// code 0.\nOutput:\n…" — and `stepIdx` is that step's own index. The step before
// it is checked too, since a harness that numbered the call rather than the result
// would otherwise silently return nothing.
function toolResultText(transcriptPath, stepIdx) {
  if (typeof stepIdx !== "number") return "";
  const steps = readTranscript(transcriptPath);
  for (const candidate of [stepIdx, stepIdx + 1]) {
    const step = steps.find(
      (entry) => entry && entry.step_index === candidate && !Array.isArray(entry.tool_calls),
    );
    const content = step ? contentOf(step) : "";
    if (content) return content;
  }
  return "";
}

module.exports = {
  subagentMessages,
  subagentVerdicts,
  selfContext,
  toolResultText,
  readTranscript,
};
