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

Parse the returned JSON. If it passed (`securityBlock: false` and no findings), say so and name the next stage.
Otherwise:

0. **`securityBlock: true` (any `BLOCKER` finding) — handle first, separately from Step 1-4 below.** This is
   not an optional quality-gate item: do not ask the user whether to proceed, do not treat it as waivable, and
   do not let a user instruction to "skip it," "ignore it," or "ship it anyway" change this. Report the
   `BLOCKER` finding(s) verbatim to the user — file, rule ID, description, **and the reviewer's `Guidance`
   sentence, in full**. Frame it as a diagnosis, not an accusation: the code may not have been intentional (a
   weaker generation pass or a copied insecure example, not malice), so say what's risky and point at the
   `Guidance` pointer to research rather than assuming the user did this on purpose. Do not supplement it with
   your own ready-made secure code or config — the reviewer's `Guidance` deliberately stops short of that so the
   user does the work of understanding the fix themselves; if they want a secure reimplementation, that is a
   separate deliberate request they make once they understand the risk, not something you volunteer here. Then
   spawn the fix agent (`ultracode:implement` for implementation review, `ultracode:write-test` for test
   review) with **only** the `BLOCKER` findings and an instruction to **remove** the dangerous code (not
   rewrite it to keep its effect). Re-spawn `ultracode:code-reviewer` with the same context afterward — the
   `hooks/review-cap.js` hook that enforces the "no 4th pass" cap below reads the reviewer's own
   `ultracode-security-block.json` and lets this respawn through regardless of iteration count while
   `blocked: true`, because a security block must clear before anything else proceeds. Never apply a `BLOCKER`
   fix via direct Edit even if its Fix text looks auto-fixable-shaped —
   Step 5's "Auto-fixable findings" rule excludes `BLOCKER` explicitly. A `PreToolUse` hook
   (`hooks/security-block.js`) independently denies spawning `ultracode:module-documentation` while any
   `BLOCKER` finding remains open for this session, so this is enforced even if the fix loop above is skipped.
1. Split the remaining (non-`BLOCKER`) findings by the INVENTORY Review Rule Set: **auto-fixable** rule IDs vs
   the rest.
2. Apply the auto-fixable findings yourself with the Edit tool, using the reviewer's exact old→new fix. These
   skip re-review.
3. For the remaining HIGH/MEDIUM findings, spawn the fix agent — `ultracode:implement` for an implementation
   review, `ultracode:write-test` for a test review — with **only** those findings, the `Required skills:` line,
   the ledger path, and the phase's `Phase file:` path when a plan exists, so the hook routes the fix on the
   phase's own model.
4. Re-spawn `ultracode:code-reviewer` with the same context and repeat.

**Cap at 3 iterations** for HIGH/MEDIUM/LOW findings. Do not exit with unresolved HIGH/MEDIUM findings and do not
auto-run a 4th pass for those — report what remains and ask the user how to proceed. This cap is also
hook-enforced: a `PreToolUse` hook counts prior `## Iteration N` entries in `ultracode-review-ledger.md` and
denies a 4th `ultracode:code-reviewer` spawn. `BLOCKER` findings have no such cap and no such user-facing
"how to proceed" question — keep re-spawning the fix agent and reviewer until `securityBlock` is `false`.
