#!/usr/bin/env node
// Shared policy for Hard rule 19: what counts as a session holding its own turn
// open on nothing, and the one loop that is allowed to exist anyway.
//
// Two callers apply it to two different tools:
//
//   * hooks/bash-guard.js — a shell call. A sleep, a `wait`, or a busy-loop here
//     runs INSIDE the orchestrator's turn, which is the exact thing Hard rule 19
//     forbids: every foreground spawn already blocks until it returns, so there
//     is nothing for the session to wait on.
//
//   * hooks/monitor-guard.js — Grok Build's `monitor` tool. Its command runs as a
//     detached background stream, not in the turn, so it is not a keepalive. It
//     is still a way to poll (a `sleep` loop over a subagent's output file wakes
//     the session on every tick), so the same patterns apply.
//
// The exception is the hub wake monitor. On a harness with no push channel the
// listening state has to live somewhere, and on Grok it is a monitor whose loop
// long-polls the hub's own /api/v1/messages/wait endpoint: the hub blocks that
// request server side until a message lands, so the loop spends its life parked
// on a socket rather than spinning. That endpoint in the command is the whole
// signature — no other URL grants the exemption, and the ordinary patterns still
// apply to every other monitor. See docs/hub.md, "Waiting without parking".

"use strict";

const BANNED_PATTERNS = [
  { pattern: /^\s*(true|:)\s*;?\s*$/, label: "a no-op keepalive (`true`/`:`)" },
  { pattern: /(^|[;&|]|\bthen\b|\bdo\b)\s*sleep\s+[\d.]/i, label: "`sleep`" },
  { pattern: /^\s*wait\b/im, label: "`wait`" },
  { pattern: /\b(while|until)\b[^\n]*\bsleep\b/is, label: "a sleep-polling loop" },
  { pattern: /keep[- ]?alive/i, label: "a keepalive command" },
  { pattern: /hold\s+the\s+turn\s+open/i, label: 'a "hold the turn open" command' },
];

// The hub's long-poll route. Matched on the path alone: the host is whatever
// port hub.json recorded, and the scheme is always loopback http.
const HUB_WAIT_ROUTE = /\/api\/v1\/messages\/wait\b/;

// True when a monitor command is the sanctioned hub wake loop. Deliberately
// narrow: it must actually call the long-poll route, so a command that merely
// mentions the hub in a comment or polls some other hub route is not exempt.
function isHubWakeMonitor(command) {
  return typeof command === "string" && HUB_WAIT_ROUTE.test(command);
}

// The first banned pattern a command matches, or null. Callers own the denial
// wording so each tool can name what it refused.
function bannedPollPattern(command) {
  if (typeof command !== "string" || !command) return null;
  return BANNED_PATTERNS.find(({ pattern }) => pattern.test(command)) || null;
}

module.exports = {
  BANNED_PATTERNS,
  HUB_WAIT_ROUTE,
  isHubWakeMonitor,
  bannedPollPattern,
};
