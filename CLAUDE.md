# Ultracode

A harness-neutral agent pipeline. One set of sources under `agents/`, `commands/`, and `skills/` generates
plugin trees for Claude Code, Codex, Grok Build, and Antigravity.

## Writing style

Every `.md` in this repo is read by a model and by a person. Write for both. The whole file set was rewritten
in plain language on 2026-09-02; keep it there.

Run the `avoid-ai-writing` skill on any prose you add to a prompt, a skill, a doc, or the README. Use edit
mode, context `docs`, voice `technical`. The rules below are the ones that have come up here.

**Mechanics**

- Em dash count is zero, including in headings. Use a colon, a period, or a comma.
- Sentence case for headings.
- Bold the rule name, not the sentence. One bolded span per paragraph at most.
- Straight quotes.

**Prose**

- Lead with the instruction. Put the reason after it, in one sentence.
- State what a thing is. Do not stack negations ("never X, never Y, never Z") for rhythm.
- No superlatives standing in for a number. Write the cost, the count, or the failure.
- No reassurance tails: "that is normal", "treat it as the method, not a budget cap", "not on principle".
- Keep causal rationale. A model that knows why a rule exists applies it to cases the rule did not list.
  Cutting the "because" clause reads blunter and executes worse.
- Cut hedges that change no action. Keep a frequency claim that is true and drives the next instruction.

## Editing agents, commands, and skills

`agents/<name>/definition.json` plus `agents/<name>/prompt.md` are the source of truth. `dist/` is generated
and gitignored. Never edit `dist/` by hand.

After changing a definition, a prompt, or a skill:

```bash
for t in claude codex grok antigravity; do node scripts/generate_definitions.js --target $t; done
node --test tests/*.test.js          # 138 tests
```

`tests/claude-baseline.json` pins each agent's and skill's frontmatter and `body_sha256`. Any prompt or
description edit changes a hash and fails `claude generation matches pre-refactor behavior`. Update the
baseline in the same commit as the edit that caused it, using the test's own `splitFrontmatter` so only the
entries that really moved change.

`node scripts/generate_definitions.js --target <t> --check` verifies `dist/` matches source without writing.

### Things that break silently

- **Rule IDs are cross-referenced.** `K1`-`K8`, `S1`-`S8`, `R-a`-`R-e`, `AC-a`-`AC-d` in generate-spec;
  `P0`-`P13` in plan; Rules `D1`-`D6`, `M2`-`M6`, `T1`-`T7` in orchestrate. Prose elsewhere cites them by
  name, so renaming one orphans every citation. Note that `D{n}` also names a spec's deliverables, which is a
  separate namespace.
- **Parameter labels are matched by a hook.** `Prior findings:`, `Source check:`, `Spec file:`, `Repo key:`
  and the rest are keys in `hooks/subagent-parameters.json`. `hooks/session-guard.js` denies a spawn missing a
  required one. Change the label and the contract in the same edit.
- **Agent descriptions load into every session.** They are the routing index. Say what the agent does, then
  when to spawn it. Mechanism detail belongs in `prompt.md`.
- **`{{tool_*}}` and `{{skills_dir}}` tokens are substituted per harness.** Do not hardcode a tool name or a
  path that varies.

## Guards you will hit

These are the plugin's own hooks, running against this repo. They are working as intended.

- Running or editing anything under `dist/` from a tool call is denied. Reading is allowed. Verify hook logic
  against the source libs in `hooks/lib/` instead.
- Passing inline code to an interpreter that then writes a file (`node -e`, a heredoc piped to `python3`) is
  denied. The write guard reads paths from tool calls and there are none there. Use Write, Edit, or a shell
  redirect that names the path.
- Spawning a child process from inline interpreter code is denied.

## Layout

| Path | Contents |
| --- | --- |
| `agents/<name>/` | `definition.json` (config, tools, model tier) and `prompt.md` |
| `commands/<name>/` | Slash commands: `orchestrate`, `init-kit`, `hub-listen`, `yolo` |
| `skills/<name>/` | Skills shipped with the plugin |
| `definitions/` | Schema, harness layout, tool and model mappings |
| `hooks/` | PreToolUse and PostToolUse guards, plus `lib/` |
| `mcp/` | `ultracode_gate` server and the cross-harness hub |
| `scripts/generate_definitions.js` | The generator |
| `docs/` | Architecture, agents, definitions, model routing, harness limitations |
