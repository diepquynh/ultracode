# Commands

Two ways to run the pipeline. The `ultracode:orchestrate` skill drives it end to end — classify, spec, plan,
implement, review, then offer to test and document — and is what you want for a real task. The commands below
spawn **one agent each**, for when you want a single stage and nothing else: re-run just the review, get an EPA
report for code you wrote by hand, write a spec off a criteria doc you edited.

Claude Code exposes these as slash commands (`/explore`). Codex packages the same workflows as explicit-only
skills (`$explore`) because distributable Codex custom prompts are not a plugin component. In the table,
`/<name>` means `/name` on Claude Code and `$name` on Codex.

| Command | Agent it spawns | Reads | Writes |
| --- | --- | --- | --- |
| `/init-kit` | `ultracode:initializer` (5 modes, fanned out) | the repo | harness skill directory, `INVENTORY.md`, `repo-profile.json` |
| `/explore` | `ultracode:explore` | the repo + its inventory, plus vendor docs for anything the repo does not use | research doc + criteria doc |
| `/generate-spec` | `ultracode:generate-spec` | criteria + research docs | exactly one `ultracode-spec-*.md` |
| `/plan` | `ultracode:plan` | the spec file, and nothing else | master plan + per-phase files |
| `/implement` | `ultracode:implement` | one phase file (or inline instructions) | source changes + change report |
| `/code-review` | `ultracode:code-reviewer` | the working tree + the Review Rule Set | findings JSON (+ ledger) |
| `/epa` | `ultracode:execution-path-analyzer` | the implement report | EPA report (one row per path) |
| `/write-test` | `ultracode:write-test` | implement + EPA reports | test files + test report |
| `/module-docs` | `ultracode:module-documentation` | every implement report | `module-hub/references/{area}.md` |
| `/prompt-gen` | `ultracode:prompt-generation` | the target instruction file | that file + a report |

Every command takes optional arguments (`/plan path/to/spec.md` or `$plan path/to/spec.md`) and otherwise
infers its input from the harness runtime directory. Claude derives its session suffix from
`CLAUDE_CODE_SESSION_ID`/`GROK_SESSION_ID`; Codex uses `CODEX_THREAD_ID`. Running the commands in pipeline order
therefore needs no arguments at all:

```
/explore <topic> → /generate-spec → /plan → /implement → /code-review   (repeat per phase)
                 → then, optionally: /epa → /write-test → /code-review · /module-docs
```

The sequence above uses Claude syntax; replace each leading `/` with `$` on Codex.

Everything after the per-phase `/code-review` is **optional**, and belongs after **every** phase rather than
between them. The orchestrator runs those stages only if you ask for them; running the commands yourself is
itself the ask. `/epa` and `/write-test` write tests; `/module-docs` updates the area references.

Within a test run, the plan's `Test policy: Skip` tag marks the phases not worth covering — every step
boilerplate, no execution path to trace. Running `/epa` by hand overrides that tag: the command notes the phase
was planned as boilerplate-only and analyzes it anyway.

No command picks a model, and neither does the orchestrator. The plugin's `PreToolUse` hook
(`hooks/model-router.py`) intercepts every `ultracode:*` spawn, resolves the route from the `models` block of
that spawn's own `repo-profile.json`, and sets the `model` argument itself — by the **bare** agent name
(`models.byAgent["explore"]`), or, for `/implement` and `/write-test`, from `models.byPhaseComplexity` on the
phase's Complexity tier, which the hook reads out of the `Phase file:` path those commands pass. Routes
normally use the neutral tiers `fast`, `balanced`, or `advanced`; `"default"` explicitly selects the generated
agent default and `"inherit"` intentionally leaves the spawn model untouched.

Because the hook re-reads `repo-profile.json` from disk on every spawn, edits take effect on the next one with
no restart, and a stale in-context copy of a profile cannot misroute a stage. Once a profile exists, a missing
or malformed route is denied rather than treated as an accidental fallback.

`/init-kit` is the exception, because it runs before there is a profile to route by: it sets a model per
initializer mode itself (advanced for skill generation, balanced for the rest). The hook leaves those spawns
alone rather than denying them for a missing route, so re-initializing a repo that already has a profile
behaves like a first run. Add an `initializer` entry to `models.byAgent` only to override that per-mode choice.

## What the commands don't do

A command is one spawn, so the orchestrator's cross-stage guarantees are yours to keep:

- **The review loop.** `/code-review` runs its fix loop (auto-fixable findings applied directly, the rest sent
  to the fix agent, re-reviewed, capped at 3 iterations) — but only when you run it. `/implement` does not call
  it for you.
- **Multi-repo scheduling.** Commands target one repo: the git root of the working directory, or the path you
  pass. Parallel fan-out across repos and the cross-repo dependency graph live in `ultracode:orchestrate`.
- **The approval gates.** `/generate-spec` and `/plan` each present their artifact for approval, and a
  requirement change after the spec exists means re-running `/generate-spec` — never hand-editing a spec or a
  phase file.
- **The closing gate.** The orchestrator waits until every phase has passed review, then offers tests and
  module docs once and runs what you pick — and names what it skipped. Driving the commands by hand, that
  bookkeeping is yours: nothing prompts you, and nothing reminds you that a phase went uncovered. The plan tags
  each phase `Required` or `Skip`, and the phase file's `Test policy:` header tells you what it concluded.
