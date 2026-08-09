---
description: Spawn ultracode:plan directly — turn the approved spec file into a phased implementation plan with per-phase files.
argument-hint: "[spec file path]"
---

# /plan — plan from the approved spec

Spawns the `ultracode:plan` agent directly. It reads **one spec file and nothing else**, and writes a master
plan (summary, Phase Index, risks, verification) plus one self-contained file per phase.

**Spawn the prefixed name** — `subagent_type: ultracode:plan`, verbatim. A bare `plan` resolves to the
harness's built-in Plan agent, which ignores this pipeline.

Arguments (may be empty): `$ARGUMENTS`

## Step 1 — Resolve the spec, session, and model

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/.claude/ultracode/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-${CLAUDE_CODE_SESSION_ID:-no-session-id}"
mkdir -p "$SESSION_DIR"
echo "session=$SESSION_DIR"
ls -t "$SESSION_DIR" 2>/dev/null | grep -E '^ultracode-spec-.*\.md$'
```

The session dir is **derived** from the harness's `CLAUDE_CODE_SESSION_ID` (inherited unchanged by subagents), so
it is the same path `/generate-spec` wrote to earlier in this session — no searching for the newest dir, and no
risk of planning another session's spec.

The listing is newest-first and relative to `$SESSION_DIR`; prefix a name with `$SESSION_DIR/` to get its path.
No output means no spec exists yet (`grep` exits 1 — that is not an error). Never glob the session dir directly:
an unmatched glob aborts the command under zsh.

- **A spec path in `$ARGUMENTS`** → use it; its directory is the session dir.
- **No path given** → use the newest `ultracode-spec-*.md` in the newest session dir. If several exist, list
  them and ask which one to plan.
- **No spec file anywhere** → stop and tell the user to run `/generate-spec` first. Do **not** plan from a
  criteria document, a research document, or the raw request: the plan agent's one requirements source is the
  approved spec.

Read `$REPO_ROOT/.claude/ultracode/repo-profile.json`; take the model from `models.byAgent["plan"]` (bare key).
Absent → omit the `model` argument.

## Step 2 — Spawn

```
subagent_type: ultracode:plan
model: {models.byAgent["plan"], or omit}
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Specification: {spec file path}.
Request: {the spec's Objective, one line}.
Plan this specification: phases in dependency order, each phase tagged with its deliverable, its repo, its
Depends-on set, its Complexity tier, and its Test policy (Required or Skip, per your rule P12, with the
one-sentence rationale); every step naming one file, one prose action, its required skills, and its
verification command from this repo's profile. Return the master plan path, every phase file path, and each
phase's Complexity tier and Test policy."
```

Pass **only** the spec file path. Do not pass the research document, the criteria document, or loose user
answer text — a second requirements source lets the plan diverge from the contract the user approved.

For a multi-repo plan, replace `Repo root:` with `Repos in scope: {repo key} → {absolute root}` (one per repo).

## Step 3 — Approval gate

Read the master plan. Present the Phase Index (phase, deliverable, repo, depends-on, complexity, test policy),
the risks, and the success criteria. Surface any Clarifying Questions with the **AskUserQuestion** tool.

Call out every phase tagged `Test policy: Skip` by name, with its rationale from the master plan's Test Policy
Rationale table. The tag does not decide whether tests get written — the user does, after every phase is
implemented — it decides which phases a requested test run would cover: a `Skip` phase would get no EPA, no
tests, and no test review. This gate is the user's chance to overrule that. If the user wants a skipped phase
covered, note it and treat that phase as `Required` if a test run happens.

A requirement change at this gate restarts at the spec: re-run `/generate-spec` with the change, get the
updated spec approved, then re-run `/plan` on it. Never patch a phase file to match a new requirement.

Once approved, tell the user to run `/implement` per phase (it picks up phase 1 by default), or to let
`ultracode:orchestrate` drive the remaining phases end to end. Either way, tests and module docs come after
**all** phases and only on request — the orchestrator offers both once the last phase passes review.
