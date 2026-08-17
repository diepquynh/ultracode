# {{command_prefix}}fact-check — verify a spec or plan before approval

Spawns the `ultracode:fact-check` agent directly. It checks every concrete claim in a spec or plan file — a
referenced file/function, an external-tech behavior, a cross-reference — against the repo and any research
docs, and returns a verdict as one JSON object. It never modifies project source.

**Spawn the prefixed name** — `{{agent_selector}}: ultracode:fact-check`, verbatim.

Arguments (may be empty): `{{arguments}}`

## Step 1 — Resolve context and scope

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/{{runtime_dir}}/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-{{session_id_expr}}"
mkdir -p "$SESSION_DIR"
echo "session=$SESSION_DIR"
ls -t "$SESSION_DIR" 2>/dev/null | grep -E '^ultracode-(spec|plan|research)-.*\.md$'
```

The session dir is **derived** from {{session_id_source}}, so an existing spec/plan from this session is found
without the user having to name it.

- **Target from `{{arguments}}`:** `spec` or `plan`, optionally followed by an explicit path. If no path is
  given, use the newest matching file from the listing above (`ultracode-spec-*.md` for `spec`,
  `ultracode-plan-*.md` — the master file, not a phase file — for `plan`).
- **No matching file found** → say so and stop; there is nothing to fact-check.
- **Research doc:** for a `spec` target, pass every `ultracode-research-*.md` in the session dir (fact-check
  cross-references external-tech claims against them).

## Step 2 — Spawn

Omit the `model` argument — the plugin's model-router hook sets it from this repo's profile (fact-check is
exempt from requiring an explicit route, like the initializer, so this works even before a profile exists).

```
{{agent_selector}}: ultracode:fact-check
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Target: {absolute path to the spec or master plan file}.
Target type: {spec | plan}.
Research doc: {every research doc path, or 'None'}   # spec targets only
Verify every concrete claim against the repo and any research docs and return your findings JSON."
```

## Step 3 — Act on the verdict

Parse the returned JSON. `PASS` → say so; the `ultracode_gate` MCP tool will now accept an `approved` decision
for this target. `FAIL` → report each finding, fix the target by re-spawning its owning agent
(`ultracode:generate-spec` for a spec, `ultracode:plan` for a plan) with the exact findings, then re-spawn
`ultracode:fact-check` on the corrected file. There is no hard iteration cap here — unlike the code-review
loop, a repeated FAIL only means the corrected file goes back through fact-check again — but after several
rounds of the same finding recurring, stop and ask the user how to proceed rather than continuing to retry.
