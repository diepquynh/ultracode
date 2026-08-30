"use strict";

// Native push delivery: wake the target harness's interactive session so a
// hub message becomes a new turn there, instead of waiting for its next
// ultracode_msg_wait. Delivery is strictly best-effort — the message row is
// committed before any push is attempted, so a failed, timed-out, or
// unsupported push can never lose a message; it just stays queued for pull.

const PUSH_TIMEOUT_MS = 3000;

const adapters = {
  "codex-queue": () => require("./codex"),
  "claude-uds": () => require("./claude"),
};

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
  const load = adapters[session && session.native_channel];
  if (!load || !session.native_address) return { pushed: false, channel: null };
  try {
    const adapter = load();
    const ok = await withTimeout(Promise.resolve(adapter.push(session, notice)), PUSH_TIMEOUT_MS);
    return { pushed: Boolean(ok), channel: session.native_channel };
  } catch (error) {
    if (log) log(`push via ${session.native_channel} to ${session.session_key} failed: ${error.message}`);
    return { pushed: false, channel: session.native_channel };
  }
}

module.exports = { attemptPush, wakeNotice, PUSH_TIMEOUT_MS };
