# {{command_prefix}}write-test — cover the new execution paths

Spawns the `ultracode:write-test` agent directly. The EPA report is its coverage contract: one test per path
marked NEW, written strictly per this repo's test skills. It writes only test code, never implementation code.

**Spawn the prefixed name** — `{{agent_selector}}: ultracode:write-test`, verbatim.

Arguments (may be empty): `{{arguments}}`

## Step 1 — Resolve the reports and skills

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/{{runtime_dir}}/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-{{session_id_expr}}"
mkdir -p "$SESSION_DIR"
echo "session=$SESSION_DIR"
ls -t "$SESSION_DIR" 2>/dev/null | grep -E '^ultracode-(epa|implement)-.*\.md$'
```

The session dir is **derived** from {{session_id_source}}, so
it is the same path `{{command_prefix}}epa` and `{{command_prefix}}implement` wrote their reports to earlier in this session — no searching for the
newest dir.

The listing is newest-first and relative to `$SESSION_DIR`; prefix a name with `$SESSION_DIR/` to get its path.
No output means no such artifact yet (`grep` exits 1 — that is not an error). Never glob the session dir
directly: an unmatched glob aborts the command under zsh.

- **An EPA path in `{{arguments}}`** → use it, plus the implement report it names.
- **Empty arguments** → the newest `ultracode-epa-*.md` and the newest `ultracode-implement-*.md` in the newest
  session dir. Match them by phase number when both are phased.
- **No EPA report** → stop and tell the user to run `{{command_prefix}}epa` first. This agent needs both inputs: the implement
  report for the changed files and the EPA report for the paths to cover.

Read `$REPO_ROOT/{{runtime_dir}}/repo-profile.json` and `INVENTORY.md`:

- **Phase file:** the `ultracode-plan-*-phase-{N}-*.md` matching the implement report's phase number, when a
  plan exists. Pass it in the prompt — the model-router hook reads the Complexity tier from that file.
- **Required skills:** the test skills the INVENTORY **Skill Application Mapping** names for the changed file
  types, plus `convention`.
- **Test commands:** `commands.test` and `commands.testOne` from the profile, verbatim.

## Step 2 — Spawn

Omit the `model` argument — the plugin's model-router hook sets it from this repo's profile.

```
{{agent_selector}}: ultracode:write-test
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Phase file: {phase file path}          # omit this line when there is no plan
Implement report: {implement report path}.
EPA report: {EPA report path}.
Required skills: {test skill names, comma-separated}.
Test command: {commands.test from the profile, verbatim}.
Test-one command: {commands.testOne from the profile, verbatim}.
Write one test per NEW path in the EPA report, following the test skills exactly, and verify them with the
profile's commands. Return the report path, the test files written, and the verification results."
```

## Step 3 — Review

Read the test report and summarize the tests written and their verification results. Then run the test-context
code review — `{{command_prefix}}code-review test` — since tests are a reviewed change like any other. Do not report the phase
done until that review passes.
