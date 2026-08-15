# {{command_prefix}}prompt-gen — author an instruction file

Spawns the `ultracode:prompt-generation` agent directly. It writes or edits instruction files — AI/LLM system
prompts, `SKILL.md` skills, subagent markdown — applying the meta-author standard (the 15 Laws,
Chain-of-Thought rules, archetypes, self-review checklist). It edits files directly.

**Spawn the prefixed name** — `{{agent_selector}}: ultracode:prompt-generation`, verbatim.

Task: `{{arguments}}`

If the arguments are empty, ask what to write or edit and stop.

## Step 1 — Resolve the target and session

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/{{runtime_dir}}/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-{{session_id_expr}}"
mkdir -p "$SESSION_DIR"
[ -f "$SESSION_ROOT/.gitignore" ] || echo '*' > "$SESSION_ROOT/.gitignore"
echo "session=$SESSION_DIR"
```

The path is derived from the harness's session ID ({{session_id_names}}), which
subagents inherit unchanged — so it resolves to the same dir whether or not an earlier command in this session
already created it. `mkdir -p` on an existing dir is a no-op.

Resolve the **target**: an explicit path in `{{arguments}}`, the file the task names, or `New` when the agent is
creating one. If the target exists, note its path so the agent edits rather than rewrites blindly.

## Step 2 — Spawn

Omit the `model` argument — the plugin's model-router hook sets it from this repo's profile, and prompt
authoring works in a repo that has no profile at all.

```
{{agent_selector}}: ultracode:prompt-generation
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Target: {absolute target path, or 'New'}.
Task: {the request from {{arguments}}}.
Author or edit the target against the meta-author standard, self-review it against the checklist, and write your
report. Return the report path, the files written, and your self-review result."
```

## Step 3 — Report

Read the report and summarize what was written and how the self-review landed. If the agent changed files that
this repo's review rules cover, run `{{command_prefix}}code-review` over them.
