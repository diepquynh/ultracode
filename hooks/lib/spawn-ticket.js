"use strict";

// Spawn tickets: the plaintext side-channel for the subagent parameter
// contract on harnesses whose spawn messages are end-to-end encrypted.
//
// Codex with OpenAI models never possesses the plaintext of a
// collaboration `spawn_agent` message — the API returns the tool arguments
// as ciphertext (`encrypted_function_args`) and the client forwards them
// sealed, so no hook can read the `Label: value` lines out of the prompt.
// The contract still has to be enforced mechanically, so the orchestrator
// files the same fields through the ultracode_spawn_ticket MCP tool (plain
// function-tool arguments are never encrypted) immediately before each
// spawn, and hooks/session-guard.js validates and consumes that ticket
// instead of the unreadable prompt.
//
// Tickets live in machine state (~/.ultracode/spawn-tickets), which is
// write-guarded against model-issued writes (hooks/lib/common.js
// isMachineStatePath): the only way a model can produce one is through the
// MCP tool, which validates the fields against hooks/subagent-parameters.json
// before writing. A ticket is single-use (session-guard marks it consumed on
// the spawn it authorizes) and short-lived, so a stale ticket from an earlier
// stage cannot quietly vouch for a later spawn.

const fs = require("node:fs");
const path = require("node:path");
const { machineStateRoot, sanitizeSessionId } = require("./common");

const TICKET_TTL_MS = 15 * 60 * 1000;

function ticketsDir() {
  return path.join(machineStateRoot(), "spawn-tickets");
}

function sessionTicketsDir(harness, nativeSessionId) {
  return path.join(ticketsDir(), `${harness}:${sanitizeSessionId(nativeSessionId)}`);
}

// Writes one ticket. `parameters` is keyed by subagent-parameters.json
// parameter name (repo_root, session_dir, ...) — the exact values the
// encrypted prompt's `Label:` lines carry. Validation happens in the MCP
// tool before this is called; this module only stores and retrieves.
function fileTicket(harness, nativeSessionId, agent, parameters) {
  const dir = sessionTicketsDir(harness, nativeSessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const target = path.join(dir, `${id}.json`);
  const data = {
    harness,
    harness_session_id: nativeSessionId,
    agent,
    parameters,
    filed_at: new Date().toISOString(),
  };
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
  return { id, path: target, data };
}

// Newest ticket for (session, agent) filed within the TTL, consumed or not.
// Consumption does not hide a ticket from reads: the PreToolUse hooks that
// run after session-guard in the same spawn call — and the PostToolUse
// recorders — all resolve the same ticket the guard just consumed. The
// guard alone cares about the consumed_at flag (single-use enforcement).
function findTicket(harness, nativeSessionId, agent) {
  const dir = sessionTicketsDir(harness, nativeSessionId);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let newest = null;
  for (const name of names) {
    if (!name.startsWith(`${agent}-`) || !name.endsWith(".json")) continue;
    const ticketPath = path.join(dir, name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(ticketPath, "utf-8"));
    } catch {
      continue;
    }
    if (!data || data.agent !== agent || typeof data.parameters !== "object") continue;
    const filedAt = Date.parse(data.filed_at || "");
    if (!Number.isFinite(filedAt) || Date.now() - filedAt > TICKET_TTL_MS) continue;
    if (!newest || filedAt > newest.filedAt) newest = { path: ticketPath, data, filedAt };
  }
  return newest ? { path: newest.path, data: newest.data } : null;
}

function consumeTicket(ticketPath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(ticketPath, "utf-8"));
  } catch {
    return false;
  }
  data.consumed_at = new Date().toISOString();
  const tmp = `${ticketPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, ticketPath);
  return true;
}

module.exports = { TICKET_TTL_MS, ticketsDir, sessionTicketsDir, fileTicket, findTicket, consumeTicket };
