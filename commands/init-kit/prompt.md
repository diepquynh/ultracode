# {{command_prefix}}init-kit — Generate this repo's skill inventory

You are about to bootstrap **ultracode** for the current repository. The `ultracode:initializer` agent is a leaf
agent: it does one slice/skill of work and returns a file path. **You (the main loop) own the fan-out and the
approval gate** — you spawn `ultracode:initializer` directly with the **{{tool_delegate}} tool**. Where the work is
independent, spawn in parallel: emit multiple {{tool_delegate}} tool calls in a **single message** and they run concurrently.

**Spawn the prefixed name.** Every spawn below passes `{{agent_selector}}: ultracode:initializer` verbatim — the
`ultracode:` prefix is part of the agent's registered name, not decoration. Never spawn a bare `initializer`.

This runs as a five-mode pipeline with a user-approval gate in the middle:

```
detect (1) → scout (N, parallel) → propose (1)
                                      │
                    ── YOU present the proposal, wait for approval ──
                                      │
            (re)generate-skill (N, parallel) → generate-inventory (1)
```

**Cross-harness shortcut.** Ultracode's runtime dir is `{{runtime_dir}}/` at the project root — shared by every
harness — but older versions kept a per-harness one inside `.claude`/`.codex`/`.grok`/`.agent`/`.agents`.
Before it scans anything, `detect` checks whether one of those legacy dirs already holds a COMPLETE bootstrap
for this exact repo while `{{runtime_dir}}/` does not. If it finds one or more, it skips straight past
scout/propose/generate and instead returns a list of candidates for YOU to present to the user (see Step 1).
Adopting a candidate runs a single `adopt` spawn — which migrates it into `{{runtime_dir}}/` — instead of the
scout → propose → generate chain:

```
detect (1, finds candidates) → YOU present candidates, wait for pick → adopt (1)
```

If the user declines every candidate (or none exist), the normal five-mode pipeline above runs.

**Re-using existing skills.** The repo may already carry skills under `{{skills_dir}}/` (a prior init-kit run
or hand-authored by the team). `detect` discovers them; `propose` marks each `status: existing` and defaults
it to **reuse** (kept on disk, registered in the inventory, never regenerated), and folds any bespoke existing
skill into the routing inventory too. At the approval gate you can override per skill to **regenerate** a stale
one. Only skills you choose to (re)generate are fanned out in the generate step; reused skills flow straight to
`generate-inventory`. Re-scans are therefore idempotent — your manual edits survive unless you ask to overwrite.

**Model per mode.** The `ultracode:initializer` defaults to the balanced harness model
(`{{balanced_model}}`), but its modes differ in stakes, so set the `model` argument explicitly on every spawn
below — the per-invocation argument outranks the agent default. Spawn `detect`, `scout`, `propose`, and
`generate-inventory` on the balanced harness model; spawn every `generate-skill` agent on the advanced harness
model (`{{advanced_model}}`) — skill authoring is the highest-value, quality-sensitive step, so it gets the
strongest model. The model router hook leaves these spawns on the model you set: the initializer is
deliberately absent from `models.byAgent`, and the hook keeps an initializer's own model rather than denying it
the way it denies a missing pipeline route — so re-initializing an already-initialized repo works exactly like
a first run.

**Passing data between stages.** Unlike a headless workflow, you (the main loop) can read files, so every
hand-off flows through the session dir: each agent writes its output there and returns the path; you read that
file to drive the next stage. The `propose` stage's machine twin `ultracode-proposal.json` is the structured
source you read to build the approved skill set.

Extra user focus for this run (may be empty): `{{arguments}}`

Follow these steps exactly.

## Step 0 — Session directory + repo root + repo key

Create the scratch dir (every initializer agent writes its files there), and record the repo root and this
repo's key:

```bash
SESSION_ROOT="$PWD/{{runtime_dir}}/session"                                # repo-local scratch (was /tmp)
ULTRACODE_SESSION="$SESSION_ROOT/ultracode-session-{{session_id_expr}}"
mkdir -p "$ULTRACODE_SESSION"
[ -f "$SESSION_ROOT/.gitignore" ] || echo '*' > "$SESSION_ROOT/.gitignore"   # keep scratch out of git
REPO_KEY="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/^-*//; s/-*$//')"
[ -n "$REPO_KEY" ] || REPO_KEY="repo"                                      # a slug is always required
echo "session=$ULTRACODE_SESSION"
echo "repo=$PWD"
echo "repo_key=$REPO_KEY"
```

Keep `$ULTRACODE_SESSION` (session dir), the repo root (`$PWD`, an absolute path) and `$REPO_KEY` for every
spawn below. Every spawn carries `Primary repo root:`, `Repo root:`, `Session dir:`, and `Repo key:` — the hook validates the
initializer mode's full parameter contract before any agent starts, and session state is always written under
this primary repo's `$ULTRACODE_SESSION` even when a future workflow targets another work repo.

**The path is derived, not generated.** The harness supplies {{session_id_names}}, which every agent inherits
unchanged, so the formula yields the same path in every mode below from any working directory. Re-running it is
a no-op, which keeps the five modes writing into and reading from one dir: `detect` writes the scout plan there,
the parallel `scout` agents write their findings beside it, and `propose` reads all of them back. Never
substitute a random suffix (`openssl rand`, `$RANDOM`, a timestamp) — a second dir mid-run would strand the
scout findings where `propose` will not look for them.

## Step 1 — DETECT (1 initializer)

Spawn ONE `ultracode:initializer` agent:

```
{{agent_selector}}: ultracode:initializer
model: {{balanced_model}}
prompt: "Mode: detect.
Primary repo root: {absolute repo root}.
Repo root: {absolute repo root}.
User focus: {{arguments}}
Session dir: {ULTRACODE_SESSION}.
Repo key: {REPO_KEY}.
Before scanning anything, check whether another harness already has a complete bootstrap for this repo
(Step D0) and report any cross-harness candidates instead of scanning. Otherwise, detect the stack, choose the
matching reference from your refs library, and write the scout plan (the list of slices to scout in parallel +
the candidate component types). Also discover every skill already present under {absolute repo
root}/{{skills_dir}}/ and record it in the scout plan's Existing Skills table (name, kind guess, path,
description) so propose can re-use it. Return the scout-plan path, the stack, the chosen reference path, the
structured slice list (descriptor, paths, slug), and the count of existing skills discovered."
```

**If detect returns `CROSS-HARNESS-CANDIDATES: {n}`** (n ≥ 1) instead of a scout plan, it found a legacy
per-harness bootstrap and wrote `{ULTRACODE_SESSION}/ultracode-cross-harness-candidates.json` instead of
scanning. {{tool_read}} that file and handle it before touching Steps 2–4:

- **Present every candidate** to the user: harness, its legacy `runtimeDir`, stack, skill count, and
  `generatedAt`. When `n > 1`, ask the user to pick exactly one (or decline all and run a full scan instead).
  When `n == 1`, still show it and ask the user to confirm adopting it or to run a full scan instead — do not
  adopt silently. **STOP and wait for the user's decision.**
  - **If the user picks a candidate:** spawn ONE `ultracode:initializer` agent:
    ```
    {{agent_selector}}: ultracode:initializer
    model: {{balanced_model}}
    prompt: "Mode: adopt.
    Source harness: {chosen candidate.harness}.
    Source runtime dir: {chosen candidate.runtimeDir}.
    Source skills dir: {chosen candidate.skillsDir}.
    Primary repo root: {absolute repo root}.
Repo root: {absolute repo root}.
    Session dir: {ULTRACODE_SESSION}.
    Repo key: {REPO_KEY}.
    Migrate the source's repo-profile.json, INVENTORY.md, and every skill into {{runtime_dir}} and
    {{skills_dir}}, translating stale paths and resetting the models block to the seeded defaults. Leave the
    legacy source dir on disk. Return the report path, the source harness, the source runtime dir, and the
    list of skill names copied."
    ```
    Then skip Steps 2–4 entirely and go straight to Step 5 — `adopt` writes the same
    `ultracode-generate-report.md` the normal pipeline's Step 5 already reads.
  - **If the user declines every candidate:** re-spawn `Mode: detect` with the same inputs PLUS `Skip
    cross-harness check: yes`, then continue below with the scout plan it returns.

{{tool_read}} the returned scout plan (`{ULTRACODE_SESSION}/ultracode-scout-plan.md`). It carries the detected stack, the
chosen `refs/<stack>.md`, the **Slices** table (each row: descriptor, slug, path(s)) that drives the scout
fan-out, the candidate component types, and the **Existing Skills** table.

## Step 2 — SCOUT (N initializers, IN PARALLEL — read-only)

For EACH slice in the scout plan's Slices table, spawn one `ultracode:initializer` agent — **send them all in a single
message so they run concurrently** (scouts are read-only, so the parallel fan-out is safe):

```
{{agent_selector}}: ultracode:initializer
model: {{balanced_model}}
prompt: "Mode: scout.
Slice: {slice descriptor}.
Slice paths: {slice path(s)}.
Stack reference: {refs/<stack>.md path from detect}.
Scout plan: {scout-plan path}.
Primary repo root: {absolute repo root}.
Repo root: {absolute repo root}.
Session dir: {ULTRACODE_SESSION}.
Repo key: {REPO_KEY}.
Find every instance of each candidate component type WITHIN your slice's paths only, count them, capture ONE
real exemplar + the invariants + a distilled template per type, and write your scout-findings file
(ultracode-findings-{slice-slug}.md). Return its path."
```

Collect every returned scout-findings path.

## Step 3 — PROPOSE (1 initializer) → user approval gate

Spawn ONE `ultracode:initializer` agent:

```
{{agent_selector}}: ultracode:initializer
model: {{balanced_model}}
prompt: "Mode: propose.
Scout findings: {comma-separated list of ALL scout-findings paths}.
Scout plan: {scout-plan path}.
Primary repo root: {absolute repo root}.
Repo root: {absolute repo root}.
Session dir: {ULTRACODE_SESSION}.
Repo key: {REPO_KEY}.
Merge and dedupe component types across slices, rank by cross-module ubiquity, then reconcile against the
scout plan's Existing Skills table: give each skill a status (new|existing) with its existingPath, default
every existing skill to reuse, and fold every bespoke existing skill into skills[] as a kind:other entry.
{{tool_write}} BOTH the human proposal (ultracode-proposal.md) and its machine twin (ultracode-proposal.json). The JSON
must carry: stack, referencePath, scoutPlanPath, findingsPaths, commands, moduleMap, and skills[] (name, kind,
componentType, count, sliceSpread, status, existingPath, recommend, rationale). Return the
ultracode-proposal.json path, the recommended-new count, and the reuse count."
```

{{tool_read}} `{ULTRACODE_SESSION}/ultracode-proposal.json` (its machine twin `ultracode-proposal.md` is the human
version). If the file is missing or `skills[]` is empty, tell the user scouting found no recurring components
and stop.

**Present the proposal to the user** as a compact table — proposed skill name, kind, component type,
occurrence count, slice spread, **status** (`new` or `existing`), and rationale — plus the detected commands
and module map. Call out the existing skills explicitly: a skill with `status: existing` is **re-used as-is by
default** (kept on disk and registered in the inventory, not regenerated), and a bespoke existing skill (kind
`other`) is registered for routing only. Ask the user two things: (1) which `new` skills to generate (default:
every `new` skill with `recommend: true`); (2) whether to **regenerate** any `existing` skill from the current
code (default: none — reuse them all). Only a `creation`, `convention`, or `module-hub` existing skill can be
regenerated; a bespoke `other` skill has no captured exemplar to regenerate from, so it can only be reused or
dropped. **STOP and wait for the user's decision. Do not spawn the generate agents yet.**

## Step 4 — GENERATE (N generate-skill in parallel → 1 generate-inventory)

After the user approves (or edits) the list, build `approvedSkills` from `ultracode-proposal.json` — every
skill that will appear in the final inventory, each as `{ name, kind, componentType, disposition, path }`:

- `componentType`: the skill's component type, or `null` for the `convention`, `module-hub`, and bespoke (`other`) skills.
- `disposition`: `generate` for an approved `new` skill; `reuse` for an `existing` skill the user kept (the default); `regenerate` for an `existing` skill the user chose to overwrite from current code.
- `path`: the existing `SKILL.md` path (`existingPath` from the proposal JSON) for a `reuse` or `regenerate` skill; `null` for a `generate` skill.

Include EVERY existing skill the user did not drop (default: all of them) so each is registered in the
inventory — the bespoke `other` skills included.

### Step 4a — GENERATE-SKILL (one initializer per skill to (re)generate, IN PARALLEL)

For every skill in `approvedSkills` whose `disposition` is `generate` or `regenerate`, spawn one
`ultracode:initializer` agent — **send them all in a single message so they run concurrently.** Each writes only its own
`{{skills_dir}}/{name}/` directory (disjoint paths), so the parallel fan-out needs no worktree isolation. Skip
skills whose `disposition` is `reuse` — they are left untouched on disk and passed straight to Step 4b.

```
{{agent_selector}}: ultracode:initializer
model: {{advanced_model}}
prompt: "Mode: generate-skill.
Skill name: {skill.name}.
Skill kind: {skill.kind}.
Component type: {skill.componentType or 'none'}.
Disposition: {skill.disposition}.
Proposal: {ULTRACODE_SESSION}/ultracode-proposal.json.
Scout findings: {comma-separated list of ALL scout-findings paths}.
Session dir: {ULTRACODE_SESSION}.
Primary repo root: {absolute repo root}.
Repo root: {absolute repo root}.
Repo key: {REPO_KEY}.
{{tool_write}} ONLY your one skill into {absolute repo root}/{{skills_dir}}/{skill.name}/ , grounded in this component
type's captured exemplar + invariants + distilled template from the scout findings. If Disposition is
regenerate, your {{tool_write}} overwrites the existing SKILL.md with the fresh generation. For a module-hub skill, also
write any warranted references/{area}.md files. Self-review against the meta-author checklist. Return your
skill's name, kind, componentType, and the SKILL.md path."
```

Wait for every generate-skill agent to return. Collect their `{name, kind, componentType, path}` into a
**Generated skills** list, and collect every `reuse` skill's `{name, kind, componentType, path}` (from
`approvedSkills`) into a **Reused skills** list.

### Step 4b — GENERATE-INVENTORY (1 initializer, AFTER every generate-skill returns)

Spawn ONE `ultracode:initializer` agent — this is a barrier, because the inventory must list every generated AND every
reused skill:

```
{{agent_selector}}: ultracode:initializer
model: {{balanced_model}}
prompt: "Mode: generate-inventory.
Generated skills: {JSON array of the Generated skills list}.
Reused skills: {JSON array of the Reused skills list}.
Proposal: {ULTRACODE_SESSION}/ultracode-proposal.json.
Scout findings: {comma-separated list of ALL scout-findings paths}.
Session dir: {ULTRACODE_SESSION}.
Primary repo root: {absolute repo root}.
Repo root: {absolute repo root}.
Repo key: {REPO_KEY}.
{{tool_write}} {absolute repo root}/{{runtime_dir}}/INVENTORY.md and {absolute repo root}/{{runtime_dir}}/repo-profile.json.
EVERY skill in Generated skills AND every skill in Reused skills MUST appear in both the Skills Inventory table
and the profile skills[] array (mark each profile skills[] entry source: generated or reused). For each reused
skill, read its existing SKILL.md front matter at its path to derive its routing row — do NOT regenerate it.
Seed commands + Review Rule Set from the proposal (read the stack reference at the proposal's referencePath).
Seed the repo-profile.json models block with the harness-neutral model routing from the output contract so the
model-router hook can switch subagent models per repo and per phase: models.byAgent (explore, generate-spec,
plan and fact-check = advanced; code-reviewer/execution-path-analyzer = balanced; module-documentation/prompt-generation =
advanced) and models.byPhaseComplexity (implement and write-test each low = fast, medium = fast, high =
balanced).
Self-review for consistency, then write the generation report. Return the report path and the full list of
files written."
```

The `models` block this step seeds into `repo-profile.json` is what the **model-router hook** later applies to
every pipeline subagent spawn — `models.byAgent` for the fixed-model stages and `models.byPhaseComplexity` for
`implement`/`write-test` by the plan phase's Complexity tier (default low/medium → fast, high → balanced). The
orchestrator and the explicit commands pass no `model` argument; the hook resolves it, and denies a caller
`model` that does not match the routed slug (Grok keeps the original spawn argument even after `updatedInput`).
That is separate from the
per-mode models you set on the spawns above (which are the initializer's own).

## Step 5 — Report + reload

{{tool_read}} the generation report (`{ULTRACODE_SESSION}/ultracode-generate-report.md`) — the same file
whether it came from `generate-inventory` (normal pipeline) or `adopt` (cross-harness shortcut). Tell the user:
1. Which files were written. For the normal pipeline: per-skill SKILL.md files, INVENTORY.md,
   repo-profile.json, which existing skills were reused (kept as-is and registered without regeneration), and
   any approved skill the report lists as skipped. For the cross-harness shortcut: which harness's legacy
   runtime dir it was migrated from, which skills were copied, and that the legacy dir is still on disk and
   safe to delete by hand.
2. That newly generated skills register on the next session — advise {{reload_action}} so
   `{{skills_dir}}/*` are discovered. (The INVENTORY.md routing works immediately because
   agents read it as a file.)
3. That subsequent work in this repo will now route through `{{runtime_dir}}/INVENTORY.md`.
