---
description: Spawn ultracode:execution-path-analyzer directly — enumerate every execution path through the changed code so tests can cover one path each.
argument-hint: "[implement report path]"
---

# /epa — analyze execution paths

Spawns the `ultracode:execution-path-analyzer` agent directly. It reads an implement report, traces every
execution path through each changed function (branches, early returns, error paths, delegated helpers, boundary
cases), and writes an EPA report that `/write-test` turns into one test per NEW path. Read-only on project
source.

**Spawn the prefixed name** — `subagent_type: ultracode:execution-path-analyzer`, verbatim.

Arguments (may be empty): `$ARGUMENTS`

Run this **after** the implementation code review passes, and ideally after **every** phase is implemented —
analyzing code a later phase is about to change wastes the pass.

Running this command **is** the request for tests, so no gate applies: it overrides a phase file's
`Test policy: Skip`, which only marks which phases a test run would otherwise cover. When the resolved implement
report's phase is tagged `Skip`, say so once ("phase {N} was planned as boilerplate-only: {the header's
rationale} — analyzing anyway because you asked") and proceed. Never refuse on the tag.

## Step 1 — Resolve the implement report, session, and model

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/.claude/ultracode/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-${CLAUDE_CODE_SESSION_ID:-${GROK_SESSION_ID:-no-session-id}}"
mkdir -p "$SESSION_DIR"
echo "session=$SESSION_DIR"
ls -t "$SESSION_DIR" 2>/dev/null | grep -E '^ultracode-(implement|plan)-.*\.md$' | grep -vE '^ultracode-plan-.*-phase-'
```

The session dir is **derived** from `CLAUDE_CODE_SESSION_ID`, else `GROK_SESSION_ID` (inherited unchanged), so
it is the same path `/implement` wrote its report to earlier in this session — no searching for the newest dir.

The listing is newest-first and relative to `$SESSION_DIR`; prefix a name with `$SESSION_DIR/` to get its path.
No output means no such artifact yet (`grep` exits 1 — that is not an error). Never glob the session dir
directly: an unmatched glob aborts the command under zsh.

- **A report path in `$ARGUMENTS`** → use it; its directory is the session dir.
- **Empty arguments** → the newest `ultracode-implement-*.md` in the newest session dir.
- **No implement report** → stop and tell the user to run `/implement` first. The agent's required input is a
  report with a `## Changed Files` section; without one it has no files to trace.

Read `$REPO_ROOT/.claude/ultracode/repo-profile.json`; take the model from
`models.byAgent["execution-path-analyzer"]` (bare key). Absent → omit the `model` argument.

## Step 2 — Spawn

```
subagent_type: ultracode:execution-path-analyzer
model: {models.byAgent["execution-path-analyzer"], or omit}
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Implement report: {implement report path}.
Plan document: {master plan path, or 'None'}.
Trace every execution path through each changed source file's public functions and methods, cross-reference the
existing tests to mark each path NEW or EXISTING, and write your EPA report. Return the report path, the file
count, and the NEW-path count."
```

## Step 3 — Report

Read the EPA report and summarize: files analyzed, total paths, and how many are NEW (each NEW path becomes one
test). Then tell the user to run `/write-test` — it takes this EPA report as its coverage contract.
