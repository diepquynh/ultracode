---
description: Spawn ultracode:module-documentation directly — update the module-hub area references for everything the finished phases changed.
argument-hint: "[comma-separated implement report paths]"
---

# /module-docs — document the changed areas

Spawns the `ultracode:module-documentation` agent directly. It maps every changed file to an area via the
INVENTORY Module/Area Map and writes the area references under `.claude/skills/module-hub/references/`, grounded
in real source. It edits only those reference files.

**Spawn the prefixed name** — `subagent_type: ultracode:module-documentation`, verbatim.

Arguments (may be empty): `$ARGUMENTS`

This is the pipeline's last stage. Run it once, after **every** phase has passed review — not after each
deliverable. Pass every implement report so it documents the finished feature rather than an intermediate state.

## Step 1 — Collect the reports, session, and model

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/.claude/ultracode/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-${CLAUDE_CODE_SESSION_ID:-no-session-id}"
mkdir -p "$SESSION_DIR"
echo "session=$SESSION_DIR"
ls -t "$SESSION_DIR" 2>/dev/null | grep -E '^ultracode-(implement|spec|plan|research)-.*\.md$' | grep -vE '^ultracode-plan-.*-phase-'
```

The session dir is **derived** from the harness's `CLAUDE_CODE_SESSION_ID` (inherited unchanged by subagents), so
every earlier stage's reports are in this one dir — which is what lets this command pick up *every* phase's
implement report rather than whichever dir happened to be newest.

The listing is newest-first and relative to `$SESSION_DIR`; prefix a name with `$SESSION_DIR/` to get its path.
No output means no such artifact yet (`grep` exits 1 — that is not an error). Never glob the session dir
directly: an unmatched glob aborts the command under zsh.

- **Paths in `$ARGUMENTS`** → use exactly those implement reports.
- **Empty arguments** → **every** `ultracode-implement-*.md` in the newest session dir, plus the spec, the
  master plan, and the research doc if present.
- **No implement report** → stop and say there is nothing to document; the agent grounds its documentation in
  what actually changed.

Run this repo's `format` command (from the profile's `commands.format`) once before spawning, so the documented
source matches its final formatting.

Read `$REPO_ROOT/.claude/ultracode/repo-profile.json`; take the model from
`models.byAgent["module-documentation"]` (bare key). Absent → omit the `model` argument.

## Step 2 — Spawn

```
subagent_type: ultracode:module-documentation
model: {models.byAgent["module-documentation"], or omit}
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Implement reports: {comma-separated paths, every phase}.
Spec: {spec file path, or 'None'}.
Plan: {master plan path, or 'None'}.
Research: {research doc path, or 'None'}.
Map every changed file to its area, then create or update each affected area reference under
.claude/skills/module-hub/references/, grounded in the real source and documenting the final state of each area.
Return the report path, the areas touched, and the files written."
```

## Step 3 — Report

Read the report and tell the user which area references were created or updated, plus anything it skipped
(unmatched files, unreadable source). Those reference files are project artifacts — worth committing alongside
the change so the team shares them.
