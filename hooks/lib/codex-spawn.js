"use strict";

// Codex spawn-channel policy. Every codex-only branch in the spawn hooks
// lives behind this module, so call sites read as intent ("skip sealed
// routing", "pin fork_turns") instead of each carrying the exposition.
//
// The facts everything here follows from (source citations and the live
// incidents: docs/harness-limitations.md):
//
//   * SEALED MESSAGES — codex with OpenAI models encrypts collaboration
//     spawn messages end-to-end. The `message` argument reaches hooks as
//     ciphertext (spawn.promptOpaque, detected in hooks/lib/harness.js) and
//     is decrypted server-side for the child; results come back the same
//     way and dispatch no hook at all. Only the plaintext arguments
//     (agent_type, fork_turns, model) and plain MCP tool calls are visible
//     client-side. So: the parameter contract travels via spawn tickets
//     (hooks/lib/spawn-ticket.js, filed through the tools in
//     mcp/sealed-channel-tools.js), and the sealed message itself must
//     never be rewritten — an appended repo brief would corrupt the
//     ciphertext and feed the child garbage.
//
//   * FORK DEFAULT — codex treats an ABSENT fork_turns as "all" (the whole
//     parent conversation is copied into the child), so removing the
//     argument is not opting out. Ultracode agents run forked OFF; only an
//     explicit "none" delivers that, so the router pins it on every spawn.

const path = require("node:path");
const { consumeTicket, findTicket } = require("./spawn-ticket");

// Contract values for a sealed spawn come from its ticket; a readable spawn
// passes through untouched. Returns the ticket too — session-guard needs it
// for single-use accounting — and never mutates it: every hook in the same
// spawn call resolves the same ticket, consumed or not.
function resolveSealedContract(target, sessionId, spawn, parameters) {
  if (!spawn.promptOpaque || !spawn.agent) return { parameters, ticket: null };
  const ticket = findTicket(target, sessionId, spawn.agent);
  if (!ticket) return { parameters, ticket: null };
  return { parameters: { ...parameters, ...ticket.data.parameters }, ticket };
}

// A sealed prompt has no `Repo root:` line to parse, so the work repo comes
// from the ticket; empty means "fall back to the payload cwd" as usual.
function sealedWorkRepoRoot(spawn, parameters) {
  if (!spawn.promptOpaque) return "";
  if (!parameters.repo_root || !path.isAbsolute(parameters.repo_root)) return "";
  return path.resolve(parameters.repo_root);
}

// session-guard's sealed-spawn preconditions, as one denial text or "".
// No ticket → the contract is unverifiable, refused with the tool call that
// fixes it. Consumed ticket → single-use replay, refused: one ticket vouches
// for one spawn, including retries.
function sealedSpawnDenial(spawn, sessionId, label) {
  if (!spawn.promptOpaque) return "";
  if (!spawn.ticket) {
    return (
      `ultracode: refusing ${label} because this spawn message is ` +
      `end-to-end encrypted, so its required parameter contract cannot be read from the prompt. ` +
      `Call the ultracode_spawn_ticket tool first — harness_session_id: "${sessionId}", ` +
      `agent: "${spawn.agent}", parameters: the same values as the prompt's Label: lines ` +
      `(keys like repo_root, session_dir, repo_key, task) — then re-spawn. One ticket per spawn.`
    );
  }
  if (spawn.ticket.data.consumed_at) {
    return (
      `ultracode: refusing ${label} because its spawn ticket was ` +
      `already consumed by an earlier spawn. Tickets are single-use: file a fresh ` +
      `ultracode_spawn_ticket for this spawn and re-spawn.`
    );
  }
  return "";
}

// Burn the ticket on the spawn it authorizes. Runs before session-guard's
// remaining checks so a denied spawn also burns it — the orchestrator
// re-files with corrected values either way, and a rejected ticket must not
// be replayable for the retry.
function consumeSealedTicket(spawn) {
  if (spawn.promptOpaque && spawn.ticket) consumeTicket(spawn.ticket.path);
}

// model-router: a sealed spawn without a ticket gets no routing attempt —
// resolving against ticketless (empty) parameters would pick the wrong repo,
// and session-guard owns the actionable denial for this call.
function skipSealedRouting(spawn) {
  return Boolean(spawn.promptOpaque && !spawn.ticket);
}

// model-router: only a readable prompt may be rewritten (brief, stamps).
function promptRewritable(spawn) {
  return !spawn.promptOpaque;
}

// model-router: the fork_turns pin, as an args patch or null. Plaintext even
// when the message is sealed, so it is enforceable on every codex spawn.
function forkTurnsPin(routingTarget, spawn) {
  if (routingTarget !== "codex" || spawn.shape !== "flat") return null;
  if (spawn.raw.fork_turns === "none") return null;
  return { fork_turns: "none" };
}

module.exports = {
  resolveSealedContract,
  sealedWorkRepoRoot,
  sealedSpawnDenial,
  consumeSealedTicket,
  skipSealedRouting,
  promptRewritable,
  forkTurnsPin,
};
