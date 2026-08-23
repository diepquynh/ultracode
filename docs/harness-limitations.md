# Harness limitations

What each harness currently does *not* do the way Ultracode's design assumes. Every entry here was measured on
a live run of that CLI, not read from its documentation, and every one of them changes what a guard can enforce
— a hook that a harness never dispatches, or whose output it discards, is a rule that exists only on paper.

Dates are when the behavior was last measured; re-check an entry before relying on it after a CLI update.

## Hook dispatch and payload shape (live, 2026-08-22)

- Claude Code 2.1.220 and Antigravity CLI 1.1.18 dispatch Ultracode plugin spawn hooks. Claude rewrites must
  live only in `hookSpecificOutput.updatedInput` — a top-level `overwrite` fails Claude's hook schema and is
  discarded. Claude's `Agent` tool is async by default: `PostToolUse:Agent` sees only the launch ack
  (`Async agent launched successfully…`), so `hooks/factcheck-record.js` also registers on `SubagentStop`
  (`matcher: ^ultracode:fact-check$`) and records from `last_assistant_message` plus the leaf transcript's
  spawn prompt. Claude leaf `PostToolUse` Bash events also often omit `agent_type`, so `build-streak.js` /
  `build-streak-gate.js` cannot attribute failures inside a forked implement/write-test turn even when the
  matching PreToolUse Bash call carried the actor.
- Grok CLI 1.0.5 currently discovers the Ultracode plugin (`has_hooks=true`) but expands **zero** plugin
  handlers into its runtime registry (`total_hooks=0`), so parent Bash/Write denials never fire either —
  this is broader than the earlier spawn-only bypass. Separately, Grok honors top-level `{decision:"deny"}`
  and fail-opens on Claude-style `hookSpecificOutput.permissionDecision`; Ultracode emits the Grok shape.
- Codex CLI 0.147.0 still does not dispatch plugin handlers for native `spawn_agent` (parent Bash/Write
  hooks can still fire once trusted). Generated leaf prompts therefore repeat the parameter contract and
  fail before their first tool call when a required line is missing.

## The ask channel (live, 2026-08-23)

The **ask** channel is how a hook hands a decision to the user instead of taking it. Only `hooks/review-cap.js`
uses it — the review-loop cap is a budget, not a safety rule, so the spawn past the cap is put to the user
rather than refused. `askPreToolUse` in `hooks/lib/common.js` picks the shape per harness.

- **Claude** honors `hookSpecificOutput.permissionDecision: "ask"`, including under
  `--dangerously-skip-permissions`: a hook's own ask result is returned before bypassPermissions mode can turn
  it into an allow. A headless `-p` run has nobody to prompt, so the ask arrives as a denial carrying the
  reason — the loop still stops with the cap named.
- **Antigravity** takes a top-level `{"decision": "force_ask", "reason": …}`. Plain `"ask"` respects the
  always-allow cache, so a user who once chose always-allow for subagent spawns would never be shown the
  question; `force_ask` was verified to override an existing `command(…)` allow rule where a silent hook let the
  same call through.
- **Grok has no ask decision at all, so the cap's ask is broken there.** Measured on CLI 1.0.5 with a
  config-layer hook (`[[hooks.PreToolUse]]` in `~/.grok/config.toml`, which runs without project hook trust):
  both the Claude-shaped `permissionDecision: "ask"` and a top-level `{"decision":"ask"}` fail open and the call
  runs, while top-level `{"decision":"deny"}` is honored even under `--permission-mode bypassPermissions`. So
  `review-cap.js` keeps a denial on Grok instead of a gate that vanishes: a Grok user is never prompted and
  cannot approve a 4th review pass at the prompt at all — the orchestrator has to relay the question — and any
  future "let the user decide" hook inherits the same hole.
