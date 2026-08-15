# {{command_prefix}}generate-spec — write the one spec file

Spawns the `ultracode:generate-spec` agent directly. It writes **exactly one** `ultracode-spec-*.md`: every
requirement in EARS notation with Given/When/Then acceptance criteria, grouped into ordered deliverables. Never
a split set, never an index.

**Spawn the prefixed name** — `{{agent_selector}}: ultracode:generate-spec`, verbatim.

Arguments (may be empty): `{{arguments}}`

## Step 1 — Resolve repo, session, and inputs

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/{{runtime_dir}}/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-{{session_id_expr}}"
mkdir -p "$SESSION_DIR"
echo "session=$SESSION_DIR"
ls -t "$SESSION_DIR" 2>/dev/null | grep -E '^ultracode-(criteria|research)-.*\.md$'
```

The session dir is **derived** from {{session_id_source}}, so
it is the same path `{{command_prefix}}explore` wrote to earlier in this session — no searching for the newest dir, and no risk of
picking up another session's artifacts.

The listing is newest-first and relative to `$SESSION_DIR`; prefix a name with `$SESSION_DIR/` to get its path.
No output means no such artifact yet (`grep` exits 1 — that is not an error). Never glob the session dir
directly: an unmatched glob aborts the command under zsh.

- **A criteria doc path in `{{arguments}}`** → use it, and use its directory as the session dir.
- **No path given, `SESSION_DIR` holds a criteria doc** → use the newest one, plus every research doc there.
- **No criteria doc anywhere** → tell the user to run `{{command_prefix}}explore` first (recommended), or to paste the
  requirements inline. If they paste them inline, pass that text in place of the criteria doc path and say so
  in the prompt — never skip the spec stage.
- **No session dir at all** → create one exactly as `{{command_prefix}}explore` Step 1 does.

## Step 2 — Spawn

Omit the `model` argument — the plugin's model-router hook sets it from this repo's profile.

```
{{agent_selector}}: ultracode:generate-spec
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Criteria document: {criteria doc path, or the inline criteria text}.
Research document(s): {comma-separated research paths, or 'None'}.
Request: {the original request, from the criteria doc's topic or {{arguments}}}.
Extra context: {any constraints, preferences, or answers from {{arguments}}, or 'None'}.
Write exactly ONE spec file: every criterion covered by at least one EARS requirement with Given/When/Then
acceptance criteria, grouped into deliverables in build order, with the Contracts Provided and Contracts
Consumed tables filled in. Return the spec file path, the deliverable count, the requirement count, and your
open questions."
```

For a multi-repo spec, replace the `Repo root:` line with `Repos in scope: {repo key} → {absolute root}` (one
per repo) and keep `Session dir:` at the session root — one spec covers every repo.

## Step 3 — Approval gate

Read the spec file, then:

1. Present its Objective, Delivery Order table, and requirement count to the user.
2. Surface its Open Questions with the **AskUserQuestion** tool and wait.
3. **Every answer goes back into the spec file** — re-spawn `ultracode:generate-spec` with the answers so it
   rewrites the spec. Never edit the spec yourself and never carry an answer forward to paste into a plan
   prompt: the plan agent reads only the spec file, so an answer that is not in the spec never reaches the plan.
4. Once the user approves, tell them the next stage is `{{command_prefix}}plan`.
