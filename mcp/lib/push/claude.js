"use strict";

// Claude Code push adapter. Claude Code (≥2.1.224, verified live on 2.1.251)
// gives every session a name and a per-session Unix domain socket — the
// substrate its own cross-session SendMessage/ListAgents use. Delivering a
// user frame to that socket wakes the target session as a new turn.
//
// The wire protocol is REVERSE-ENGINEERED from the CLI (it is not a published
// API) and is therefore version-specific and fragile: session records live in
// ~/.claude/sessions/<pid>.json, the peer auth token in the sibling
// <pid>.<sha256(socketPath)>.key, and frames are newline-delimited JSON — an
// {type:"auth",token} frame followed by a {type:"user",message:{...}} frame.
// Because it can break on any Claude update, the adapter stays behind
// ULTRACODE_HUB_CLAUDE_PUSH=1 and every failure returns false, degrading that
// message to pull (ultracode_msg_wait) rather than erroring.
//
// It intentionally does NOT try to bypass Claude's inbound-safety gate: a
// session in bypassPermissions mode HOLDS a peer message for the user's
// approval (a message from another session is not the user's own consent).
// That is correct — our payload is only a wake notice ("call
// ultracode_msg_wait"), so a held or missed push costs nothing; pull still
// delivers the real content over the authenticated hub channel.
//
// ULTRACODE_CLAUDE_SESSIONS_DIR overrides the records directory (tests point
// it at a fixture); default ~/.claude/sessions.

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const WRITE_TIMEOUT_MS = 2000;

function enabled() {
  return process.env.ULTRACODE_HUB_CLAUDE_PUSH === "1";
}

function sessionsDir() {
  return process.env.ULTRACODE_CLAUDE_SESSIONS_DIR || path.join(os.homedir(), ".claude", "sessions");
}

// A session record is <pid>.json carrying at least
// { pid, sessionId, name, messagingSocketPath }. Match the caller's
// native_address against the session name (set by /rename or --name).
function findSession(sessionName) {
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir());
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(sessionsDir(), entry), "utf-8"));
      if (
        record &&
        record.name === sessionName &&
        typeof record.messagingSocketPath === "string" &&
        record.messagingSocketPath &&
        Number.isInteger(record.pid)
      ) {
        return record;
      }
    } catch {
      // unreadable/torn record — keep scanning
    }
  }
  return null;
}

// The peer auth token: <pid>.<sha256(socketPath)>.key, JSON { peerToken }.
function readPeerToken(record) {
  const hash = crypto.createHash("sha256").update(record.messagingSocketPath).digest("hex");
  const keyFile = path.join(sessionsDir(), `${record.pid}.${hash}.key`);
  try {
    const key = JSON.parse(fs.readFileSync(keyFile, "utf-8"));
    return key && typeof key.peerToken === "string" && key.peerToken ? key.peerToken : null;
  } catch {
    return null;
  }
}

function deliverFrames(socketPath, frames) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, WRITE_TIMEOUT_MS);
    let wrote = false;
    socket.on("connect", () => {
      for (const frame of frames) socket.write(`${JSON.stringify(frame)}\n`);
      wrote = true;
      socket.end();
    });
    // The transport does not ack on this socket; a clean connect + write + FIN
    // is the success signal (Claude has verified the sender pid by then).
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(wrote);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function push(session, notice) {
  if (!enabled()) return false;
  const record = findSession(session.native_address);
  if (!record) return false;
  const peerToken = readPeerToken(record);
  if (!peerToken) return false;
  return deliverFrames(record.messagingSocketPath, [
    { type: "auth", token: peerToken },
    {
      uuid: crypto.randomUUID(),
      session_id: record.sessionId,
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: notice },
      priority: "next",
    },
  ]);
}

module.exports = { push, enabled, findSession, readPeerToken, sessionsDir };
