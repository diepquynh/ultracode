# Definition authoring

Agent, plugin-skill, and command prompts have one harness-neutral source. Each definition owns a directory:

```text
agents/<name>/
├── definition.json
└── prompt.md

skills/<name>/
├── definition.json
└── prompt.md

commands/<name>/
├── definition.json
└── prompt.md
```

`definition.json` contains the name, description, prompt path, and portable configuration. Agent configuration
also records a neutral model tier, reasoning effort, canonical capabilities, timeout, and context mode. Command
configuration records its argument hint. `prompt.md` contains only the large prompt body. Its formatting is
preserved by generation.

The schema is `definitions/definition.schema.json`. Neutral model tiers resolve through
`definitions/model-mapping.json`: `fast` maps to Haiku/Luna, `balanced` to Sonnet/Terra, and `advanced` to
Opus/Sol. Canonical capabilities and their Claude Code/Codex translations are explicit in
`definitions/tool-mapping.json`. Add a mapping before using a new capability in a definition. Codex has no
direct `Skill` tool, so that mapping emits a skill-discovery instruction. Multiple Claude file/search tools map
to Codex's `exec_command` or `apply_patch` capabilities.

Harness-owned repo paths are defined in `definitions/harness-layout.json`. Claude Code output uses
`.claude/ultracode` for its inventory/profile and `.claude/skills` for generated project skills. Codex output
uses `.codex/ultracode` and its native `.agents/skills` discovery directory. The generator translates these
paths in prompts, descriptions, references, session hooks, and the model router; do not hardcode a second
harness path inside a definition.

Use these tokens in neutral `prompt.md` files, definition descriptions, and shared Markdown references:

| Token | Meaning |
|---|---|
| `{{state_dir}}` | Harness project-state parent (`.claude` or `.codex`) |
| `{{runtime_dir}}` | Ultracode inventory, profile, and session directory |
| `{{skills_dir}}` | Harness-native project skill discovery directory |
| `{{agents_dir}}` | Harness-native project agent-definition directory |
| `{{plugin_root}}` | Harness-provided environment expression for the installed plugin root |
| `{{arguments}}` | Claude command arguments or the request text following a Codex skill invocation |
| `{{command_prefix}}` | Explicit invocation prefix (`/` for Claude, `$` for Codex) |
| `{{agent_selector}}` | Agent-spawn selector field (`subagent_type` or `agent_type`) |
| `{{agent_tool}}` | Agent-spawn tool name (`Agent` or `spawn_agent`) |
| `{{session_id_expr}}` | Harness session expression, including `CODEX_THREAD_ID` for Codex |
| `{{session_id_source}}` | Prose description of the harness session identifier |
| `{{balanced_model}}` / `{{advanced_model}}` | Concrete target models for pre-profile bootstrap spawns |
| `{{reload_action}}` | Harness-specific instruction for discovering newly generated skills |

For example, author the profile as `{repo-root}/{{runtime_dir}}/repo-profile.json` and a generated skill as
`{repo-root}/{{skills_dir}}/{name}/SKILL.md`. Generation resolves the tokens to the selected harness. Validation
rejects concrete `.claude/` or `.codex/` paths and harness-specific plugin-root variables in neutral sources,
unknown template tokens, and unresolved template tokens in output.

## Generate

Generate the checked-in Claude Code plugin distribution with:

```bash
python3 scripts/generate_definitions.py --target claude
```

This writes `agents/<name>.md`, `skills/<name>/SKILL.md`, `commands/<name>.md`, both Claude manifests, hooks,
references, assets, and the license beneath the plugin root. They are generated files; make changes in the
root authoring sources and regenerate.

Generate the checked-in Codex plugin distribution with:

```bash
python3 scripts/generate_definitions.py --target codex
```

When `--output-dir` is omitted, the generator writes to `dist/<target>/ultracode` beneath `--source-root`.
Pass `--output-dir <path>` to generate a plugin somewhere else.

This writes Codex agent role files to `agents/<name>.toml` and Codex skills to
`skills/<name>/SKILL.md` beneath the Codex plugin root. Because plugin-bundled custom prompts are unsupported
and standalone Codex custom prompts are deprecated/local-only, each command is emitted as an explicitly
invoked Codex skill at `skills/<command>/SKILL.md`. Its `agents/openai.yaml` sets
`policy.allow_implicit_invocation: false`. Invoke it as `$<command>`. Plugin metadata lives at
`dist/codex/ultracode/.codex-plugin/plugin.json`, and target-adapted lifecycle hooks live under `hooks/`.
Codex role TOML supports developer instructions, model/reasoning settings, and
sandbox mode, but not Claude's per-agent timeout, fork-context, or granular tool allowlist. The generator keeps
timeout/context in source comments, derives `sandbox_mode` from write capabilities, and prepends an explicit
tool-vocabulary policy to the preserved prompt. Codex role files intentionally omit `model`: role-level model
settings outrank spawn arguments, so `hooks/model-router.py` supplies the profile-selected model instead.

The generator writes `hooks/model-routing.json` per target from the neutral model mapping and agent defaults.
Runtime repo profiles normally select `fast`, `balanced`, or `advanced`. Use `"default"` to select the agent's
generated default explicitly, or `"inherit"` to leave the spawn model unchanged. These sentinels distinguish
intentional fallback from a missing route, which the hook denies once a profile exists.

## Validate

Check the committed Claude output without modifying it:

```bash
python3 scripts/generate_definitions.py --target claude --check
```

Check the committed Codex plugin output and validate its manifest:

```bash
python3 scripts/generate_definitions.py --target codex --check
python3 /path/to/plugin-creator/scripts/validate_plugin.py dist/codex/ultracode
```

Run all structural, equivalence, deterministic-generation, tool-mapping, and TOML checks with:

```bash
python3 -m unittest discover -s tests -v
```

The Claude equivalence baseline stores frontmatter values and prompt hashes rather than duplicate prompt
copies. Tests generate both targets twice, compare the trees byte-for-byte, parse every Codex agent with
Python's `tomllib`, validate each source against JSON Schema when `jsonschema` is installed, and ensure all
current declared and orchestration capabilities appear in the mapping.
