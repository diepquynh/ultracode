# Output Contract — INVENTORY.md and repo-profile.json

This file defines the exact structure the initializer's **generate** mode must write, and that the
orchestrator and every subagent read. Both files live in the target repo at `{{runtime_dir}}/`.

**Design principle — route by inventory, not by description.** Harnesses do not reliably route off
skill front-matter `description` fields. Therefore the single source of truth is `INVENTORY.md`, a plain
markdown file that every agent is instructed to **Read** first. Skill discovery (which requires a session
reload) is a convenience layer on top; the inventory works the instant it is written because it is just a file.

---

## 1. INVENTORY.md

Path: `{{runtime_dir}}/INVENTORY.md`. Use this exact section order and table shape.

```markdown
# {Repo Name} — ultracode Inventory

Generated: {YYYY-MM-DD} · Stack: {language}/{framework} · Machine profile: `{{runtime_dir}}/repo-profile.json`

> Route work by the tables below, BY NAME. Do not route by skill descriptions.
> When a file type in a task matches a row in "Skill Application Mapping", load the listed skill(s) via {{tool_skill}}.

## Commands

| Purpose   | Command            |
| --------- | ------------------ |
| build     | {exact string}     |
| test      | {exact string}     |
| test-one  | {exact string with {MODULE}/{TEST} placeholders} |
| format    | {exact string}     |
| lint      | {exact string}     |
| typecheck | {exact string or —}|
| run       | {exact string or —}|

## Skills Inventory

| Skill                | Kind        | Load when (component / file type)          |
| -------------------- | ----------- | ------------------------------------------- |
| `convention`         | convention  | Always. Auto-load for any code edit.        |
| `module-hub`         | module-hub  | Locating which area/module a path belongs to.|
| `{component-skill}`  | creation    | Creating or modifying a {component type}.   |

## Skill Application Mapping

| File type being changed | Skills to load          |
| ----------------------- | ----------------------- |
| {component type}        | `{skill}`, `convention` |

## Module / Area Map

| Path glob                | Area        | Reference                                   |
| ------------------------ | ----------- | ------------------------------------------- |
| `{glob}`                 | {area name} | `{{skills_dir}}/module-hub/references/{x}.md` or `—` |

## Review Rule Set

Seeded from the stack reference. IDs are stable; the code-reviewer and orchestrator use them.

| ID  | Rule                                  | Severity | Auto-fixable |
| --- | ------------------------------------- | -------- | ------------ |
| {X1}| {rule}                                | {H/M/L}  | {yes/no}     |
```

**Rules:**
- Every skill in the repo's skill set — generated this run OR reused from a prior run / hand-authored — appears in **Skills Inventory**. A creation or test skill also appears in at least one **Skill Application Mapping** row; a bespoke reused skill with no file-type trigger appears in Skills Inventory only, with its trigger in the `Load when` column.
- `test-one` uses explicit placeholders so the orchestrator can substitute a module and test name.
- The Review Rule Set is copied from the stack reference's rule seeds; keep IDs stable so downstream prompts can reference them.

---

## 2. repo-profile.json

Path: `{{runtime_dir}}/repo-profile.json`. Machine-readable twin of the inventory. Schema:

```json
{
  "schemaVersion": 1,
  "generatedAt": "{YYYY-MM-DD}",
  "stack": {
    "language": "java",
    "frameworks": ["spring-boot"],
    "buildTool": "maven-wrapper"
  },
  "commands": {
    "build": "./mvnw -q -T1C compile",
    "test": "./mvnw test",
    "testOne": "./mvnw test -pl {MODULE} -am -Dtest={TEST} -Dsurefire.failIfNoSpecifiedTests=false",
    "format": "./mvnw spotless:apply",
    "lint": null,
    "typecheck": null,
    "run": null
  },
  "testFramework": "junit5+mockito",
  "moduleMap": [
    { "glob": "src/**", "area": "app", "reference": null }
  ],
  "skills": [
    { "name": "convention", "kind": "convention", "path": "{{skills_dir}}/convention/SKILL.md", "componentType": null, "source": "generated" },
    { "name": "entity", "kind": "creation", "path": "{{skills_dir}}/entity/SKILL.md", "componentType": "entity", "source": "generated" },
    { "name": "deploy", "kind": "other", "path": "{{skills_dir}}/deploy/SKILL.md", "componentType": null, "source": "reused" }
  ],
  "conventions": {
    "immutabilityKeyword": "final",
    "naming": "{ComponentType} suffix classes",
    "notes": ["single timestamp per method"]
  },
  "reviewRules": [
    { "id": "C1", "rule": "…", "severity": "M", "autoFixable": true }
  ],
  "models": {
    "byAgent": {
      "explore": "advanced",
      "generate-spec": "advanced",
      "plan": "advanced",
      "fact-check": "advanced",
      "code-reviewer": "balanced",
      "execution-path-analyzer": "balanced",
      "module-documentation": "advanced",
      "prompt-generation": "advanced"
    },
    "byPhaseComplexity": {
      "implement":  { "low": "fast", "medium": "fast", "high": "balanced" },
      "write-test": { "low": "fast", "medium": "fast", "high": "balanced" }
    }
  }
}
```

**Rules:**
- `commands` values are exact shell strings or `null`. Use the SAME placeholder names (`{MODULE}`, `{TEST}`) as in INVENTORY.
- `skills[]` mirrors the INVENTORY Skills Inventory table 1:1.
- Each `skills[]` entry carries `source`: `"generated"` (written this run) or `"reused"` (an existing skill kept as-is and only registered). A reused skill's `kind` may be `"other"` when it maps to no scouted component type.
- `moduleMap[]` mirrors the INVENTORY Module/Area Map 1:1.
- `models` routes which model each subagent spawn runs on. The model-router hook owns that decision end to end — the orchestrator and the explicit commands pass no `model` argument at all. Normal values are the harness-neutral tiers `fast`, `balanced`, and `advanced`; the generated hook resolves them through `definitions/model-mapping.json` for Claude Code or Codex. A concrete model name is also accepted, and an object such as `{ "claude": "custom-claude-model", "codex": "custom-codex-model" }` selects an explicit per-harness target without alias translation. Once a profile exists, every applicable route must be explicit: use `"default"` to select the agent definition's neutral default, or `"inherit"` to leave the spawn model untouched. Missing or malformed routes are denied by the model-router hook instead of silently falling back. When the whole profile is absent, generated agent defaults keep initialization possible. The hook (`hooks/model-router.py`) re-reads the file on every spawn, so editing it retunes the next spawn without restarting.
  - `models.byAgent` — the **static** tier per fixed-model pipeline agent, keyed by agent name (no `ultracode:` prefix). Defaults: `explore`, `generate-spec`, `plan`, `fact-check` = `advanced`; `code-reviewer`, `execution-path-analyzer` = `balanced`; `module-documentation`, `prompt-generation` = `advanced`.
  - `models.byPhaseComplexity` — the **dynamic** tier for `implement` and `write-test`. Each carries its own `{ low, medium, high }` map keyed by the plan phase's complexity/stake tier; an inline no-plan task counts as `low`. Defaults: `low` = `fast`, `medium` = `fast`, `high` = `balanced` for each.
  - **Keys stay bare; spawns stay prefixed.** Every key in both maps is the agent's unprefixed name. The hook strips the `ultracode:` prefix from the spawn's agent name and looks the route up by that bare key (e.g. `subagent_type: ultracode:explore` → key `explore`). Never write an `ultracode:`-prefixed key into this file — it would not match on lookup.
  - The `initializer` is absent by design — the `/init-kit` command (not the orchestrator) spawns it, as `ultracode:initializer`, and sets its model per mode. It is one of two agents the hook does not deny for a missing route: an initializer spawn keeps the model `/init-kit` chose, so re-initializing a repo that already has this profile behaves like a first run. Add an `initializer` route only to override that per-mode choice with a single tier.
  - `fact-check` is exempted the same way, so an existing profile written before this agent existed does not start hard-failing every spec/plan approval — `ultracode:fact-check` gates approval regardless of routing (`ultracode_gate` refuses `decision: "approved"` without a recorded `PASS`), so a missing route only affects which model runs it, never whether it runs. Add a `fact-check` route to pick a specific tier.
- Consumers (orchestrator, subagents) prefer `repo-profile.json` for exact command strings and `INVENTORY.md` for routing decisions.
