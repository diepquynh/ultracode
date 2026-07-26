---
description: Scout this repo for common coding patterns, propose a skill set for approval, then generate per-repo skills + a routing inventory — fanned out with parallel subagent spawns.
argument-hint: "[optional: focus area, module glob, or 're-scan']"
---

# /init-kit — Generate this repo's skill inventory

You are about to bootstrap **ultracode** for the current repository. The `ultracode:initializer` agent is a leaf
agent: it does one slice/skill of work and returns a file path. **You (the main loop) own the fan-out and the
approval gate** — you spawn `ultracode:initializer` directly with the **Agent tool**. Where the work is
independent, spawn in parallel: emit multiple Agent tool calls in a **single message** and they run concurrently.

**Spawn the prefixed name.** Every spawn below passes `subagent_type: ultracode:initializer` verbatim — the
`ultracode:` prefix is part of the agent's registered name, not decoration. Never spawn a bare `initializer`.

This runs as a five-mode pipeline with a user-approval gate in the middle:

```
detect (1) → scout (N, parallel) → propose (1)
                                      │
                    ── YOU present the proposal, wait for approval ──
                                      │
            (re)generate-skill (N, parallel) → generate-inventory (1)
```

**Re-using existing skills.** The repo may already carry skills under `.claude/skills/` (a prior init-kit run
or hand-authored by the team). `detect` discovers them; `propose` marks each `status: existing` and defaults
it to **reuse** (kept on disk, registered in the inventory, never regenerated), and folds any bespoke existing
skill into the routing inventory too. At the approval gate you can override per skill to **regenerate** a stale
one. Only skills you choose to (re)generate are fanned out in the generate step; reused skills flow straight to
`generate-inventory`. Re-scans are therefore idempotent — your manual edits survive unless you ask to overwrite.

**Model per mode.** The `ultracode:initializer` carries no `model` in its front matter, so set the `model` argument on
every spawn below. Spawn `detect`, `scout`, `propose`, and `generate-inventory` on **Sonnet**; spawn every
`generate-skill` agent on **Opus** — skill authoring is the highest-value, quality-sensitive step, so it gets
the strongest model.

**Passing data between stages.** Unlike a headless workflow, you (the main loop) can read files, so every
hand-off flows through the session dir: each agent writes its output there and returns the path; you read that
file to drive the next stage. The `propose` stage's machine twin `ultracode-proposal.json` is the structured
source you read to build the approved skill set.

Extra user focus for this run (may be empty): `$ARGUMENTS`

Follow these steps exactly.

## Step 0 — Session directory + repo root

Create the scratch dir (every initializer agent writes its files there) and record the repo root:

```bash
SESSION_ROOT="$PWD/.claude/ultracode/session"                                # repo-local scratch (was /tmp)
mkdir -p "$SESSION_ROOT"
[ -f "$SESSION_ROOT/.gitignore" ] || echo '*' > "$SESSION_ROOT/.gitignore"   # keep scratch out of git
ULTRACODE_SESSION="$SESSION_ROOT/ultracode-$(openssl rand -hex 4)"
mkdir -p "$ULTRACODE_SESSION"
echo "session=$ULTRACODE_SESSION"
echo "repo=$PWD"
```

Keep `$ULTRACODE_SESSION` (session dir) and the repo root (`$PWD`, an absolute path) for every spawn below.

## Step 1 — DETECT (1 initializer)

Spawn ONE `ultracode:initializer` agent:

```
subagent_type: ultracode:initializer
model: sonnet
prompt: "Mode: detect.
Repo root: {absolute repo root}.
User focus: $ARGUMENTS
Session dir: {ULTRACODE_SESSION}.
Detect the stack, choose the matching reference from your refs library, and write the scout plan (the list
of slices to scout in parallel + the candidate component types). Also discover every skill already present
under {absolute repo root}/.claude/skills/ and record it in the scout plan's Existing Skills table (name, kind
guess, path, description) so propose can re-use it. Return the scout-plan path, the stack, the chosen reference
path, the structured slice list (descriptor, paths, slug), and the count of existing skills discovered."
```

Read the returned scout plan (`{ULTRACODE_SESSION}/ultracode-scout-plan.md`). It carries the detected stack, the
chosen `refs/<stack>.md`, the **Slices** table (each row: descriptor, slug, path(s)) that drives the scout
fan-out, the candidate component types, and the **Existing Skills** table.

## Step 2 — SCOUT (N initializers, IN PARALLEL — read-only)

For EACH slice in the scout plan's Slices table, spawn one `ultracode:initializer` agent — **send them all in a single
message so they run concurrently** (scouts are read-only, so the parallel fan-out is safe):

```
subagent_type: ultracode:initializer
model: sonnet
prompt: "Mode: scout.
Slice: {slice descriptor}.
Slice paths: {slice path(s)}.
Stack reference: {refs/<stack>.md path from detect}.
Scout plan: {scout-plan path}.
Session dir: {ULTRACODE_SESSION}.
Find every instance of each candidate component type WITHIN your slice's paths only, count them, capture ONE
real exemplar + the invariants + a distilled template per type, and write your scout-findings file
(ultracode-findings-{slice-slug}.md). Return its path."
```

Collect every returned scout-findings path.

## Step 3 — PROPOSE (1 initializer) → user approval gate

Spawn ONE `ultracode:initializer` agent:

```
subagent_type: ultracode:initializer
model: sonnet
prompt: "Mode: propose.
Scout findings: {comma-separated list of ALL scout-findings paths}.
Scout plan: {scout-plan path}.
Session dir: {ULTRACODE_SESSION}.
Merge and dedupe component types across slices, rank by cross-module ubiquity, then reconcile against the
scout plan's Existing Skills table: give each skill a status (new|existing) with its existingPath, default
every existing skill to reuse, and fold every bespoke existing skill into skills[] as a kind:other entry.
Write BOTH the human proposal (ultracode-proposal.md) and its machine twin (ultracode-proposal.json). The JSON
must carry: stack, referencePath, scoutPlanPath, findingsPaths, commands, moduleMap, and skills[] (name, kind,
componentType, count, sliceSpread, status, existingPath, recommend, rationale). Return the
ultracode-proposal.json path, the recommended-new count, and the reuse count."
```

Read `{ULTRACODE_SESSION}/ultracode-proposal.json` (its machine twin `ultracode-proposal.md` is the human
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
`.claude/skills/{name}/` directory (disjoint paths), so the parallel fan-out needs no worktree isolation. Skip
skills whose `disposition` is `reuse` — they are left untouched on disk and passed straight to Step 4b.

```
subagent_type: ultracode:initializer
model: opus
prompt: "Mode: generate-skill.
Skill name: {skill.name}.
Skill kind: {skill.kind}.
Component type: {skill.componentType or 'none'}.
Disposition: {skill.disposition}.
Proposal: {ULTRACODE_SESSION}/ultracode-proposal.json.
Scout findings: {comma-separated list of ALL scout-findings paths}.
Session dir: {ULTRACODE_SESSION}.
Repo root: {absolute repo root}.
Write ONLY your one skill into {absolute repo root}/.claude/skills/{skill.name}/ , grounded in this component
type's captured exemplar + invariants + distilled template from the scout findings. If Disposition is
regenerate, your Write overwrites the existing SKILL.md with the fresh generation. For a module-hub skill, also
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
subagent_type: ultracode:initializer
model: sonnet
prompt: "Mode: generate-inventory.
Generated skills: {JSON array of the Generated skills list}.
Reused skills: {JSON array of the Reused skills list}.
Proposal: {ULTRACODE_SESSION}/ultracode-proposal.json.
Scout findings: {comma-separated list of ALL scout-findings paths}.
Session dir: {ULTRACODE_SESSION}.
Repo root: {absolute repo root}.
Write {absolute repo root}/.claude/ultracode/INVENTORY.md and {absolute repo root}/.claude/ultracode/repo-profile.json.
EVERY skill in Generated skills AND every skill in Reused skills MUST appear in both the Skills Inventory table
and the profile skills[] array (mark each profile skills[] entry source: generated or reused). For each reused
skill, read its existing SKILL.md front matter at its path to derive its routing row — do NOT regenerate it.
Seed commands + Review Rule Set from the proposal (read the stack reference at the proposal's referencePath).
Seed the repo-profile.json models block with the default model routing from the output contract so the
orchestrator can switch subagent models per repo and per phase: models.byAgent (explore/plan = opus;
code-reviewer/execution-path-analyzer = sonnet; module-documentation/prompt-generation = opus) and
models.byPhaseComplexity (implement and write-test each low = haiku, medium = haiku, high = sonnet).
Self-review for consistency, then write the generation report. Return the report path and the full list of
files written."
```

The `models` block this step seeds into `repo-profile.json` routes which model the **orchestrator** later
spawns each pipeline subagent with — `models.byAgent` for the fixed-model stages and `models.byPhaseComplexity`
for `implement`/`write-test` by the plan phase's Complexity tier (default low/medium → haiku, high → sonnet).
That is separate from the per-mode models you set on the spawns above (which are the initializer's own).

## Step 5 — Report + reload

Read the generation report (`{ULTRACODE_SESSION}/ultracode-generate-report.md`). Tell the user:
1. Which files were written (per-skill SKILL.md files, INVENTORY.md, repo-profile.json), which existing skills
   were reused (kept as-is and registered without regeneration), and any approved skill the report lists as
   skipped.
2. That newly generated skills register on the next session — advise running `/reload-plugins` or restarting
   the session so `.claude/skills/*` are discovered. (The INVENTORY.md routing works immediately because
   agents read it as a file.)
3. That subsequent work in this repo will now route through `.claude/ultracode/INVENTORY.md`.
