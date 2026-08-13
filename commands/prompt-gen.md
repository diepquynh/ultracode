---
description: Spawn ultracode:prompt-generation directly — author or edit a prompt, SKILL.md, or subagent file against the meta-author standard.
argument-hint: "<what to write or edit> [| target: path/to/file.md]"
---

# /prompt-gen — author an instruction file

Spawns the `ultracode:prompt-generation` agent directly. It writes or edits instruction files — AI/LLM system
prompts, `SKILL.md` skills, subagent markdown — applying the meta-author standard (the 15 Laws,
Chain-of-Thought rules, archetypes, self-review checklist). It edits files directly.

**Spawn the prefixed name** — `subagent_type: ultracode:prompt-generation`, verbatim.

Task: `$ARGUMENTS`

If the arguments are empty, ask what to write or edit and stop.

## Step 1 — Resolve the target, session, and model

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/.claude/ultracode/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-${CLAUDE_CODE_SESSION_ID:-${GROK_SESSION_ID:-no-session-id}}"
mkdir -p "$SESSION_DIR"
[ -f "$SESSION_ROOT/.gitignore" ] || echo '*' > "$SESSION_ROOT/.gitignore"
echo "session=$SESSION_DIR"
```

The path is derived from the harness's session ID (`CLAUDE_CODE_SESSION_ID`, else `GROK_SESSION_ID`), which
subagents inherit unchanged — so it resolves to the same dir whether or not an earlier command in this session
already created it. `mkdir -p` on an existing dir is a no-op.

Resolve the **target**: an explicit path in `$ARGUMENTS`, the file the task names, or `New` when the agent is
creating one. If the target exists, note its path so the agent edits rather than rewrites blindly.

Read `$REPO_ROOT/.claude/ultracode/repo-profile.json`; take the model from
`models.byAgent["prompt-generation"]` (bare key). Absent → omit the `model` argument. This repo may have no
profile at all (prompt authoring does not need an inventory) — then just omit the argument.

## Step 2 — Spawn

```
subagent_type: ultracode:prompt-generation
model: {models.byAgent["prompt-generation"], or omit}
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Target: {absolute target path, or 'New'}.
Task: {the request from $ARGUMENTS}.
Author or edit the target against the meta-author standard, self-review it against the checklist, and write your
report. Return the report path, the files written, and your self-review result."
```

## Step 3 — Report

Read the report and summarize what was written and how the self-review landed. If the agent changed files that
this repo's review rules cover, run `/code-review` over them.
