---
description: Scout this repo for common coding patterns, propose a skill set for approval, then generate per-repo skills + a routing inventory.
argument-hint: "[optional: focus area, module glob, or 're-scan']"
---

# /init-kit — Generate this repo's skill inventory

You are about to bootstrap **ultracode** for the current repository by running the `initializer` agent in three modes. The initializer is a leaf agent: **you (the main loop) own the parallel fan-out and the approval gate.** Follow these steps exactly.

Extra user focus for this run (may be empty): `$ARGUMENTS`

## Step 0 — Session directory

Create a scratch directory for inter-agent files:

```bash
ULTRACODE_SESSION="/tmp/ultracode-$(openssl rand -hex 4)"
mkdir -p "$ULTRACODE_SESSION"
echo "$ULTRACODE_SESSION"
```

Pass `Session dir: {ULTRACODE_SESSION}` to every initializer invocation below.

## Step 1 — DETECT (1 initializer)

Spawn ONE `initializer` agent:

```
subagent_type: initializer
prompt: "Mode: detect.
Repo root: {absolute path of the current project}.
User focus: $ARGUMENTS
Session dir: {ULTRACODE_SESSION}.
Detect the stack, choose the matching reference from your refs library, and write a scout plan
(the list of slices to scout in parallel + the component types to look for). Return the scout-plan file path."
```

Read the returned scout-plan file. It contains: detected stack, chosen `refs/<stack>.md`, the **slice list** (each slice = a module/package/area or a component-type bucket), and the candidate component types.

## Step 2 — SCOUT (N initializers, IN PARALLEL)

For EACH slice in the scout plan, spawn one `initializer` agent — **send them all in a single message so they run concurrently** (scouts are read-only; parallel is safe):

```
subagent_type: initializer
prompt: "Mode: scout.
Slice: {slice descriptor from the scout plan}.
Stack reference: {refs/<stack>.md path chosen in detect}.
Scout plan: {scout-plan file path}.
Session dir: {ULTRACODE_SESSION}.
Find every instance of each candidate component type in your slice, rank by ubiquity across the repo,
capture ONE real exemplar + the invariants for each, and write a scout-findings file. Return its path."
```

Collect all scout-findings file paths.

## Step 3 — PROPOSE (1 initializer) → user approval gate

Spawn ONE `initializer` agent:

```
subagent_type: initializer
prompt: "Mode: propose.
Scout findings: {comma-separated list of ALL scout-findings file paths}.
Scout plan: {scout-plan file path}.
Session dir: {ULTRACODE_SESSION}.
Merge and dedupe findings across slices, rank component types by cross-module frequency, and write a
PROPOSAL file listing every skill it recommends generating (name, component type, frequency, one-line rationale),
plus the detected build/test/format/lint commands and the proposed module map. Return the proposal file path."
```

Read the proposal file. **Present it to the user** as a compact table: proposed skill name, component type, occurrence count, rationale — plus the detected commands and module map. Ask the user which skills to generate (default: all). **STOP and wait for the user's decision. Do not generate anything yet.**

## Step 4 — GENERATE (1 initializer)

After the user approves (or edits) the list, spawn ONE `initializer` agent:

```
subagent_type: initializer
prompt: "Mode: generate.
Approved skills: {the exact list the user approved}.
Proposal: {proposal file path}.
Scout findings: {comma-separated list of ALL scout-findings file paths}.
Session dir: {ULTRACODE_SESSION}.
Write, into the TARGET REPO: .claude/ultracode/INVENTORY.md, .claude/ultracode/repo-profile.json,
and one .claude/skills/<name>/SKILL.md per approved skill (plus a module-hub skill + a convention skill).
Ground every skill in the captured exemplars. Return the generation report path and the list of files written."
```

## Step 5 — Report + reload

Read the generation report. Tell the user:
1. Which files were written (inventory, profile, skills).
2. That newly generated skills register on the next session — advise running `/reload-plugins` or restarting the session so `.claude/skills/*` are discovered. (The INVENTORY.md routing works immediately because agents read it as a file.)
3. That subsequent work in this repo will now route through `.claude/ultracode/INVENTORY.md`.
