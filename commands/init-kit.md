---
description: Scout this repo for common coding patterns, propose a skill set for approval, then generate per-repo skills + a routing inventory — fanned out with the Claude Code Workflow feature.
argument-hint: "[optional: focus area, module glob, or 're-scan']"
---

# /init-kit — Generate this repo's skill inventory

You are about to bootstrap **ultracode** for the current repository. The `initializer` agent is a leaf
agent: it does one slice/skill of work and returns. **You (the main loop) own the fan-out and the approval
gate**, and you drive the fan-out with the **Workflow tool** (Claude Code's dynamic workflow feature).

This runs as **two workflows with a user-approval gate between them** — a workflow runs headless in the
background and cannot pause for input, so scouting and generation are separate runs and you hold the gate:

```
Workflow A: init-kit-scout      detect + discover existing skills (1) → scout (N, parallel) → propose (1)
                                                                          │
                                            ── YOU present the proposal, wait for approval ──
                                                                          │
Workflow B: init-kit-generate   (re)generate-skill (N, parallel) → generate-inventory (1)
```

**Re-using existing skills.** The repo may already carry skills under `.claude/skills/` (a prior init-kit run
or hand-authored by the team). `detect` discovers them; `propose` marks each `status: existing` and defaults
it to **reuse** (kept on disk, registered in the inventory, never regenerated), and folds any bespoke existing
skill into the routing inventory too. At the approval gate you can override per skill to **regenerate** a stale
one. Only skills you choose to (re)generate are fanned out in Workflow B; reused skills flow straight to
`generate-inventory`. Re-scans are therefore idempotent — your manual edits survive unless you ask to overwrite.

Extra user focus for this run (may be empty): `$ARGUMENTS`

Follow these steps exactly.

## Step 0 — Session directory + repo root

The Workflow scripts have no filesystem access, so create the scratch dir here and pass its path in as an
argument (every initializer agent writes its files there):

```bash
SESSION_ROOT="$PWD/.claude/ultracode/session"                                # repo-local scratch (was /tmp)
mkdir -p "$SESSION_ROOT"
[ -f "$SESSION_ROOT/.gitignore" ] || echo '*' > "$SESSION_ROOT/.gitignore"   # keep scratch out of git
ULTRACODE_SESSION="$SESSION_ROOT/ultracode-$(openssl rand -hex 4)"
mkdir -p "$ULTRACODE_SESSION"
echo "session=$ULTRACODE_SESSION"
echo "repo=$PWD"
```

Keep `$ULTRACODE_SESSION` (session dir) and the repo root (`$PWD`, an absolute path) for the calls below.

## Step 1 — Run the SCOUT workflow (detect → scout fan-out → propose)

Call the **Workflow** tool. Pass the script below **verbatim** as the `script` parameter, and this `args`
object (substitute the real values; pass it as actual JSON, not a string):

```json
{ "sessionDir": "{ULTRACODE_SESSION}", "repoRoot": "{absolute repo root}", "userFocus": "$ARGUMENTS" }
```

Script (`script` parameter):

```js
export const meta = {
  name: 'init-kit-scout',
  description: 'Detect the stack, fan out parallel read-only scouts across repo slices, and propose a per-repo skill set for approval',
  phases: [
    { title: 'Detect', detail: 'identify stack, plan slices, discover existing skills', model: 'sonnet' },
    { title: 'Scout', detail: 'one read-only initializer per repo slice', model: 'sonnet' },
    { title: 'Propose', detail: 'merge findings, rank skills, reconcile with existing skills', model: 'sonnet' },
  ],
}

const SLICE = {
  type: 'object',
  required: ['descriptor', 'paths', 'slug'],
  properties: {
    descriptor: { type: 'string', description: 'Human-readable slice name' },
    paths: { type: 'string', description: 'Path(s) this slice covers, space- or comma-separated' },
    slug: { type: 'string', description: 'Short kebab-case id used in labels and the findings filename' },
  },
}
const DETECT_SCHEMA = {
  type: 'object',
  required: ['scoutPlanPath', 'stack', 'referencePath', 'slices'],
  properties: {
    scoutPlanPath: { type: 'string', description: 'Absolute path to the written scout-plan .md' },
    stack: { type: 'string', description: 'Detected stack: java-spring | typescript-node | python | go | generic' },
    referencePath: { type: 'string', description: 'Absolute path to the chosen stack reference file' },
    slices: { type: 'array', description: 'One entry per parallel scouting slice', items: SLICE },
    existingSkillCount: { type: 'number', description: 'How many existing skills were discovered under the repo .claude/skills/' },
  },
}
const SCOUT_SCHEMA = {
  type: 'object',
  required: ['findingsPath'],
  properties: {
    findingsPath: { type: 'string', description: 'Absolute path to the written scout-findings .md' },
    componentTypesFound: { type: 'number', description: 'How many component types were found in this slice' },
  },
}
const PROPOSE_SCHEMA = {
  type: 'object',
  required: ['proposalPath'],
  properties: {
    proposalPath: { type: 'string', description: 'Absolute path to the written ultracode-proposal.json' },
    recommendedCount: { type: 'number', description: 'How many NEW skills are recommended (status=new, recommend=true)' },
    reuseCount: { type: 'number', description: 'How many existing skills will be reused (status=existing)' },
  },
}

const repoRoot = args.repoRoot
const sessionDir = args.sessionDir
const userFocus = args.userFocus || 'none'

phase('Detect')
const detect = await agent(
  `Mode: detect.
Repo root: ${repoRoot}.
User focus: ${userFocus}
Session dir: ${sessionDir}.
Detect the stack, choose the matching reference from your refs library, and write the scout plan (the list
of slices to scout in parallel + the candidate component types). Also discover every skill already present
under ${repoRoot}/.claude/skills/ and record it in the scout plan's Existing Skills table (name, kind guess,
path, description) so propose can re-use it. Return the scout-plan path, the stack, the chosen reference path,
the structured slice list (descriptor, paths, slug) for the parallel fan-out, and the existing-skill count.`,
  { label: 'detect', agentType: 'ultracode:initializer', model: 'sonnet', schema: DETECT_SCHEMA },
)

log(`Stack: ${detect.stack} · scouting ${detect.slices.length} slice(s) in parallel · ${detect.existingSkillCount || 0} existing skill(s) found`)

phase('Scout')
const scouted = (await parallel(
  detect.slices.map((slice) => () =>
    agent(
      `Mode: scout.
Slice: ${slice.descriptor}.
Slice paths: ${slice.paths}.
Stack reference: ${detect.referencePath}.
Scout plan: ${detect.scoutPlanPath}.
Session dir: ${sessionDir}.
Find every instance of each candidate component type WITHIN your slice's paths only, count them, capture ONE
real exemplar + the invariants + a distilled template per type, and write your scout-findings file
(ultracode-findings-${slice.slug}.md). Return its path.`,
      { label: `scout:${slice.slug}`, phase: 'Scout', agentType: 'ultracode:initializer', model: 'sonnet', schema: SCOUT_SCHEMA },
    )
  )
)).filter(Boolean)

const findingsPaths = scouted.map((s) => s.findingsPath)
log(`Collected findings from ${findingsPaths.length}/${detect.slices.length} scout(s)`)

phase('Propose')
const propose = await agent(
  `Mode: propose.
Scout findings: ${findingsPaths.join(', ')}.
Scout plan: ${detect.scoutPlanPath}.
Session dir: ${sessionDir}.
Merge and dedupe component types across slices, rank by cross-module ubiquity, then reconcile against the
scout plan's Existing Skills table: give each skill a status (new|existing) with its existingPath, default
every existing skill to reuse, and fold every bespoke existing skill into skills[] as a kind:"other" entry.
Write BOTH the human proposal (ultracode-proposal.md) and its machine twin (ultracode-proposal.json). The JSON
must carry: stack, referencePath, scoutPlanPath, findingsPaths, commands, moduleMap, and skills[] (name, kind,
componentType, count, sliceSpread, status, existingPath, recommend, rationale). Return the
ultracode-proposal.json path, the recommended-new count, and the reuse count.`,
  { label: 'propose', agentType: 'ultracode:initializer', model: 'sonnet', schema: PROPOSE_SCHEMA },
)

return {
  proposalJsonPath: propose.proposalPath,
  proposalMdPath: `${sessionDir}/ultracode-proposal.md`,
  scoutPlanPath: detect.scoutPlanPath,
  findingsPaths,
  stack: detect.stack,
}
```

The workflow runs in the background. **Wait for its completion notification before continuing.** The scout
agents are read-only, so the parallel fan-out is safe.

## Step 2 — Present the proposal → user approval gate

Read `{ULTRACODE_SESSION}/ultracode-proposal.json` (its machine twin `ultracode-proposal.md` is the human
version). If the file is missing or `skills[]` is empty, tell the user scouting found no recurring
components and stop.

**Present the proposal to the user** as a compact table — proposed skill name, kind, component type,
occurrence count, slice spread, **status** (`new` or `existing`), and rationale — plus the detected commands
and module map. Call out the existing skills explicitly: a skill with `status: existing` is **re-used as-is by
default** (kept on disk and registered in the inventory, not regenerated), and a bespoke existing skill (kind
`other`) is registered for routing only. Ask the user two things: (1) which `new` skills to generate (default:
every `new` skill with `recommend: true`); (2) whether to **regenerate** any `existing` skill from the current
code (default: none — reuse them all). Only a `creation`, `convention`, or `module-hub` existing skill can be
regenerated; a bespoke `other` skill has no captured exemplar to regenerate from, so it can only be reused or
dropped. **STOP and wait for the user's decision. Do not run the generate workflow yet.**

## Step 3 — Run the GENERATE workflow (skill fan-out → inventory)

After the user approves (or edits) the list, build `approvedSkills` from `ultracode-proposal.json` — every
skill that will appear in the final inventory, each as `{ "name", "kind", "componentType", "disposition", "path" }`:

- `componentType`: the skill's component type, or `null` for the `convention`, `module-hub`, and bespoke (`other`) skills.
- `disposition`: `"generate"` for an approved `new` skill; `"reuse"` for an `existing` skill the user kept (the default); `"regenerate"` for an `existing` skill the user chose to overwrite from current code.
- `path`: the existing `SKILL.md` path (`existingPath` from the proposal JSON) for a `reuse` or `regenerate` skill; `null` for a `generate` skill.

Include EVERY existing skill the user did not drop (default: all of them) so each is registered in the
inventory — the bespoke `other` skills included.

Call the **Workflow** tool again. Pass the script below **verbatim** as `script`, and this `args` object
(read `findingsPaths` from the proposal JSON):

```json
{
  "sessionDir": "{ULTRACODE_SESSION}",
  "repoRoot": "{absolute repo root}",
  "approvedSkills": [ { "name": "…", "kind": "…", "componentType": null, "disposition": "reuse", "path": ".claude/skills/…/SKILL.md" } ],
  "proposalPath": "{ULTRACODE_SESSION}/ultracode-proposal.json",
  "findingsPaths": [ "…" ]
}
```

Script (`script` parameter):

```js
export const meta = {
  name: 'init-kit-generate',
  description: 'Generate the approved new/regenerated per-repo skills in parallel (one agent each), then assemble the routing INVENTORY.md + repo-profile.json over the generated plus reused skills',
  phases: [
    { title: 'Generate skills', detail: 'one initializer per skill to (re)generate, in parallel', model: 'opus' },
    { title: 'Assemble inventory', detail: 'write INVENTORY.md + repo-profile.json + report over generated + reused skills', model: 'sonnet' },
  ],
}

const GEN_SKILL_SCHEMA = {
  type: 'object',
  required: ['name', 'kind', 'path'],
  properties: {
    name: { type: 'string' },
    kind: { type: 'string', description: 'creation | convention | module-hub' },
    componentType: { type: 'string', description: 'component type, or "none"' },
    path: { type: 'string', description: 'Absolute path to the written SKILL.md' },
  },
}
const GEN_INVENTORY_SCHEMA = {
  type: 'object',
  required: ['reportPath', 'filesWritten'],
  properties: {
    reportPath: { type: 'string', description: 'Absolute path to the written generation report' },
    filesWritten: { type: 'array', items: { type: 'string' }, description: 'Every .claude/ file written' },
  },
}

const repoRoot = args.repoRoot
const sessionDir = args.sessionDir
const approvedSkills = args.approvedSkills
const proposalPath = args.proposalPath
const findingsList = (args.findingsPaths || []).join(', ')

// Split the approved set: (re)generate writes a SKILL.md; reuse keeps the existing file and only registers it.
const toGenerate = approvedSkills.filter((s) => s.disposition === 'generate' || s.disposition === 'regenerate')
const reused = approvedSkills.filter((s) => s.disposition === 'reuse')

phase('Generate skills')
const written = (await parallel(
  toGenerate.map((skill) => () =>
    agent(
      `Mode: generate-skill.
Skill name: ${skill.name}.
Skill kind: ${skill.kind}.
Component type: ${skill.componentType || 'none'}.
Disposition: ${skill.disposition}.
Proposal: ${proposalPath}.
Scout findings: ${findingsList}.
Session dir: ${sessionDir}.
Repo root: ${repoRoot}.
Write ONLY your one skill into ${repoRoot}/.claude/skills/${skill.name}/ , grounded in this component type's
captured exemplar + invariants + distilled template from the scout findings. If Disposition is regenerate,
your Write overwrites the existing SKILL.md with the fresh generation. For a module-hub skill, also write any
warranted references/{area}.md files. Self-review against the meta-author checklist. Return your skill's name,
kind, componentType, and the SKILL.md path.`,
      { label: `gen:${skill.name}`, phase: 'Generate skills', agentType: 'ultracode:initializer', model: 'opus', schema: GEN_SKILL_SCHEMA },
    )
  )
)).filter(Boolean)

log(`Generated ${written.length}/${toGenerate.length} skill(s) · reusing ${reused.length} existing skill(s)`)

phase('Assemble inventory')
const report = await agent(
  `Mode: generate-inventory.
Generated skills: ${JSON.stringify(written)}.
Reused skills: ${JSON.stringify(reused)}.
Proposal: ${proposalPath}.
Scout findings: ${findingsList}.
Session dir: ${sessionDir}.
Repo root: ${repoRoot}.
Write ${repoRoot}/.claude/ultracode/INVENTORY.md and ${repoRoot}/.claude/ultracode/repo-profile.json. EVERY
skill in "Generated skills" AND every skill in "Reused skills" MUST appear in both the Skills Inventory table
and the profile skills[] array (mark each profile skills[] entry source: generated or reused). For each reused
skill, read its existing SKILL.md front matter at its path to derive its routing row — do NOT regenerate it.
Seed commands + Review Rule Set from the proposal (read the stack reference at the proposal's referencePath).
Seed the repo-profile.json "models" block with the default model routing from the output contract so the
orchestrator can switch subagent models per repo and per phase: models.byAgent (explore/plan = opus;
code-reviewer/execution-path-analyzer = sonnet; module-documentation/prompt-generation = opus) and models.byPhaseComplexity
(implement and write-test each low = haiku, medium = haiku, high = sonnet).
Self-review for consistency, then write the generation report. Return the report path and the full list of
files written.`,
  { label: 'assemble-inventory', agentType: 'ultracode:initializer', model: 'sonnet', schema: GEN_INVENTORY_SCHEMA },
)

return {
  reportPath: report.reportPath,
  filesWritten: report.filesWritten,
  skillsGenerated: written.length,
  skillsReused: reused.length,
  skillsApproved: approvedSkills.length,
}
```

The skill-generation agents each write only their own `.claude/skills/{name}/` directory (disjoint paths),
so the parallel fan-out needs no worktree isolation; only skills whose disposition is `generate` or
`regenerate` are fanned out, while `reuse` skills are left untouched on disk and passed straight to
`generate-inventory`. The single `generate-inventory` agent runs after them (a barrier) because the inventory
must list every generated AND every reused skill. The `generate-skill` agents run on **Opus**
(`model: 'opus'`) — skill authoring is the highest-value, quality-sensitive step, so it gets the strongest
model; detect / scout / propose / generate-inventory run on **Sonnet**, set explicitly on each `agent()` call
now that the initializer — like every pipeline agent — carries no `model` in its front matter. Those workflow
models are the initializer Workflow's own; separately, `generate-inventory` writes a `models` block into
`repo-profile.json` that routes which model the **orchestrator** later spawns each pipeline subagent with —
`models.byAgent` for the fixed-model stages and `models.byPhaseComplexity` for `implement`/`write-test` by the
plan phase's Complexity tier (default low/medium → haiku, high → sonnet). **Wait for the workflow's completion
notification before continuing.**

## Step 4 — Report + reload

Read the generation report (`{ULTRACODE_SESSION}/ultracode-generate-report.md`). Tell the user:
1. Which files were written (per-skill SKILL.md files, INVENTORY.md, repo-profile.json), which existing skills
   were reused (kept as-is and registered without regeneration), and any approved skill the report lists as
   skipped.
2. That newly generated skills register on the next session — advise running `/reload-plugins` or restarting
   the session so `.claude/skills/*` are discovered. (The INVENTORY.md routing works immediately because
   agents read it as a file.)
3. That subsequent work in this repo will now route through `.claude/ultracode/INVENTORY.md`.
