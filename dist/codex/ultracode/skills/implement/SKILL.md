---
name: implement
description: >
  Spawn ultracode:implement directly — write code for one plan phase, or for inline instructions on
  a low-stakes task.
---

# Codex Vocabulary

The preserved prompt uses Claude Code tool names. Interpret them as follows:

- `Read` means the Codex `exec_command` capability.
- `Skill` means the Codex `skill discovery` capability.

Load named skills through Codex skill discovery and follow their SKILL.md instructions.

# $implement — code one phase

Spawns the `ultracode:implement` agent directly. It writes code following this repo's convention skill and
verifies each step with the profile's build command.

**Spawn the prefixed name** — `agent_type: ultracode:implement`, verbatim.

Arguments (may be empty): `the user's text following the explicit skill invocation`

## Step 1 — Resolve the phase, session, skills, and model

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SESSION_ROOT="$REPO_ROOT/.codex/ultracode/session"
SESSION_DIR="$SESSION_ROOT/ultracode-session-${CODEX_THREAD_ID:-no-session-id}"
mkdir -p "$SESSION_DIR"
echo "session=$SESSION_DIR"
ls -t "$SESSION_DIR" 2>/dev/null | grep -E '^ultracode-(plan-.*-phase-|implement-).*\.md$'
```

The session dir is **derived** from `CODEX_THREAD_ID`, falling back to `no-session-id` (inherited unchanged), so
it is the same path `$plan` wrote its phase files to earlier in this session — no searching for the newest dir.

The listing is newest-first and relative to `$SESSION_DIR`; prefix a name with `$SESSION_DIR/` to get its path.
No output means no such artifact yet (`grep` exits 1 — that is not an error). Never glob the session dir
directly: an unmatched glob aborts the command under zsh.

Pick the mode from the arguments:

- **A phase file path or a phase number** → that phase file (`ultracode-plan-*-phase-{N}-*.md`).
- **Empty arguments** → the lowest-numbered phase in the newest session dir with no matching
  `ultracode-implement-*-phase-{N}.md` report. If every phase has a report, say so and stop.
- **Inline instructions** (prose describing a low-stakes change) → no phase file; pass the instructions
  verbatim. This mode counts as Complexity tier `low`.
- **No plan and no instructions** → stop and tell the user to run `$plan` first, or to describe the change
  inline.

Collect every earlier phase's `ultracode-implement-*-phase-*.md` as prior phase reports.

Read `$REPO_ROOT/.codex/ultracode/repo-profile.json` and `INVENTORY.md`:

- **Model:** `models.byPhaseComplexity["implement"]["{tier}"]`, where `{tier}` is the chosen phase's
  **Complexity** lowercased (`Low`→`low`), or `low` for inline mode. Profile keys are **bare**. Absent → omit
  the `model` argument.
- **Required skills:** for a phase file, its `## Required Skills` section. For inline mode, derive them from the
  INVENTORY **Skill Application Mapping** for the file types being changed. Always include `convention`.

## Step 2 — Spawn

```
agent_type: ultracode:implement
model: {models.byPhaseComplexity["implement"][tier], or omit}
prompt: "Repo root: {REPO_ROOT}.
Session dir: {SESSION_DIR}.
Phase file: {phase file path}          # omit this line in inline mode
Instructions: {inline instructions}    # inline mode only
Prior phase reports: {comma-separated paths, or 'None'}.
Required skills: {skill names, comma-separated}.
Build command: {commands.build from the profile, verbatim}.
Implement every step in order, verifying each with the build command, and write your change report. Return the
report path, the list of changed files, and your status."
```

## Step 3 — Review, then report

Read the change report. If its status is `Stuck – Escalation Required`, diagnose from the Escalation Request
section (search for a working example, clarify the ambiguous step) and re-spawn with rescue context — or ask the
user if you cannot resolve it. On a `HANDOFF:`, run the requested specialist (e.g. `/prompt-generation`), then
re-spawn `$implement` to continue.

On success, tell the user code review is the next gate — run `$code-review`. The phase is complete once that
review passes.

Then name what is left, without doing any of it:

- **More phases remain** → `$implement` again for the next one. Nothing else runs between phases.
- **This was the last phase** → the code is done. Tests and module docs are **optional closing steps** for after
  every phase, run only if the user wants them: `$epa` then `$write-test` (then `$code-review` for the tests),
  and `$module-docs`. Neither is a next step you take on your own.

The phase file's **Test policy** header says whether the plan considered this phase worth covering *if* tests are
requested — `Skip` means every step is boilerplate with no execution path. Quote it when you mention the test
option, so the user knows what a test run would and would not cover. It is not a decision about whether to run
tests at all; that is theirs.
