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
- Codex spawn hooks: REINTERPRETED against the open-source tree (2026-08-30, openai/codex@main). Every
  function tool — the v2 collaboration `spawn_agent` included — produces a PreToolUse payload
  (`core/src/tools/registry.rs` default `pre_tool_use_payload`), BUT the hook-facing tool name for a
  namespaced v2 tool is the namespace-prefixed flat name (`core/src/tools/mod.rs` `flat_tool_name`), and
  codex hook matchers made only of `[A-Za-z0-9_|]` are EXACT-equality matchers
  (`hooks/src/events/common.rs` `is_exact_matcher`). Ultracode's old `Agent|spawn_agent` matcher therefore
  could never match a v2 spawn — the measured "spawn sailed past session-guard" on 0.147/0.151 is explained
  by the matcher, not (necessarily) by missing dispatch. The generated matcher is now the regex
  `(Agent|spawn_agent)$`, which matches the canonical name, the Claude-style `Agent` alias
  (`core/src/tools/hook_names.rs`), and the namespaced flat name, while excluding
  wait/close/resume/interrupt_agent. Changing the matcher changes the hook trust hash: codex users must
  re-trust in `/hooks` after updating, and live verification that a denial actually blocks a v2 spawn on a
  shipped CLI is still OPEN. Bash-matcher PreToolUse hooks are confirmed firing in `codex exec` (unified and
  legacy exec) with `[hooks.state]` trust persisting across plugin updates whose hook commands are unchanged.
  Generated leaf prompts continue to repeat the parameter contract as the fallback.
- **Codex plugin-cache refreshes can silently drop whole directories** (measured 2026-08-30, root cause of
  session 01a05219… running with ZERO hooks): re-adding the plugin at the SAME version left the cache copy
  with no `hooks/` directory at all — no error, no warning, hooks simply never fire. A fresh add after a
  version bump restored it. install.sh now verifies `hooks/hooks.json` and `mcp/hub-shim.js` exist in the
  reported cache root after `codex plugin add` and repairs once with remove + re-add. When shipping plugin
  changes, always bump the plugin version rather than re-adding the same one. Related and harsher
  (measured 2026-08-30): codex's reconciler runs at every session startup and, if it reads the local
  marketplace while the staged plugin directory is mid-refresh (an rm-then-copy window), it DELISTS the
  plugin — uninstalling it, removing the marketplace registration, and deleting the `ultracode-gate` entry
  from config.toml (the `[agents.*]` block and `[hooks.state]` trust survive). install.sh now swaps the
  staged copy atomically (build beside, then `mv`); anyone refreshing the staged copy by hand must do the
  same, and recovery is: marketplace add → plugin add → `codex mcp add ultracode-gate` with the absolute
  shim path.

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
steering channel; everywhere else delivery is pull-only (`ultracode_msg_wait`). Channels turn on by default
only once a live run on a qualifying CLI version is recorded here — claude and codex are (see below);
grok and antigravity have no channel to gate.

- **Claude Code**: cross-session messaging (named sessions, per-session Unix sockets under `/tmp/cc-socks`,
  session records under `~/.claude/sessions/`) ships in ≥2.1.224. Verified END-TO-END on 2.1.251
  (2026-08-30): the `mcp/lib/push/claude.js` frame pair (`{type:"auth",token}` from
  `<pid>.<sha256(socketPath)>.key`, then `{type:"user",message}`) woke a live interactive session, whose
  recipient verified the sender pid — so the adapter is **on by default** (`ULTRACODE_HUB_CLAUDE_PUSH=0` opts
  out), matching records by name or `sessionId` so no per-session `native_address` is needed. Two measured
  facts still shape it: (1) the wire protocol is undocumented and version-specific, so any mismatch degrades
  to pull rather than erroring; (2) a recipient in `bypassPermissions` mode HOLDS an unattested peer message
  for user approval ("The sender did not attest its permission mode and this session bypasses prompts... set
  crossSessionInbound to accept") — the adapter respects that gate rather than bypassing it, which is safe
  because the pushed payload is only a wake notice.
- **Codex**: `codex queue` ships in ≥0.149.0; syntax verified on 0.151.0 (2026-08-30):
  `codex queue --thread <session-UUID-or-exact-name> --message <text>`, pinned in `mcp/lib/push/codex.js`
  and **on by default** (`ULTRACODE_HUB_CODEX_PUSH=0` opts out; `--thread` takes the thread UUID, so no
  per-session naming is needed). A CLI without `queue` (0.147.0 was measured failing `codex queue --help`)
  feature-detects as unavailable and stays pull-only.
- **Grok Build 1.0.13 / Antigravity 1.1.22**: no external steering channel found in either (AGY's
  `send_message` is intra-conversation only). Pull-only by design, not by flag.

## Tool-call duration caps (live, 2026-08-30)

Every harness bounds how long one tool call may run, which is what actually ends an "infinite"
`ultracode_msg_wait` park (`timeout_ms: 0`) when the user does not. The park is designed to survive this:
whatever cuts the call, the registration stays alive (7-day idle expiry, parked waiters exempt from sweeps)
and the cursor re-reads everything on the next wait — so a cap costs a re-run of `/ultracode:hub-listen`,
never a message.

- **Codex 0.151.0** (session 01a05219…): long tool calls are moved to background cells that the model polls
  with its `wait` tool (~60 s yields); after several yields the harness cut the listening park — the session
  reported "listening stopped because the harness capped the long-running tool call". In practice the cap is
  irrelevant on Codex: the hub's `codex-queue` push woke the same session as a fresh user turn moments later,
  which is the intended wake path anyway.
- **Claude Code 2.1.251**: a 110 s `msg_wait` completed with `MCP_TOOL_TIMEOUT=180000` set; the default cap
  was not measured. The env var is the lever when a Claude session should hold a long park — though Claude
  sessions, like Codex, normally get woken by push rather than by holding the park.
- **Antigravity 1.1.22**: a 110 s wait completed headless under `--print-timeout 5m` (that flag bounds the
  whole print run); the interactive-session cap is unmeasured. AGY is pull-only, so a generous park is its
  main delivery path — expect to re-run hub-listen when the harness cuts it.
- **Grok 1.0.13**: only short (≤25 s) waits measured so far; also pull-only, same re-run story.

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
- **Codex 0.151.0 does not read agent roles from a plugin** (measured 2026-08-30, session 01a051cc…): valid
  `spawn_agent` `agent_type` values come only from `[agents.<name>]` tables in `~/.codex/config.toml`
  (`config_file` pointing at a role TOML). A spawn naming a plugin role fails with `unknown agent_type`, and
  a session left without registered roles improvises — it reads the role TOML as a document and pastes it
  into a generic `fork_turns` agent, which has no role binding (tools/model/prompt contract all lost) and
  which it then tracks poorly (repeated bare 50 s `wait_agent` timeouts; `wait_agent` wants specific ids).
  install.sh registers every generated role via `scripts/register_codex_agents.js` (a managed block in
  config.toml); codex agent_type names are `ultracode_<name>` because the charset forbids `:`.
- **Codex subagents inherit the spawner's model unless the role config pins one** (measured 2026-08-30): with
  no `model` in the role TOML and no `agents.default_subagent_model`, every spawned child ran on the parent's
  model — a `gpt-5.6-sol` orchestrator ran even `implement` leaves on sol (paying advanced price for balanced
  work), and a luna parent ran them on luna. The `[agents.<name>].config_file` layer's `model` key IS honored
  (the child starts on the inherited model, then `thread_settings_applied` switches it before the first turn),
  so generated codex role TOMLs now bake each role's tier default in. Consequence: model routing on codex is
  **static tier defaults only** — the model-router hook never runs there, so `repo-profile.json` `models`
  routes (byAgent/byPhaseComplexity overrides) do not apply to codex spawns. The per-call `model` argument is
  no escape hatch either — confirmed in source (openai/codex@main): the spawn handler applies the requested
  model FIRST and the role layer AFTER (`core/src/tools/handlers/multi_agents_v2/spawn.rs`), and a role
  `config_file` model unconditionally overwrites (`core/src/agent/role.rs` `build_next_config`); codex even
  advertises a role's model in the spawn tool spec as "cannot be changed". The gate for the argument is
  `[features.multi_agent_v2].expose_spawn_agent_model_overrides` (an earlier note called it unreachable —
  wrong: it nests under `features`), but it only adds the schema field; the role model still wins. Roles
  WITHOUT a baked model fall back to the argument, then `[agents].default_subagent_model`, then inheritance —
  ultracode bakes the model precisely so the routed tier is the locked outcome. init-kit's per-mode model
  choices are therefore inert on codex; its initializer runs on the tier default baked into its role TOML.
- **Codex `spawn_agent`'s `fork_turns` inverts ultracode's `context: fork`** (measured 2026-08-30, session
  01a05219…): ultracode's "fork" means the agent runs forked OFF — self-contained prompt, never seeing the
  parent conversation — while Codex's `fork_turns: "all"` copies every parent turn INTO the child. A session
  that mapped one onto the other spawned each pipeline role with the entire orchestrator conversation
  embedded (a 2.3 MB child rollout for one fact-check), leaking orchestration context into leaves and
  leaving children as lingering separate threads (`close_agent` never called). The generated role TOML
  header and the orchestrate/hub-listen skills now state the spawn contract explicitly: `agent_type` + the
  self-contained prompt, never `fork_turns`, and close finished agents.
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
