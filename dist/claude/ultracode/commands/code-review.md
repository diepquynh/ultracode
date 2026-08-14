---
description: Spawn ultracode:code-reviewer directly — review the working tree's changes against this repo's Review Rule Set and run the fix loop.
argument-hint: "[implementation | test | full] [| scope: unstaged]"
---

# /code-review — review the current changes

Spawns the `ultracode:code-reviewer` agent directly. It detects uncommitted changes from git, judges each
against this repo's Review Rule Set, and returns findings as one JSON object. It never modifies project source.

**Spawn the prefixed name** — `subagent_type: ultracode:code-reviewer`, verbatim.

Arguments (may be empty): `$ARGUMENTS`

## Step 1 — Resolve context, scope, and model

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/.claude/ultracode/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-${CLAUDE_CODE_SESSION_ID:-${GROK_SESSION_ID:-no-session-id}}"
mkdir -p "$SESSION_DIR"
echo "session=$SESSION_DIR"
git -C "$REPO_ROOT" status --short
ls -t "$SESSION_DIR" 2>/dev/null | grep -E '^ultracode-(implement|epa)-.*\.md$'
```

The session dir is **derived** from `CLAUDE_CODE_SESSION_ID`, else `GROK_SESSION_ID` (inherited unchanged), so
the review ledger lands beside this session's other artifacts and every re-review in the fix loop finds the same
ledger.

The listing is newest-first and relative to `$SESSION_DIR`; prefix a name with `$SESSION_DIR/` to get its path.
No output means no such artifact yet (`grep` exits 1 — that is not an error). Never glob the session dir
directly: an unmatched glob aborts the command under zsh.

- **No uncommitted changes** → say so and stop; there is nothing to review.
- **No session dir** → create one as `/explore` Step 1 does; the reviewer writes its ledger there.
- **Review context** from `$ARGUMENTS`: `implementation`, `test`, or `full`. Default: `test` when the changed
  files are all under the repo's test roots, otherwise `implementation`.
- **Review scope:** pass `unstaged` when implementation files are already staged (the pipeline's staging step),
  otherwise omit the line.
- For a `test` review, pass the newest EPA report so the reviewer can check path coverage.

Read `$REPO_ROOT/.claude/ultracode/repo-profile.json`; take the model from `models.byAgent["code-reviewer"]`
(bare key). Absent → omit the `model` argument.

## Step 2 — Spawn

```
subagent_type: ultracode:code-reviewer
model: {models.byAgent["code-reviewer"], or omit}
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Review context: {implementation | test | full}.
Review scope: unstaged                 # omit unless staging is in effect
Implement report: {newest implement report path, or 'None'}.
EPA report: {newest EPA report path, or 'None'}   # test reviews only
Review the changed files against this repo's Review Rule Set and return your findings JSON."
```

## Step 3 — The fix loop

Parse the returned JSON. If it passed, say so and name the next stage. Otherwise:

1. Split findings by the INVENTORY Review Rule Set: **auto-fixable** rule IDs vs the rest.
2. Apply the auto-fixable findings yourself with the Edit tool, using the reviewer's exact old→new fix. These
   skip re-review.
3. For the remaining HIGH/MEDIUM findings, spawn the fix agent — `ultracode:implement` for an implementation
   review, `ultracode:write-test` for a test review — with **only** those findings, the `Required skills:` line,
   and the ledger path. Spawn it on the phase's own Complexity tier from
   `models.byPhaseComplexity` (`low` for an inline task).
4. Re-spawn `ultracode:code-reviewer` with the same context and repeat.

**Cap at 3 iterations.** Do not exit with unresolved HIGH/MEDIUM findings and do not auto-run a 4th pass — report
what remains and ask the user how to proceed.
