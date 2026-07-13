# Output Contract — INVENTORY.md and repo-profile.json

This file defines the exact structure the initializer's **generate** mode must write, and that the
orchestrator and every subagent read. Both files live in the target repo at `.claude/ultracode/`.

**Design principle — route by inventory, not by description.** Harnesses do not reliably route off
skill front-matter `description` fields. Therefore the single source of truth is `INVENTORY.md`, a plain
markdown file that every agent is instructed to **Read** first. Skill discovery (which requires a session
reload) is a convenience layer on top; the inventory works the instant it is written because it is just a file.

---

## 1. INVENTORY.md

Path: `.claude/ultracode/INVENTORY.md`. Use this exact section order and table shape.

```markdown
# {Repo Name} — ultracode Inventory

Generated: {YYYY-MM-DD} · Stack: {language}/{framework} · Machine profile: `.claude/ultracode/repo-profile.json`

> Route work by the tables below, BY NAME. Do not route by skill descriptions.
> When a file type in a task matches a row in "Skill Application Mapping", load the listed skill(s) via the Skill tool.

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
| `{glob}`                 | {area name} | `.claude/skills/module-hub/references/{x}.md` or `—` |

## Review Rule Set

Seeded from the stack reference. IDs are stable; the code-reviewer and orchestrator use them.

| ID  | Rule                                  | Severity | Auto-fixable |
| --- | ------------------------------------- | -------- | ------------ |
| {X1}| {rule}                                | {H/M/L}  | {yes/no}     |
```

**Rules:**
- Every generated skill appears in **Skills Inventory** AND in at least one **Skill Application Mapping** row.
- `test-one` uses explicit placeholders so the orchestrator can substitute a module and test name.
- The Review Rule Set is copied from the stack reference's rule seeds; keep IDs stable so downstream prompts can reference them.

---

## 2. repo-profile.json

Path: `.claude/ultracode/repo-profile.json`. Machine-readable twin of the inventory. Schema:

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
    { "name": "convention", "kind": "convention", "path": ".claude/skills/convention/SKILL.md", "componentType": null },
    { "name": "entity", "kind": "creation", "path": ".claude/skills/entity/SKILL.md", "componentType": "entity" }
  ],
  "conventions": {
    "immutabilityKeyword": "final",
    "naming": "{ComponentType} suffix classes",
    "notes": ["single timestamp per method"]
  },
  "reviewRules": [
    { "id": "C1", "rule": "…", "severity": "M", "autoFixable": true }
  ]
}
```

**Rules:**
- `commands` values are exact shell strings or `null`. Use the SAME placeholder names (`{MODULE}`, `{TEST}`) as in INVENTORY.
- `skills[]` mirrors the INVENTORY Skills Inventory table 1:1.
- `moduleMap[]` mirrors the INVENTORY Module/Area Map 1:1.
- Consumers (orchestrator, subagents) prefer `repo-profile.json` for exact command strings and `INVENTORY.md` for routing decisions.
