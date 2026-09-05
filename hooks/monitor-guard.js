#!/usr/bin/env node
// Keep Grok Build's `monitor` tool from becoming the hole in Hard rule 19.
//
// `monitor` takes a shell command, runs it detached, and turns every line it
// prints into an event that wakes the session. That makes it the right tool for
// the hub listening state on a harness with no push channel, and it also makes
// it a way to do exactly what Hard rule 19 forbids by another route: a monitor
// running `while true; do sleep 5; cat agent-out.log; done` is a subagent poll
// with extra steps. The shell guards never see it, because grok dispatches
// `monitor` under its own tool name and not under run_terminal_command.
//
// So this hook applies the same patterns bash-guard applies (hooks/lib/
// poll-policy.js owns both), with one exemption: the hub wake monitor, whose
// loop long-polls the hub's /api/v1/messages/wait route and therefore parks on a
// socket instead of spinning. Registered on the `monitor` matcher alongside
// plugin-guard.js and bash-scope-guard.js, which cover the other two things an
// unwatched shell command could do (run the plugin's own code, write where the
// caller may not).
//
// Orchestrator-only, matching bash-guard: a subagent's monitor cannot hold the
// orchestrator's turn open, and subagents do not spawn the children this rule
// exists to stop anyone from polling.

"use strict";

const {
  readHookInput,
  denyPreToolUse,
  hookToolInput,
  hookAgentType,
  commandFromToolInput,
} = require("./lib/common");
const { bannedPollPattern, isHubWakeMonitor } = require("./lib/poll-policy");

async function main() {
  const hookInput = await readHookInput();
  if (!hookInput) return 0;
  if (hookAgentType(hookInput)) return 0;

  const toolInput = hookToolInput(hookInput);
  const command = commandFromToolInput(toolInput);
  if (!command) return 0;

  if (isHubWakeMonitor(command)) return 0;

  const hit = bannedPollPattern(command);
  if (hit) {
    denyPreToolUse(
      `ultracode: refusing a monitor built on ${hit.label} (Hard rule 19 — a monitor streams events, ` +
        "it does not poll). Watch the thing itself (tail -f, inotifywait) so the event is the change. " +
        "To wait on the hub, monitor its /api/v1/messages/wait long poll.",
      `ultracode: refusing a monitor built on ${hit.label} (Hard rule 19). Watch the thing itself ` +
        "(tail -f, inotifywait) instead of polling it, or monitor the hub's /api/v1/messages/wait long poll.",
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
