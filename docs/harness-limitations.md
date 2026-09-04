# Harness limitations

This document records what each harness does not do the way Ultracode's design assumes. Every entry was
measured on a live run of that CLI or confirmed in its source. Each one changes what a guard can enforce. A
hook that a harness never dispatches, or whose output it discards, is a rule that exists only on paper.

Dates are when the behavior was last measured or checked. Re-check an entry before relying on it after a CLI
update. Claude Code and Antigravity are closed source, so their entries are measurements only. Codex and Grok
Build entries were re-checked against the open-source trees on 2026-09-02 (openai/codex@main at eb10d91,
xai-org/grok-build@main at 72a6125). Facts that changed since the previous measurement are marked
"(corrected 2026-09-02)".

## Claude Code (live, 2026-08-22, CLI 2.1.220)

- Claude Code dispatches Ultracode plugin spawn hooks.
- Rewrites must live only in `hookSpecificOutput.updatedInput`. A top-level `overwrite` fails Claude's hook
  schema and is discarded.
- The `Agent` tool is async by default. `PostToolUse:Agent` sees only the launch ack
  (`Async agent launched successfully…`). So `hooks/factcheck-record.js` also registers on `SubagentStop`
  (`matcher: ^ultracode:fact-check$`) and records the verdict from `last_assistant_message` plus the leaf
  transcript's spawn prompt.
- Leaf `PostToolUse` Bash events often omit `agent_type`. `build-streak.js` and `build-streak-gate.js`
  therefore cannot attribute failures inside a forked implement or write-test turn, even when the matching
  PreToolUse Bash call carried the actor.
- An agent's explicit `tools:` front matter is an allowlist, and it drops every MCP tool it does not name
  (measured 2026-09-03, CLI 2.1.258, session 11111111-2222-4333-8444-555555550001). An `ultracode:explore`
  spawn whose list carried only native tools answered that `ultracode_memory_recall` was not in its tool
  list. So every MCP tool an agent's prompt calls is declared as a capability and rendered as
  `mcp__plugin_ultracode_ultracode-gate__<tool>` in that list (`definitions/tool-mapping.json`).

## Antigravity (live, 2026-08-22, CLI 1.1.18)

- Antigravity dispatches Ultracode plugin spawn hooks.
- A PostToolUse hook never sees what a tool or subagent returned, so recording from tool results is inert
  there. `hooks/agy-message-record.js` records fact-check verdicts instead.
- Spawn calls arrive as a `toolCall.args.Subagents[]` list. Every spawn guard iterates the whole list.
- Subagents inherit the session's MCP registry. An `ultracode-explore` spawn whose `tools` list named only
  native tools called `ultracode_memory_recall` on the `ultracode-gate` server (measured 2026-09-03, CLI
  1.1.25, conversation 676523eb, child 6cd5233e). Generated agents carry `inheritMcp: true`, and MCP
  capabilities stay out of the native tools list.
- The ask channel and the hub wake channel are described in their own sections below.

## Codex

Source references are to openai/codex@main.

### Hook dispatch and matchers

- Every function tool call, including the v2 collaboration `spawn_agent`, produces a PreToolUse payload
  (`core/src/tools/registry.rs`, default `pre_tool_use_payload`). The payload contains the raw tool arguments.
- The hook-facing name of a namespaced v2 tool is the namespace joined to the tool name with no separator
  (`core/src/tools/mod.rs` `flat_tool_name`). The v2 spawn appears to hooks as `collaborationspawn_agent`. The
  Claude-style alias `Agent` (`core/src/tools/hook_names.rs`) applies only to the default-namespace and
  `multi_agent_v1` spawn tools.
- A hook matcher made only of `[A-Za-z0-9_|]` is an exact-equality matcher, split on `|`
  (`hooks/src/events/common.rs` `is_exact_matcher`). Any other pattern is an unanchored regex. Ultracode's old
  `Agent|spawn_agent` matcher could never match a v2 spawn. This explains the "spawn sailed past
  session-guard" observation on 0.147 and 0.151.
- Ultracode now generates the regex matcher `(Agent|spawn_agent)$` in `hooks/hooks.codex.json`. It matches the
  canonical name, the `Agent` alias, and the flat namespaced name, and excludes `wait_agent`, `close_agent`,
  `resume_agent`, and `interrupt_agent`. Dispatch was confirmed live on 2026-08-30 (session 01a05334): a v2
  spawn was blocked with `Tool call blocked by PreToolUse hook … Tool: collaborationspawn_agent`.
- Codex hashes only the hook configuration (event, matcher, handler) into the `[hooks.state]` trust entry
  (`hooks/src/engine/discovery.rs` `hook_hash`). Script contents are not hashed. Changing a matcher changes
  the hash. **Action:** after updating ultracode, re-trust the hooks in `/hooks`. Bash-matcher PreToolUse
  hooks fire in `codex exec` (unified and legacy), and trust persists across plugin updates whose hook
  commands are unchanged. Generated leaf prompts still repeat the parameter contract as a fallback.

### Encrypted spawn messages

- With OpenAI models, the Responses API returns collaboration spawn arguments with the `message` sealed.
  `core/src/tools/router.rs` `direct_source` treats a collaboration `spawn_agent`, `send_message`, or
  `followup_task` as plaintext only when `encrypted_function_args` is empty. `core/src/client.rs` clears that
  field only for non-OpenAI providers. `core/src/tools/handlers/multi_agents_v2.rs`
  `communication_from_tool_message` forwards a sealed message with `InterAgentCommunication::new_encrypted`.
  The client never holds the plaintext. Hooks see a single `gAAAA…` token (observed in sessions 01a05219 and
  01a05334, 2026-08-30).
- Consequence: no hook can read the prompt's `Label: value` lines, check the session dir, or rewrite the
  prompt. A rewrite would corrupt the ciphertext. Only plaintext arguments (`agent_type`, `fork_turns`,
  `model`) are visible.
- Ultracode's answer is the spawn ticket (`hooks/lib/spawn-ticket.js`, `hooks/lib/codex-spawn.js`). Plain MCP
  tool arguments are not encrypted. The orchestrator files the contract through `ultracode_spawn_ticket`
  right before each spawn. `session-guard.js` validates and consumes that single-use ticket (15-minute TTL)
  and refuses an opaque spawn without one. `model-router.js` leaves the sealed message alone and injects the
  routed `model` and `fork_turns: "none"`. Each generated role TOML carries a "Task Contract Self-Check"
  preamble so the child exits before its first tool call if the contract lines are missing.
- The sealed message is stored as ciphertext in the child's rollout (`core/src/session/mod.rs`
  `record_inter_agent_communication` persists the `EncryptedContent` item). Leaf hooks cannot recover spawn
  context from a codex child transcript. The consumed ticket is the durable plaintext record. (corrected
  2026-09-02: only the sealed message is ciphertext, not the whole rollout.)
- Results never reach a hook. A v2 spawn's tool result is only the launch ack (`SpawnAgentResult { task_name,
  nickname }`). `wait_agent` returns `{message, timed_out}` with no child content. `message` is one of
  `"Wait completed."`, `"Wait interrupted by new input."`, or `"Wait timed out."` (`multi_agents_v2/wait.rs`
  `WaitAgentResult::from_outcome`). (corrected 2026-09-02: three messages, not two.) The child's final answer
  arrives as `TurnInput::InterAgentCommunication`, and `core/src/hook_runtime.rs` `inspect_pending_input`
  dispatches nothing for that variant. Only `UserInput` fires UserPromptSubmit.
- Because of this, `hooks/factcheck-record.js` cannot work on codex. The live symptom was factcheck.json
  never written and `ultracode_gate` refusing approval forever while the orchestrator improvised its own
  verdict file. `hooks/hooks.codex.json` does not register it (removed 2026-08-30). If you notice it missing
  from the codex PostToolUse group, that is the decision, not an oversight. The fact-check role records
  through the `ultracode_factcheck` MCP tool instead, writing the same factcheck.json that `ultracode_gate`
  reads. The codex fact-check role instructions require that call before the final message. `spawn-log.js`
  (plaintext spawn arguments and ticket context, which the review cap depends on) and `build-streak.js`
  (plaintext exec results) stay registered.
- Subagent threads do get the MCP tool registry. `core/src/tools/spec_plan.rs` `build_tool_router` appends
  MCP tools for every session source except guardian ones (`guardian/review.rs` `is_basic_session_source`).
  This is what makes the MCP-tool based fix possible.
- With non-OpenAI providers the arguments stay plaintext and the normal prompt-line enforcement applies.

### Agent roles and models

- Codex 0.151.0 did not read agent roles from a plugin (measured 2026-08-30, session 01a051cc). A spawn
  naming a plugin role fails with `unknown agent_type` (`core/src/agent/role.rs`). A session left without
  registered roles improvises: it reads the role TOML as a document and pastes it into a generic `fork_turns`
  agent, which has no role binding (tools, model, and prompt contract all lost) and which it then tracks
  poorly (repeated bare 50 s `wait_agent` timeouts). Roles come from `[agents.<name>]` tables in
  `~/.codex/config.toml` with `config_file` pointing at a role TOML. Current main also auto-discovers role
  files from each config layer's `agents/` folder (`agent-roles/src/loader.rs`). There is still no plugin
  config layer. (corrected 2026-09-02.) install.sh registers every generated role via
  `scripts/register_codex_agents.js` in a managed block. Codex names are `ultracode_<name>` because `:` is
  not allowed.
- Subagents inherit the spawner's model unless something sets one (measured 2026-08-30: a `gpt-5.6-sol`
  orchestrator ran `implement` leaves on sol, paying the advanced price for balanced work, and a luna parent
  ran them on luna). Precedence, confirmed in source: role `config_file` model, then per-call `model`
  argument, then `[agents].default_subagent_model`, then inherit. `core/src/tools/handlers/multi_agents_common.rs`
  `apply_requested_spawn_agent_model_overrides` uses the argument or the default. `multi_agents_v2/spawn.rs`
  applies it first and the role layer after. `core/src/agent/role.rs` `build_next_config` overwrites the model
  unconditionally when the role file sets one. Codex advertises a role's model as "cannot be changed" in the
  role catalog text.
- `SpawnAgentArgs.model` is always parseable. `[features.multi_agent_v2].expose_spawn_agent_model_overrides`
  (default true) only controls whether the `model` and `reasoning_effort` properties appear in the schema the
  model sees. The handler validates the name with `find_spawn_agent_model_name` (in
  `multi_agents_common.rs`) against codex's own model list and fails the spawn with
  ``Unknown model `X` for spawn_agent`` if unknown. (corrected 2026-09-02: function location.)
- Ultracode keeps generated role TOMLs model-free and lets `model-router.js` inject the `repo-profile.json`
  route as the spawn's `model` argument. So `models` routes retune codex spawns on the next spawn like every
  other harness. Two consequences: a route naming a model codex does not know fails that spawn loudly, and
  broken hooks (untrusted, or a stale plugin cache) silently bill every leaf at the spawner's tier. On codex,
  working hooks are the routing.
- `fork_turns` inverts ultracode's `context: fork`. Ultracode's "fork" means the agent runs forked off: a
  self-contained prompt, never seeing the parent conversation. Codex `"all"` copies every parent turn into
  the child. An absent or empty `fork_turns` defaults to `"all"` (`multi_agents_v2/spawn.rs` `fork_mode`,
  `unwrap_or("all")`), so omitting the option is not opting out. Measured 2026-08-30 (session 01a05219): one
  fact-check produced a 2.3 MB child rollout, and children lingered as separate threads because `close_agent`
  was never called. `model-router.js` (`hooks/lib/codex-spawn.js` `forkTurnsPin`) rewrites every ultracode
  spawn to `fork_turns: "none"`. The role TOML header and the orchestrate and hub-listen skills state the
  contract: `agent_type` plus a self-contained prompt, no fork option, and `close_agent` when done.
- The generated "Harness Tool Policy" steers what a role believes it can call. With a policy that listed
  only `exec_command`, `apply_patch`, `web_search`, an `ultracode_explore` role answered that
  `ultracode_memory_recall` was unavailable and listed exactly those three names, while a generic
  `spawn_agent` child in the same setup called the tool and got a result (measured 2026-09-03, codex 0.151.0,
  threads 01a066d4 and 01a066d5). The thread had the registry, and the policy text alone kept the role from
  using it. So every MCP tool a role's prompt calls is named in that policy list
  (`definitions/tool-mapping.json`, `codex` values).

### Plugin install and runtime

- Codex 0.151.0 did not expand `${PLUGIN_ROOT}` in plugin-manifest `mcpServers` args (measured 2026-08-30,
  session 01a051bb). `codex mcp list` showed the literal `${PLUGIN_ROOT}/mcp/hub-shim.js`, the spawned node
  died on MODULE_NOT_FOUND, and hub-listen reported "this runtime has not exposed any of the required hub
  calls". Current main expands `${PLUGIN_ROOT}` in args, env, and cwd (`codex-mcp/src/agent_plugin_config.rs`),
  so this may be fixed. Re-measure before relying on it. (corrected 2026-09-02.) install.sh registers the shim
  with an absolute path, `codex mcp add ultracode-gate -- node <dist>/mcp/hub-shim.js`. That entry in
  `~/.codex/config.toml` outranks the manifest. The same workaround covers Antigravity's inert
  `mcp_config.json`.
- Codex 0.147.0 `exec` cancels MCP tool calls under the default approval policy. A plain `codex exec` reports
  `approval: never` yet every MCP call fails with "user cancelled MCP tool call". The same run with
  `--dangerously-bypass-approvals-and-sandbox` completes them. Headless use of the hub tools needs that flag
  or an approvals config that covers MCP. Measured only.
- Re-adding the plugin at the same version can leave the cache copy without a `hooks/` directory, with no
  error or warning (measured 2026-08-30; session 01a05219 ran with zero hooks). A fresh add after a version
  bump restored it. install.sh verifies `hooks/hooks.json` and `mcp/hub-shim.js` in the reported cache root
  after `codex plugin add` and repairs once with remove and re-add. **Action:** always bump the plugin version
  when shipping changes.
- Codex's reconciler runs at every session startup. If it reads the local marketplace while the staged plugin
  directory is mid-refresh (an rm-then-copy window), it delists the plugin: uninstalls it, removes the
  marketplace registration, and deletes the `ultracode-gate` entry from config.toml. The `[agents.*]` block
  and `[hooks.state]` trust survive. install.sh swaps the staged copy atomically (build beside, then `mv`).
  Anyone refreshing the staged copy by hand must do the same. Recovery: marketplace add, plugin add, then
  `codex mcp add ultracode-gate` with the absolute shim path. Measured 2026-08-30.
- Hooks run from the per-version cache `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, which is
  not refreshed when the staged copy changes under the same version. The MCP shim runs from the absolute path
  `codex mcp add` registered (measured 2026-08-30, session 01a05376). Updating the dist without bumping the
  version ships new tools with old hooks. Fix: bump the version, or overlay the new files into the cache dir
  in place with file-level `cp`, never rm-then-copy. This is safe for hook JS bodies because `[hooks.state]`
  hashes only the hooks config.

## Grok Build

Source references are to xai-org/grok-build@main. The old CLI 1.0.5 "zero plugin handlers" measurement is
obsolete. `hooks/lib/grok-hooks.js` is the one place ultracode adapts to grok's hook engine.

### Loading and matching

- Grok has a full hooks crate at `crates/codegen/xai-grok-hooks`. Plugin hooks load from `hooks/hooks.json`
  in the plugin root (`xai-grok-agent/src/plugins/{discovery,hooks_adapter}.rs`). `${GROK_PLUGIN_ROOT}` and
  `${CLAUDE_PLUGIN_ROOT}` are substituted at load time.
- Sessions get their hook registry at spawn (`acp_session_impl/spawn.rs` `discover_hooks`). Plugin hooks are
  appended to the parent registry when the plugin registry snapshot is applied
  (`acp_session_impl/hooks_plugins.rs` `apply_plugin_registry_snapshot`). Subagent children inherit the
  parent's registry, so they run plugin hooks too. Inline hooks declared by a plugin-defined agent are
  ignored. (corrected 2026-09-02: mechanism only; the effect is unchanged.)
- Payloads are camelCase with additive snake_case aliases (`event.rs` `SNAKE_CASE_ALIASES`), so ultracode's
  snake_case readers work.
- A matcher made only of `[A-Za-z0-9_|]` is exact per `|` term, with Claude-to-grok alias expansion
  (`matcher.rs` plus `xai-grok-tools` `claude_alias.rs`): `Task|Agent` also matches `spawn_subagent`, `Bash`
  matches `run_terminal_command`, `Edit|Write` matches `search_replace`, `hashline_edit`, and `write`, and
  `Read` matches `read_file` and `hashline_read`. Other patterns are unanchored regexes, also tested against
  aliases. An invalid regex matches nothing. The spawn tool's registered id is `task`; `Task` and
  `spawn_subagent` are accepted spellings. Which spelling reaches hook `toolName` has not been checked from
  source. **Action:** confirm against a live PreToolUse payload if a spawn hook ever fails to fire.

### Decisions, rewrites, and failures

- Decisions use the Claude shape: `hookSpecificOutput.permissionDecision` with `allow`, `deny`, `ask`, or
  `defer` (`approve` and `block` are also accepted), plus the legacy top-level `decision` (`runner/mod.rs`
  `DecisionToken::classify`). An unknown value fails the hook.
- `updatedInput` is supported. When several hooks rewrite, the last completed one wins (`dispatcher.rs`
  `record_rewrite`). The rewrite is validated against the tool's input schema, and an unusable rewrite blocks
  the call (`acp_session/hooks.rs` `block_unusable_rewrite`). `TaskToolInput` has a real `model` field and no
  `fork_turns` equivalent, so the model-router's rewrite stays schema-clean and sends nothing beyond what the
  schema declares.
- Exit 2 denies regardless of stdout. A nonzero non-2 exit fails the hook, and a failed gate hook is ignored
  (fail-open, `dispatcher.rs`). A crashing hook therefore never blocks a tool call.
- `ask` is supported in current source. `classify` accepts `"ask"` and `tool_calls.rs` routes
  `HookDecision::Ask` into the normal permission prompt. `review-cap.js` emits a real ask on grok, with the
  reason refit to the 256-character cap. On the old CLI 1.0.5, an unknown decision fails the hook and the cap
  silently disappears. Live re-verification of the prompt behaviour (interactive and headless) is still
  pending.

### Size limits

- Deny and ask reasons are clipped to 256 characters, front-anchored (`event.rs` `MAX_REASON_CHARS`).
  `fitGrokReason` in `hooks/lib/grok-hooks.js` refits long denials to the head plus the final sentence
  (`GROK_REASON_MAX = 256`, `MIN_HEAD = 120`). Hooks whose essential correction would still be lost pass a
  compact variant as the second argument of `denyPreToolUse` (build-streak-gate's STUCK instruction,
  report-policy's declared path).
- Hook stdout is captured up to 1 MiB (`runner/command.rs` `MAX_OUTPUT_BYTES`, which is 16 times
  `MAX_HOOK_OUTPUT_REPLACEMENT_CHARS`), then truncated. The 64 KiB constant
  `MAX_HOOK_OUTPUT_REPLACEMENT_CHARS` caps a PostToolUse output replacement, not stdout. `additionalContext`
  and block reasons are clipped to 10,000 characters (`MAX_HOOK_FEEDBACK_CHARS`). (corrected 2026-09-02: the
  earlier note said stdout was capped at 64 KiB.)
- The whole hook payload is capped at 128 KiB (`event.rs` `truncate_payload`, `MAX_PAYLOAD_SIZE`). Past that,
  `toolInput` becomes a truncated string and `toolInputTruncated: true` is set. Ultracode's adapters would
  then see no spawn entries and every guard would allow. `truncatedSpawnDenial` in `hooks/lib/grok-hooks.js`
  refuses such spawn payloads instead. **Action:** keep spawn prompts small and reference files by path.

### Which events can talk to the model

- SessionStart, PreCompact, PostCompact, Notification, SubagentStart, SessionEnd, and PostToolUseFailure are
  Observe-kind (`runner/command.rs` `GateKind::Observe`). Only the exit code and a user-facing `systemMessage`
  toast are read.
- PostToolUse is not Observe-kind in current source. It is `GateKind::PostTool`. Grok reads `decision:
  "block"` with `reason`, `hookSpecificOutput.additionalContext`, and `updatedToolOutput`, and delivers the
  context to the model as a reminder note (`tool_calls.rs`). (corrected 2026-09-02: the earlier note said
  PostToolUse `additionalContext` was inert.) The header comment in `hooks/lib/grok-hooks.js` still lists
  PostToolUse as Observe-kind and should be updated to match.
- SessionStart's `source` is only ever `"new"` or `"load"` (`agent_ops.rs`), never `"compact"`. The
  post-compaction checkpoint therefore uses a marker: `hooks.grok.json` registers `session-resume.js` on
  PreCompact (writes the marker) and on PreToolUse matcher `"*"` (consumes it and emits `additionalContext`
  on allow).

### Spawns and results

- The spawn tool defaults `run_in_background` to true (`TaskToolInput`, `default_true`), and a foreground spawn
  auto-backgrounds when the wait budget expires (`grok_build/task/mod.rs`). PostToolUse usually carries only
  a launch ack.
- SubagentStop carries `phase`, `subagentId`, `subagentType`, `stopHookActive`, and `lastAssistantMessage`,
  but no spawn prompt. The envelope's `transcriptPath` is the emitting session's own transcript, so a child's
  SubagentStop may carry the child transcript path when the file exists. Whether `Session dir:` and
  `Repo key:` can be recovered from it is not verified. (corrected 2026-09-02.)
- `factcheck-record.js` is not registered on grok, as on codex. The fact-check role records via the
  `ultracode_factcheck` MCP tool (the `{{#codex,grok}}` block in its prompt).
- Subagents inherit the session's MCP registry even though their `tools:` front matter lists only native
  tools. An `ultracode:explore` child (grok-4.5) reached `ultracode_memory_recall` in two calls: `search_tool`
  found it under the name `ultracode-gate__ultracode_memory_recall`, then `use_tool` invoked it (measured
  2026-09-03, grok 1.0.13, session 01a066d2, child 01a066d2-cdca). MCP capabilities therefore stay out of the
  grok tools list, and a prompt may need to look the tool up before calling it.

### Asking the user

- Grok has a structured question tool, `ask_user_question`
  (`xai-grok-tools/src/implementations/grok_build/ask_user_question/`). Its input is
  `questions: [{question, options: [{label, description, preview?}], multi_select?}]`. There is no header or
  tag field, and duplicate question text is rejected as invalid arguments. The tool adds the `Other`
  free-text choice itself, so a prompt that lists one duplicates it. (corrected 2026-09-04: the earlier
  mapping said grok had no question tool at all.)
- The call blocks on the answer for 30 minutes by default (`RESPONSE_TIMEOUT`, overridable through
  `[toolset.ask_user_question]` or `GROK_ASK_USER_QUESTION_TIMEOUT_SECS`, and disarmable with
  `timeout_enabled = false`). A dismissal and a timeout both return `CANCEL_TEXT`, and a non-interactive
  session returns `NO_OPERATOR_TEXT`. Neither is a tool failure, so a model that assumes an answer arrived
  will read a decline as a selection.
- Subagents never get it. `build_subagent_spawn_context` hardcodes `ask_user_question_enabled: false` even
  when the parent has it on (`mvp_agent/subagent_spawn.rs`, pinned by
  `subagent_spawn_context_disables_ask_user_question_from_enabled_parent`), and the builder also drops every
  `ToolKind::AskUser` tool for `PromptAudience::Subagent`. This matches how ultracode already routes
  questions: subagents write question blocks into their reports and the primary session asks them.
- The tool is registered, and the model still refuses to call it. Registration is proved by the
  `use_tool` oracle: `use_tool{tool_name: "ask_user_question"}` returns "`ask_user_question` is a native
  tool, not an MCP integration tool. Call `ask_user_question` directly", the same correction `todo_write`
  gets, while an invented name gets "not a valid MCP tool name" instead
  (`implementations/use_tool/mod.rs`, keyed on `EnabledNativeToolNames`). That set is built from the same
  registry vector that feeds `tool_definitions_builtins_only`, which is the model's tool list;
  `filter_cursor_tools_by_plan_mode` is a no-op in this build. Native tools are never hidden behind
  `search_tool`: its BM25 index covers MCP tools only, which is why a live search reports
  `total_hidden_tools: 19`, exactly the `ultracode-gate` count.
- **Eleven scripted runs, zero invocations (measured 2026-09-04, grok 1.0.13, sessions 01a06db0 through
  01a06dd8).** Every run ended with `response.has_tool_call=false` for the ask tool: the model answered in
  prose, or printed the literal sentence `Tool not available` as though it were the tool's result. The runs
  covered headless `-p` and a hand-written ACP stdio client that answers `x.ai/ask_user_question`; grok-4.5
  and grok-4.6; effort low and high; direct orders and a natural ambiguous request; `--tools
  ask_user_question` as the only native tool; `--permission-mode plan`; `GROK_ASK_USER_QUESTION=1`; a
  session where `enter_plan_mode` ran first and its own result told the model to "use ask_user_question";
  and a session where the `use_tool` correction told it to call the tool directly, in the same turn. Other
  tools in those same turns executed normally. The interactive TUI with a human present is the one path not
  measured. **Action:** name the tool in prompts and keep the prose fallback next to it, because the
  observed failure is a fabricated answer, not an error.

### Runtime

- Grok 1.0.13 `-p` does not expose user-config stdio MCP servers in untrusted directories. `grok mcp doctor`
  reported the shim healthy with 13 tools, while a `-p` run from an untrusted `/tmp` project saw only
  plugin-bundled servers and reported the same tools "not found". Project-local `.mcp.json` in an untrusted
  dir is ignored the same way. Run from a trusted project or trust the directory first. Measured only.
- Grok 1.0.13: only short (25 s or less) `ultracode_msg_wait` parks were measured, which is why
  `ultracode:hub-wait` uses 20 s waits here. Grok is pull-only, so re-run `/ultracode:hub-listen` if the
  harness cuts the wait spawn itself.

## The ask channel (live, 2026-08-23)

The ask channel is how a hook hands a decision to the user instead of taking it. Only `hooks/review-cap.js`
uses it. The review-loop cap is a budget, not a safety rule, so the spawn past the cap is offered to the user
rather than refused. `askPreToolUse` in `hooks/lib/common.js` picks the shape per harness.

- **Claude** honors `hookSpecificOutput.permissionDecision: "ask"`, including under
  `--dangerously-skip-permissions`. A hook's own ask result is returned before bypassPermissions mode can turn
  it into an allow. A headless `-p` run has nobody to prompt, so the ask arrives as a denial carrying the
  reason. The loop still stops with the cap named.
- **Antigravity** takes a top-level `{"decision": "force_ask", "reason": …}`. Plain `"ask"` respects the
  always-allow cache, so a user who once chose always-allow for subagent spawns would never see the question.
  `force_ask` was verified to override an existing `command(…)` allow rule where a silent hook let the same
  call through.
- **Grok** takes the Claude shape in current source. See "Decisions, rewrites, and failures" above. The
  256-character reason cap applies, and stale builds drop the gate entirely.

## Hub wake channels (checked 2026-08-30)

The cross-harness hub (docs/hub.md) can wake an idle interactive session only where the harness has a
steering channel. Everywhere else delivery is pull-only: the session's `ultracode:hub-wait` subagent sits in
`ultracode_msg_wait`. A channel turns on by default
only once a live run on a qualifying CLI version is recorded here. Claude and Codex are. Grok and Antigravity
have no channel to gate.

- **Claude Code:** cross-session messaging (named sessions, per-session Unix sockets under `/tmp/cc-socks`,
  session records under `~/.claude/sessions/`) ships in 2.1.224 or newer. Verified end to end on 2.1.251
  (2026-08-30): the `mcp/lib/push/claude.js` frame pair (`{type:"auth",token}` from
  `<pid>.<sha256(socketPath)>.key`, then `{type:"user",message}`) woke a live interactive session, and the
  recipient verified the sender pid. The adapter is on by default (`ULTRACODE_HUB_CLAUDE_PUSH=0` opts out)
  and matches records by name or `sessionId`, so no per-session `native_address` is needed. Two measured
  facts shape it: the wire protocol is undocumented and version-specific, so any mismatch degrades to pull
  rather than erroring; and a recipient in `bypassPermissions` mode holds an unattested peer message for user
  approval ("The sender did not attest its permission mode and this session bypasses prompts... set
  crossSessionInbound to accept"). The adapter respects that gate. This is safe because the pushed payload
  is only a wake notice.
- **Codex:** `codex queue` ships in 0.149.0 or newer. Syntax verified on 0.151.0 (2026-08-30):
  `codex queue --thread <session-UUID-or-exact-name> --message <text>`, pinned in `mcp/lib/push/codex.js`
  and on by default (`ULTRACODE_HUB_CODEX_PUSH=0` opts out). `--thread` takes the thread UUID, so no
  per-session naming is needed. A CLI without `queue` (0.147.0 was measured failing `codex queue --help`)
  feature-detects as unavailable and stays pull-only.
- **Grok Build 1.0.13 and Antigravity 1.1.22:** no external steering channel found in either. Antigravity's
  `send_message` is intra-conversation only. Both are pull-only.

## Tool-call duration caps (live, 2026-08-30)

Every harness bounds how long one tool call may run. That is what ends an "infinite" `ultracode_msg_wait`
park (`timeout_ms: 0`) when the user does not. Whatever cuts the call, the registration stays alive (7-day
idle expiry, parked waiters exempt from sweeps) and the cursor re-reads everything on the next wait, so a cut
never costs a message. Because of these caps no interactive session parks itself any more: the wait runs
inside the `ultracode:hub-wait` subagent (docs/hub.md, "Waiting without parking"), which loops finite waits
sized from the measurements below (55 s per call; 20 s on Grok) for a budget the parent sets, while the
parent blocks on the spawn. Subagent spawns are the one kind of call every harness lets run long. The
measurements below are what set those per-call timeouts.

- **Codex 0.151.0** (session 01a05219): long tool calls are moved to background cells that the model polls
  with its `wait` tool (about 60 s yields). After several yields the harness cut the listening park, and the
  session reported "listening stopped because the harness capped the long-running tool call". In practice the
  cap does not matter on Codex: the hub's `codex-queue` push woke the same session as a fresh user turn
  moments later, which is the intended wake path anyway.
- **Claude Code 2.1.251:** a 110 s `msg_wait` completed with `MCP_TOOL_TIMEOUT=180000` set. The default cap
  was not measured. The env var is the lever when a Claude session should hold a long park. Claude sessions,
  like Codex, normally get woken by push rather than by holding the park.
- **Antigravity 1.1.22:** a 110 s wait completed headless under `--print-timeout 5m` (that flag bounds the
  whole print run). The interactive-session cap is unmeasured. Antigravity is pull-only, so a generous park is
  its main delivery path. Expect to re-run hub-listen when the harness cuts it.
- **Grok 1.0.13:** only short (25 s or less) waits measured so far. Also pull-only, same re-run story.
