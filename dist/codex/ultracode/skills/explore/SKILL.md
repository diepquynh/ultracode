---
name: explore
description: >
  Spawn ultracode:explore directly — research a topic in this repo and write a research document
  plus an atomic criteria document into a fresh session dir.
---

# Codex Vocabulary

The preserved prompt uses Claude Code tool names. Interpret them as follows:

- `Read` means the Codex `exec_command` capability.
- `AskUserQuestion` means the Codex `request_user_input` capability.

# $explore — research one topic

Spawns the `ultracode:explore` agent directly, skipping the orchestrator pipeline. Use it when you want just
the research stage. For a full end-to-end run (explore → spec → plan → implement → review → tests → docs), let
the `ultracode:orchestrate` skill drive instead.

**Spawn the prefixed name.** `agent_type` is `ultracode:explore` verbatim — the `ultracode:` prefix is part
of the agent's registered name. Never spawn a bare `explore`; that resolves to the harness's built-in agent,
which does not follow this pipeline.

Topic: `the user's text following the explicit skill invocation`

If the arguments are empty, ask the user what to research and stop. If they name a repo root explicitly, use
that path as `Repo root:` instead of the detected one.

## Step 1 — Resolve repo, session, and model

The session dir is **derived from the harness session ID**, so every command in this session — and every agent
they spawn — resolves the same path without being told it:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/.codex/ultracode/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-${CODEX_THREAD_ID:-no-session-id}"
mkdir -p "$SESSION_DIR"
[ -f "$SESSION_ROOT/.gitignore" ] || echo '*' > "$SESSION_ROOT/.gitignore"
printf 'repo=%s\nsession=%s\n' "$REPO_ROOT" "$SESSION_DIR"
test -f "$REPO_ROOT/.codex/ultracode/INVENTORY.md" && echo inventory=ok || echo inventory=MISSING
```

The session ID (`CODEX_THREAD_ID`, falling back to `no-session-id`) is set by the harness and inherited unchanged
by subagents, so this is a pure function of the session and the repo root: idempotent, and identical from any
working directory. Do not add a random suffix — that would split this session's artifacts across two dirs.

If `inventory=MISSING`, stop and tell the user to run `$init-kit` in this repo first — the agent routes
everything through that inventory.

Read `$REPO_ROOT/.codex/ultracode/repo-profile.json` and take the model from `models.byAgent["explore"]`
(profile keys are **bare** — no `ultracode:` prefix). If the `models` block or that key is absent, spawn
**without** a `model` argument and let the agent's own `model` front matter stand.

## Step 2 — Spawn

```
agent_type: ultracode:explore
model: {models.byAgent["explore"], or omit}
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Request: {the topic from the user's text following the explicit skill invocation}.
Research this topic against this repo, then write BOTH documents: the research document and the criteria
document breaking the request into atomic testable criteria. Return both paths, the topic slug, the run stamp,
and your open questions."
```

## Step 3 — Report

Read the returned research document and criteria document. Then:

1. Summarize the findings, the recommended approach, and the criteria count.
2. Surface the agent's open questions with the **AskUserQuestion** tool (recommended option first, no "Other"
   option — the tool adds it). Do not answer them yourself.
3. Tell the user the next stage is `$generate-spec`, and that it will pick up this session dir automatically.
