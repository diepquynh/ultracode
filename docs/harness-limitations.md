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
## Hub wake channels (checked 2026-08-30, not yet re-measured on qualifying versions)

The cross-harness hub (docs/hub.md) can wake an idle interactive session only where the harness has a
steering channel; everywhere else delivery is pull-only (`ultracode_msg_wait`). Feature flags stay off until
a live run on a qualifying CLI version is recorded here.

- **Claude Code**: cross-session messaging (named sessions, per-session Unix sockets under `/tmp/cc-socks`,
  session records under `~/.claude/sessions/`) ships in ≥2.1.224. Verified live on 2.1.251 (2026-08-30): the
  `mcp/lib/push/claude.js` frame pair (`{type:"auth",token}` from `<pid>.<sha256(socketPath)>.key`, then
  `{type:"user",message}`) reached a background session, whose recipient verified the sender pid. Two measured
  facts shape the adapter: (1) the wire protocol is undocumented and version-specific, so it stays behind
  `ULTRACODE_HUB_CLAUDE_PUSH=1` and degrades to pull on any mismatch; (2) a recipient in `bypassPermissions`
  mode HOLDS an unattested peer message for user approval ("The sender did not attest its permission mode and
  this session bypasses prompts... set crossSessionInbound to accept") — the adapter respects that gate rather
  than bypassing it, which is safe because the pushed payload is only a wake notice.
- **Codex**: `codex queue` (deliver-to-named-session) ships in ≥0.149.0. Measured CLI is 0.147.0, where
  `codex queue --help` fails — the adapter's feature-detect correctly reports unavailable and Codex sessions
  are pull-only until an upgrade.
- **Grok Build 1.0.13 / Antigravity 1.1.22**: no external steering channel found in either (AGY's
  `send_message` is intra-conversation only). Pull-only by design, not by flag.

Two hub-relevant behaviors measured live on 2026-08-30 while verifying the shim end to end:

- **Codex 0.147.0 `exec` cancels MCP tool calls under its default approval policy.** A plain `codex exec`
  reports `approval: never` yet every MCP call fails with "user cancelled MCP tool call"; the same run with
  `--dangerously-bypass-approvals-and-sandbox` completes them. Headless Codex use of the hub tools needs that
  flag (or an approvals config that actually covers MCP) until a newer CLI fixes the default.
- **Codex 0.151.0 does not expand `${PLUGIN_ROOT}` in plugin-manifest `mcpServers` args** (measured
  2026-08-30, session 01a051bb…): `codex mcp list` shows the literal `${PLUGIN_ROOT}/mcp/hub-shim.js`, the
  spawned node dies on MODULE_NOT_FOUND, and the session exposes zero ultracode tools — hub-listen reports
  "this runtime has not exposed any of the required hub calls". Same class as AGY's inert `mcp_config.json`;
  install.sh works around both with an explicit absolute-path registration (`codex mcp add ultracode-gate --
  node <dist>/mcp/hub-shim.js`), which lands in `~/.codex/config.toml` and outranks the plugin manifest.
- **Grok 1.0.13 `-p` does not expose user-config stdio MCP servers in untrusted directories.** `grok mcp
  doctor` reported the shim healthy with 13 tools, while a `-p` run from an untrusted `/tmp` project saw only
  plugin-bundled servers and reported the same tools "not found". Run from a trusted project (or trust the
  directory first); project-local `.mcp.json` in an untrusted dir is ignored the same way.

- **Grok has no ask decision at all, so the cap's ask is broken there.** Measured on CLI 1.0.5 with a
  config-layer hook (`[[hooks.PreToolUse]]` in `~/.grok/config.toml`, which runs without project hook trust):
  both the Claude-shaped `permissionDecision: "ask"` and a top-level `{"decision":"ask"}` fail open and the call
  runs, while top-level `{"decision":"deny"}` is honored even under `--permission-mode bypassPermissions`. So
  `review-cap.js` keeps a denial on Grok instead of a gate that vanishes: a Grok user is never prompted and
  cannot approve a 4th review pass at the prompt at all — the orchestrator has to relay the question — and any
  future "let the user decide" hook inherits the same hole.
