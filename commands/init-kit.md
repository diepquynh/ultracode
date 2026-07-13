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
Workflow A: init-kit-scout      detect (1) → scout (N, parallel) → propose (1)
                                                                          │
                                            ── YOU present the proposal, wait for approval ──
                                                                          │
Workflow B: init-kit-generate   generate-skill (N, parallel) → generate-inventory (1)
```

Extra user focus for this run (may be empty): `$ARGUMENTS`

Follow these steps exactly.

## Step 0 — Session directory + repo root

The Workflow scripts have no filesystem access, so create the scratch dir here and pass its path in as an
argument (every initializer agent writes its files there):

```bash
ULTRACODE_SESSION="/tmp/ultracode-$(openssl rand -hex 4)"
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
    { title: 'Detect', detail: 'identify stack + plan the parallel slices' },
    { title: 'Scout', detail: 'one read-only initializer per repo slice' },
    { title: 'Propose', detail: 'merge findings, rank skills, write the proposal' },
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
    recommendedCount: { type: 'number', description: 'How many skills are recommended (recommend=true)' },
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
of slices to scout in parallel + the candidate component types). Return the scout-plan path, the stack, the
chosen reference path, and the structured slice list (descriptor, paths, slug) for the parallel fan-out.`,
  { label: 'detect', agentType: 'ultracode:initializer', schema: DETECT_SCHEMA },
)

log(`Stack: ${detect.stack} · scouting ${detect.slices.length} slice(s) in parallel`)

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
      { label: `scout:${slice.slug}`, phase: 'Scout', agentType: 'ultracode:initializer', schema: SCOUT_SCHEMA },
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
Merge and dedupe component types across slices, rank by cross-module ubiquity, and write BOTH the human
proposal (ultracode-proposal.md) and its machine twin (ultracode-proposal.json). The JSON must carry: stack,
referencePath, scoutPlanPath, findingsPaths, commands, moduleMap, and skills[] (name, kind, componentType,
count, sliceSpread, recommend, rationale). Return the ultracode-proposal.json path.`,
  { label: 'propose', agentType: 'ultracode:initializer', schema: PROPOSE_SCHEMA },
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
occurrence count, slice spread, rationale — plus the detected commands and module map. Ask which skills to
generate (default: every skill with `recommend: true`). **STOP and wait for the user's decision. Do not run
the generate workflow yet.**

## Step 3 — Run the GENERATE workflow (skill fan-out → inventory)

After the user approves (or edits) the list, build `approvedSkills` from `ultracode-proposal.json`: the
subset the user approved, each as `{ "name", "kind", "componentType" }` (use `null` componentType for the
`convention` and `module-hub` skills).

Call the **Workflow** tool again. Pass the script below **verbatim** as `script`, and this `args` object
(read `findingsPaths` from the proposal JSON):

```json
{
  "sessionDir": "{ULTRACODE_SESSION}",
  "repoRoot": "{absolute repo root}",
  "approvedSkills": [ { "name": "…", "kind": "…", "componentType": null } ],
  "proposalPath": "{ULTRACODE_SESSION}/ultracode-proposal.json",
  "findingsPaths": [ "…" ]
}
```

Script (`script` parameter):

```js
export const meta = {
  name: 'init-kit-generate',
  description: 'Generate the approved per-repo skills in parallel (one agent each), then assemble the routing INVENTORY.md + repo-profile.json',
  phases: [
    { title: 'Generate skills', detail: 'one initializer per approved skill, in parallel' },
    { title: 'Assemble inventory', detail: 'write INVENTORY.md + repo-profile.json + report' },
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

phase('Generate skills')
const written = (await parallel(
  approvedSkills.map((skill) => () =>
    agent(
      `Mode: generate-skill.
Skill name: ${skill.name}.
Skill kind: ${skill.kind}.
Component type: ${skill.componentType || 'none'}.
Proposal: ${proposalPath}.
Scout findings: ${findingsList}.
Session dir: ${sessionDir}.
Repo root: ${repoRoot}.
Write ONLY your one skill into ${repoRoot}/.claude/skills/${skill.name}/ , grounded in this component type's
captured exemplar + invariants + distilled template from the scout findings. For a module-hub skill, also
write any warranted references/{area}.md files. Self-review against the meta-author checklist. Return your
skill's name, kind, componentType, and the SKILL.md path.`,
      { label: `gen:${skill.name}`, phase: 'Generate skills', agentType: 'ultracode:initializer', schema: GEN_SKILL_SCHEMA },
    )
  )
)).filter(Boolean)

log(`Generated ${written.length}/${approvedSkills.length} skill(s)`)

phase('Assemble inventory')
const report = await agent(
  `Mode: generate-inventory.
Generated skills: ${JSON.stringify(written)}.
Proposal: ${proposalPath}.
Scout findings: ${findingsList}.
Session dir: ${sessionDir}.
Repo root: ${repoRoot}.
Write ${repoRoot}/.claude/ultracode/INVENTORY.md and ${repoRoot}/.claude/ultracode/repo-profile.json. EVERY
skill in "Generated skills" MUST appear in both the Skills Inventory table and the profile skills[] array.
Seed commands + Review Rule Set from the proposal (read the stack reference at the proposal's referencePath).
Self-review for consistency, then write the generation report. Return the report path and the full list of
files written.`,
  { label: 'assemble-inventory', agentType: 'ultracode:initializer', schema: GEN_INVENTORY_SCHEMA },
)

return {
  reportPath: report.reportPath,
  filesWritten: report.filesWritten,
  skillsGenerated: written.length,
  skillsApproved: approvedSkills.length,
}
```

The skill-generation agents each write only their own `.claude/skills/{name}/` directory (disjoint paths),
so the parallel fan-out needs no worktree isolation; the single `generate-inventory` agent runs after them
(a barrier) because the inventory must list every skill that was actually written. **Wait for the workflow's
completion notification before continuing.**

## Step 4 — Report + reload

Read the generation report (`{ULTRACODE_SESSION}/ultracode-generate-report.md`). Tell the user:
1. Which files were written (per-skill SKILL.md files, INVENTORY.md, repo-profile.json), and any approved
   skill the report lists as skipped.
2. That newly generated skills register on the next session — advise running `/reload-plugins` or restarting
   the session so `.claude/skills/*` are discovered. (The INVENTORY.md routing works immediately because
   agents read it as a file.)
3. That subsequent work in this repo will now route through `.claude/ultracode/INVENTORY.md`.
