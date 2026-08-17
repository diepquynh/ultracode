# {{command_prefix}}code-review — review the current changes

Spawns the `ultracode:code-reviewer` agent directly. It detects uncommitted changes from git, judges each
against this repo's Review Rule Set, and returns findings as one JSON object. It never modifies project source.

**Spawn the prefixed name** — `{{agent_selector}}: ultracode:code-reviewer`, verbatim.

Arguments (may be empty): `{{arguments}}`

## Step 1 — Resolve context and scope

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/{{runtime_dir}}/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-{{session_id_expr}}"
mkdir -p "$SESSION_DIR"
echo "session=$SESSION_DIR"
git -C "$REPO_ROOT" status --short
ls -t "$SESSION_DIR" 2>/dev/null | grep -E '^ultracode-(implement|epa)-.*\.md$'
```

The session dir is **derived** from {{session_id_source}}, so
the review ledger lands beside this session's other artifacts and every re-review in the fix loop finds the same
ledger.

The listing is newest-first and relative to `$SESSION_DIR`; prefix a name with `$SESSION_DIR/` to get its path.
No output means no such artifact yet (`grep` exits 1 — that is not an error). Never glob the session dir
directly: an unmatched glob aborts the command under zsh.

- **No uncommitted changes** → say so and stop; there is nothing to review.
- **No session dir** → create one as `{{command_prefix}}explore` Step 1 does; the reviewer writes its ledger there.
- **Review context** from `{{arguments}}`: `implementation`, `test`, or `full`. Default: `test` when the changed
  files are all under the repo's test roots, otherwise `implementation`.
- **Review scope:** pass `unstaged` when implementation files are already staged (the pipeline's staging step),
  otherwise omit the line.
- For a `test` review, pass the newest EPA report so the reviewer can check path coverage.

## Step 2 — Spawn

Omit the `model` argument — the plugin's model-router hook sets it from this repo's profile.

```
{{agent_selector}}: ultracode:code-reviewer
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
   the ledger path, and the phase's `Phase file:` path when a plan exists, so the hook routes the fix on the
   phase's own model.
4. Re-spawn `ultracode:code-reviewer` with the same context and repeat.

**Cap at 3 iterations.** Do not exit with unresolved HIGH/MEDIUM findings and do not auto-run a 4th pass — report
what remains and ask the user how to proceed. This cap is also hook-enforced: a `PreToolUse` hook counts prior
`## Iteration N` entries in `ultracode-review-ledger.md` and denies a 4th `ultracode:code-reviewer` spawn.
