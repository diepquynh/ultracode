# Commands

Two ways to run the pipeline. The `ultracode:orchestrate` skill drives it end to end — classify, spec, plan,
implement, review, test, document — and is what you want for a real task. The commands below spawn **one agent
each**, for when you want a single stage and nothing else: re-run just the review, get an EPA report for code you
wrote by hand, write a spec off a criteria doc you edited.

| Command | Agent it spawns | Reads | Writes |
| --- | --- | --- | --- |
| `/init-kit` | `ultracode:initializer` (5 modes, fanned out) | the repo | `.claude/skills/*`, `INVENTORY.md`, `repo-profile.json` |
| `/explore` | `ultracode:explore` | the repo + its inventory | research doc + criteria doc |
| `/generate-spec` | `ultracode:generate-spec` | criteria + research docs | exactly one `ultracode-spec-*.md` |
| `/plan` | `ultracode:plan` | the spec file, and nothing else | master plan + per-phase files |
| `/implement` | `ultracode:implement` | one phase file (or inline instructions) | source changes + change report |
| `/code-review` | `ultracode:code-reviewer` | the working tree + the Review Rule Set | findings JSON (+ ledger) |
| `/epa` | `ultracode:execution-path-analyzer` | the implement report | EPA report (one row per path) |
| `/write-test` | `ultracode:write-test` | implement + EPA reports | test files + test report |
| `/module-docs` | `ultracode:module-documentation` | every implement report | `module-hub/references/{area}.md` |
| `/prompt-gen` | `ultracode:prompt-generation` | the target instruction file | that file + a report |

Every command takes optional arguments (`/plan path/to/spec.md`) and otherwise infers its input from this
session's directory — `.claude/ultracode/session/ultracode-session-$CLAUDE_CODE_SESSION_ID`, derived rather than
searched for, so each command reads exactly what the previous one wrote and never another session's artifacts
(see [Architecture](architecture.md)). Running them in pipeline order therefore needs no arguments at all:

```
/explore <topic> → /generate-spec → /plan → /implement → /code-review → /epa → /write-test → /code-review → /module-docs
```

Each command resolves its own model the same way the orchestrator does: from the repo's `repo-profile.json`
`models` block, by the **bare** agent name (`models.byAgent["explore"]`), falling back to the session model when
the profile is silent. `/implement` and `/write-test` resolve theirs from `models.byPhaseComplexity` on the
phase's Complexity tier instead.

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
