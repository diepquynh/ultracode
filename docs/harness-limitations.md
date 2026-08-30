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
- **Grok Build: REINTERPRETED against the open-source tree (2026-08-30, xai-org/grok-build@main).** The
  earlier "zero plugin handlers" measurement (CLI 1.0.5) is obsolete: current grok-build has a full hooks
  crate (`crates/codegen/xai-grok-hooks`) and loads plugin hooks from `hooks/hooks.json` in the plugin root
  (`xai-grok-agent/src/plugins/{discovery,hooks_adapter}.rs`, `${GROK_PLUGIN_ROOT}` substituted at load
  time), for every session including subagent children (`acp_session_impl/spawn.rs` builds the registry per
  session). The engine is Claude-shaped with sharp edges; `hooks/lib/grok-hooks.js` is the one place
  ultracode adapts to them:
  - Payloads are camelCase with additive snake_case aliases (`event.rs` `SNAKE_CASE_ALIASES`), so our
    snake_case readers work. Matchers of `[A-Za-z0-9_|]` are exact per `|`-term with Claude→grok alias
    expansion (`matcher.rs` + `xai-grok-tools` `claude_alias.rs`): `Task|Agent` also matches
    `spawn_subagent`, `Bash` matches `run_terminal_command`, `Edit|Write` matches
    `search_replace`/`hashline_edit`/`write`, `Read` matches `read_file`/`hashline_read`.
  - Decisions parse the Claude shape (`hookSpecificOutput.permissionDecision` allow/deny/ask/defer, plus
    legacy top-level `decision`; `runner/mod.rs`). `updatedInput` is supported, last-completed-wins
    (`dispatcher.rs` `record_rewrite`), but is schema-validated against the tool's input schema and an
    unusable rewrite **blocks the call** (`acp_session/hooks.rs` `block_unusable_rewrite`) — so the
    router's rewrite must stay schema-clean (`TaskToolInput` has a real `model` field; no `fork_turns`
    equivalent exists or is sent). Exit 2 denies regardless of stdout; a nonzero non-2 exit fails the hook,
    and a failed gate hook is ignored (fail-open, `dispatcher.rs`).
  - **Deny/ask reasons are clipped to 256 chars** (`event.rs` `MAX_REASON_CHARS`), front-anchored. Hook
    stdout is capped at 64 KiB (`runner/command.rs` `MAX_OUTPUT_BYTES`) and the whole hook payload at
    128 KiB — past that, `toolInput` becomes a truncated *string* with `toolInputTruncated: true`
    (`event.rs` `truncate_payload`), which would empty the spawns list and fail every guard open;
    session-guard refuses truncated spawn payloads instead. Long denials are refit client-side
    (`fitGrokReason`: head + final sentence, head-priority), and hooks whose essential correction would
    still be lost pass a pre-authored compact variant as `denyPreToolUse`'s second argument
    (build-streak-gate's STUCK instruction, report-policy's declared path).
  - **Observe-kind events (SessionStart, PostToolUse, PreCompact, PostCompact, Notification) never read
    hook stdout** beyond a user-facing `systemMessage` toast (`runner/command.rs` `GateKind::Observe`), so
    a PostToolUse `additionalContext` is inert there, and SessionStart's `source` is only ever
    `"new"`/`"load"` (`agent_ops.rs`) — never `"compact"`. The post-compaction checkpoint therefore rides a
    PreCompact-written marker consumed by the first PreToolUse (`hooks.grok.json` registers
    `session-resume.js` on PreCompact and on PreToolUse matcher `"*"`), because PreToolUse
    `additionalContext` on an allow is the one model-visible inject channel grok has.
  - **The spawn tool (`task`/`spawn_subagent`) defaults `run_in_background` to true**, and even foreground
    spawns auto-background when the wait budget expires (`grok_build/task/mod.rs`), so PostToolUse usually
    carries only a launch ack; grok's SubagentStop has `lastAssistantMessage` but no spawn prompt or child
    transcript path, so `Session dir:`/`Repo key:` are unrecoverable there. `factcheck-record.js` is
    therefore DELIBERATELY not registered on grok (like codex); the fact-check role records via the
    `ultracode_factcheck` MCP tool (`{{#codex,grok}}` block in its prompt).
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
  re-trust in `/hooks` after updating. Dispatch is now CONFIRMED live (session 01a05334, 2026-08-30): a v2
  `spawn_agent` was blocked by session-guard with the denial reaching the model as
  `Tool call blocked by PreToolUse hook … Tool: collaborationspawn_agent`. Bash-matcher PreToolUse hooks are
  confirmed firing in `codex exec` (unified and legacy exec) with `[hooks.state]` trust persisting across
  plugin updates whose hook commands are unchanged. Generated leaf prompts continue to repeat the parameter
  contract as the fallback.
- **Codex spawn messages are end-to-end encrypted with OpenAI models** (source-confirmed 2026-08-30,
  openai/codex@main; observed live in sessions 01a05219/01a05334 — every spawn `message` is a single
  Fernet-style `gAAAA…` token). The Responses API returns collaboration tool arguments as ciphertext:
  `core/src/tools/router.rs` `direct_source` treats a collaboration spawn/send/followup as plaintext only
  when `encrypted_function_args` is empty, `core/src/client.rs` strips that field only for non-OpenAI
  providers, and `core/src/tools/handlers/multi_agents_v2.rs` `communication_from_tool_message` forwards the
  sealed message via `InterAgentCommunication::new_encrypted` — the client (and therefore every hook,
  which receives the raw arguments per `registry.rs` `pre_tool_use_payload`) NEVER possesses the plaintext;
  it is decrypted server-side for the child. Consequences: no client-side check can read the prompt's
  `Label: value` contract lines, verify the session dir, or rewrite the prompt (a rewrite would corrupt the
  ciphertext and feed the child garbage); only plaintext arguments (`agent_type`, `fork_turns`, `model`)
  remain hook-visible. Ultracode's answer is the **spawn ticket**: plain MCP tool arguments are never
  encrypted, so the orchestrator files the contract through `ultracode_spawn_ticket` immediately before each
  spawn, session-guard validates and consumes that single-use ticket instead of the unreadable prompt (and
  refuses an opaque spawn without one), model-router leaves the sealed message untouched while still
  injecting the routed `model` and pinning `fork_turns: "none"` (both plaintext arguments), and each
  generated role TOML carries a "Task Contract Self-Check" preamble so
  the child — the only party that ever reads the delivered plaintext — exits before its first tool call if
  the contract lines are missing. The child's rollout is also encrypted at rest, so leaf hooks cannot
  recover spawn context from a codex child transcript; the consumed ticket is the durable plaintext record.
  The RESULT side can never reach a hook either (measured 2026-08-30 session 01a05382; source-confirmed):
  a v2 spawn's tool result is only the async launch ack; v2 `wait_agent` returns just
  `{message: "Wait completed."|"Wait timed out.", timed_out}` with no child content
  (`multi_agents_v2/wait.rs` `WaitAgentResult::from_outcome`); and the child's FINAL_ANSWER arrives as a
  `TurnInput::InterAgentCommunication`, for which the hook runtime explicitly dispatches NOTHING —
  `core/src/hook_runtime.rs` `inspect_pending_input` no-ops that variant while only `UserInput` fires
  UserPromptSubmit. So hooks/factcheck-record.js is structurally inert on codex (the live symptom:
  factcheck.json never written, `ultracode_gate` approval refusing forever while the orchestrator
  improvised its own verdict file). Subagent threads DO get the full MCP tool registry — `tools/spec_plan.rs`
  `build_tool_router` appends MCP tools for every session source except codex-internal guardian ones
  (`guardian/review.rs` `is_basic_session_source`) — which is what makes the tool-based fix possible.
  Because of this, `hooks/hooks.codex.json` DELIBERATELY does not register `factcheck-record.js`
  (removed 2026-08-30) — if you notice it "missing" from the codex PostToolUse group, that is the decision,
  not an oversight; every other harness keeps it. The other codex PostToolUse hooks stay for good reason:
  `spawn-log.js` reads only plaintext spawn arguments and ticket context (the review cap depends on it),
  and `build-streak.js` reads plaintext exec results. The fix mirrors the ticket: the fact-check agent
  itself records through the `ultracode_factcheck` MCP tool (plain arguments are never sealed), writing the
  same factcheck.json ultracode_gate reads; the codex fact-check role instructions mandate the call before
  the final message. With non-OpenAI providers the arguments stay plaintext and the normal prompt-line
  enforcement applies.
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
  shim path. Mind the split execution paths (measured 2026-08-30, session 01a05376): hooks run from the
  per-version cache `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, which is NOT refreshed when
  the staged copy changes under the same version — while the MCP shim runs from the absolute path `codex
  mcp add` registered. Updating the dist without bumping the version therefore ships new tools with old
  hooks. Fix: bump the version, or overlay the new files into the cache dir in place (file-level `cp`,
  never rm-then-copy; safe for hook JS bodies since `[hooks.state]` trust hashes only the hooks config,
  not script contents).

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
- **Grok** takes the Claude shape in current source — see the dedicated "Grok ask" entry below (256-char
  reason cap applies; stale builds drop the gate entirely).
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
  (the child starts on the inherited model, then `thread_settings_applied` switches it before the first turn).
  Precedence, confirmed in source (openai/codex@main): role `config_file` model > per-call `model` argument >
  `[agents].default_subagent_model` > inherit the spawner — the spawn handler applies the requested model
  FIRST and the role layer AFTER (`core/src/tools/handlers/multi_agents_v2/spawn.rs`), and a role
  `config_file` model, when present, unconditionally overwrites (`core/src/agent/role.rs`
  `build_next_config`); codex even advertises a role's model in the spawn tool spec as "cannot be changed".
  Ultracode therefore keeps the generated role TOMLs **model-free** and the model-router hook injects the
  repo-profile route as the spawn's `model` argument: the arg field is always parseable
  (`SpawnAgentArgs.model` is a declared field; `[features.multi_agent_v2].expose_spawn_agent_model_overrides`
  only gates the schema the model sees — an earlier note called the flag unreachable, wrong: it nests under
  `features`), and the handler applies it with no feature gate but VALIDATES the name against codex's own
  model list (`find_spawn_agent_model_name`), so a route naming a model codex doesn't know fails that spawn
  loudly. Two consequences: `repo-profile.json` `models` routes now retune codex spawns on the next spawn
  like every other harness, and the inheritance fallback means broken hooks (untrusted, stale plugin cache)
  silently bill every leaf at the spawner's tier — on codex, working hooks ARE the routing.
- **Codex `spawn_agent`'s `fork_turns` inverts ultracode's `context: fork`** (measured 2026-08-30, session
  01a05219…): ultracode's "fork" means the agent runs forked OFF — self-contained prompt, never seeing the
  parent conversation — while Codex's `fork_turns: "all"` copies every parent turn INTO the child. A session
  that mapped one onto the other spawned each pipeline role with the entire orchestrator conversation
  embedded (a 2.3 MB child rollout for one fact-check), leaking orchestration context into leaves and
  leaving children as lingering separate threads (`close_agent` never called). Worse, an ABSENT `fork_turns`
  **defaults to `"all"`** (`multi_agents_v2/spawn.rs` `fork_mode`, `unwrap_or("all")`) — omitting the option
  is not opting out; only an explicit `"none"` keeps the parent conversation out of the child. The
  model-router therefore rewrites every codex ultracode spawn to `fork_turns: "none"`, and the generated
  role TOML header and the orchestrate/hub-listen skills state the spawn contract explicitly: `agent_type` +
  the self-contained prompt, never a fork option, and close finished agents.
- **Grok 1.0.13 `-p` does not expose user-config stdio MCP servers in untrusted directories.** `grok mcp
  doctor` reported the shim healthy with 13 tools, while a `-p` run from an untrusted `/tmp` project saw only
  plugin-bundled servers and reported the same tools "not found". Run from a trusted project (or trust the
  directory first); project-local `.mcp.json` in an untrusted dir is ignored the same way.

- **Grok ask: SUPPORTED in current source (2026-08-30, xai-org/grok-build@main), broken on old builds.**
  `runner/mod.rs` `DecisionToken::classify` accepts `"ask"` and `tool_calls.rs` routes `HookDecision::Ask`
  into the normal permission prompt, so `review-cap.js` now emits a real Claude-shaped ask on grok
  (reason refit to the 256-char cap). The old CLI 1.0.5 measurement (ask fails open) still applies to stale
  binaries: there an unknown decision value FAILS the hook and a failed gate hook is ignored, so on an old
  grok build the cap silently disappears rather than denying. Live re-verification of the prompt behavior
  (interactive and headless) is still pending.
