"use strict";

// Native push delivery: wake the target harness's interactive session so a
// hub message becomes a new turn there, instead of waiting for its next
// ultracode_msg_wait. Delivery is strictly best-effort — the message row is
// committed before any push is attempted, so a failed, timed-out, or
// unsupported push can never lose a message; it just stays queued for pull.
//
// Push is ON BY DEFAULT for harnesses with a verified channel (claude, codex;
// both verified live 2026-08-30 — see docs/hub.md's verification ledger), and
// needs no per-session setup: when a session registered no explicit
// native_channel, the channel is inferred from its harness and the adapter
// addresses it by its harness session id (Claude session records carry the
// sessionId; `codex queue --thread` takes the thread UUID). An explicit
// native_channel/native_address still wins — e.g. a /rename'd session name.
// ULTRACODE_HUB_CLAUDE_PUSH=0 / ULTRACODE_HUB_CODEX_PUSH=0 opt a daemon out.

const PUSH_TIMEOUT_MS = 3000;

const adapters = {
  "codex-queue": () => require("./codex"),
  "claude-uds": () => require("./claude"),
};

const DEFAULT_CHANNEL_BY_HARNESS = {
  claude: "claude-uds",
  codex: "codex-queue",
  // grok / antigravity: no external steering channel exists (measured) — pull only.
};

function channelFor(session) {
  if (!session) return null;
  if (session.native_channel && session.native_channel !== "none") return session.native_channel;
  return DEFAULT_CHANNEL_BY_HARNESS[session.harness] || null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`push timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The pushed text is a wake NOTICE, not the payload: the recipient fetches
// the actual messages over the authenticated channel, so a native transport
// never carries message bodies and a spoofed notice can at worst trigger an
// empty fetch.
function wakeNotice(session, pendingCount) {
  return (
    `ultracode-hub: ${pendingCount} new message(s) for you. ` +
    `Call ultracode_msg_wait with session_key=${session.session_key} and your last cursor to fetch them.`
  );
}

async function attemptPush(session, notice, { log } = {}) {
  const channel = channelFor(session);
  const load = channel && adapters[channel];
  if (!load) return { pushed: false, channel: null };
  try {
    const adapter = load();
    const ok = await withTimeout(Promise.resolve(adapter.push(session, notice)), PUSH_TIMEOUT_MS);
    return { pushed: Boolean(ok), channel };
  } catch (error) {
    if (log) log(`push via ${channel} to ${session.session_key} failed: ${error.message}`);
    return { pushed: false, channel };
  }
}

module.exports = { attemptPush, wakeNotice, channelFor, PUSH_TIMEOUT_MS };
