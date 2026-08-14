---
name: generate-spec
description: >
  Spawn ultracode:generate-spec directly — turn an explore criteria document into the single EARS
  specification file the plan agent reads.
---

# Codex Vocabulary

The preserved prompt uses Claude Code tool names. Interpret them as follows:

- `Read` means the Codex `exec_command` capability.
- `Write` means the Codex `apply_patch` capability.
- `AskUserQuestion` means the Codex `request_user_input` capability.

# $generate-spec — write the one spec file

Spawns the `ultracode:generate-spec` agent directly. It writes **exactly one** `ultracode-spec-*.md`: every
requirement in EARS notation with Given/When/Then acceptance criteria, grouped into ordered deliverables. Never
a split set, never an index.

**Spawn the prefixed name** — `agent_type: ultracode:generate-spec`, verbatim.

Arguments (may be empty): `the user's text following the explicit skill invocation`

## Step 1 — Resolve repo, session, inputs, and model

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/.codex/ultracode/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-${CODEX_THREAD_ID:-no-session-id}"
mkdir -p "$SESSION_DIR"
echo "session=$SESSION_DIR"
ls -t "$SESSION_DIR" 2>/dev/null | grep -E '^ultracode-(criteria|research)-.*\.md$'
```

The session dir is **derived** from `CODEX_THREAD_ID`, falling back to `no-session-id` (inherited unchanged), so
it is the same path `$explore` wrote to earlier in this session — no searching for the newest dir, and no risk of
picking up another session's artifacts.

The listing is newest-first and relative to `$SESSION_DIR`; prefix a name with `$SESSION_DIR/` to get its path.
No output means no such artifact yet (`grep` exits 1 — that is not an error). Never glob the session dir
directly: an unmatched glob aborts the command under zsh.

- **A criteria doc path in `the user's text following the explicit skill invocation`** → use it, and use its directory as the session dir.
- **No path given, `SESSION_DIR` holds a criteria doc** → use the newest one, plus every research doc there.
- **No criteria doc anywhere** → tell the user to run `$explore` first (recommended), or to paste the
  requirements inline. If they paste them inline, pass that text in place of the criteria doc path and say so
  in the prompt — never skip the spec stage.
- **No session dir at all** → create one exactly as `$explore` Step 1 does.

Read `$REPO_ROOT/.codex/ultracode/repo-profile.json`; take the model from `models.byAgent["generate-spec"]`
(bare key). Absent → omit the `model` argument.

## Step 2 — Spawn

```
agent_type: ultracode:generate-spec
model: {models.byAgent["generate-spec"], or omit}
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Criteria document: {criteria doc path, or the inline criteria text}.
Research document(s): {comma-separated research paths, or 'None'}.
Request: {the original request, from the criteria doc's topic or the user's text following the explicit skill invocation}.
Extra context: {any constraints, preferences, or answers from the user's text following the explicit skill invocation, or 'None'}.
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
4. Once the user approves, tell them the next stage is `$plan`.
