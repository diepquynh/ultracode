# Skill Archetypes

The initializer's **generate** mode fills one of these three templates per skill. They mirror the three
skill shapes that work well in practice: a **creation** skill (how to build a recurring component), a
**convention** skill (rules applied to all edits), and a **module-hub** skill (routing tables + references).

Every generated skill must also satisfy the meta-author standards in
`${CLAUDE_PLUGIN_ROOT}/skills/meta-author/SKILL.md` (15 Laws, Chain-of-Thought, self-review).

---

## Archetype A — Creation skill

Use for a recurring component type (entity, DTO, repository, service, controller, route, model,
migration, handler, …). Ground every section in the captured exemplar and invariants.

```markdown
---
name: {component-type}
description: Create or modify a {component type} in {this repo}. Covers {invariants: base class, required annotations, registration, location}.
---

# {Component Type}

Location: `{directory convention observed}`.
Base / interface: `{observed base class or interface, or "none"}`.

## Steps

### 1. Create the {component type}

```{lang}
{distilled template from the exemplar, with {placeholders}}
```

### 2. {Handle the invariant that needs extra steps — e.g. registration, wiring, migration}

{Exact instruction grounded in the exemplar. If a second file must change (registration, DI module,
index, migration), name it and show the exact edit.}

## Checklist

- [ ] {invariant 1 from exemplar}
- [ ] {invariant 2}
- [ ] {required registration / wiring done?}
- [ ] Follows `convention` skill?
```

**Rules:** one instruction per step; every placeholder appears in a Prerequisites list or is obvious from
context; the template must compile/parse after substitution; order steps by dependency (bottom-up).

---

## Archetype B — Convention skill

Exactly one per repo. Distilled from conventions observed **consistently** across exemplars. Every rule
shows a PASS and a FAIL example taken from or faithful to the real code.

```markdown
---
name: convention
description: Standard coding rules for {this repo}. Apply to every create/modify/refactor of source code.
---

# Coding Conventions

Enforce these in all code you write or edit.

## Rules

- **{Rule name}**: {one-sentence rule}.

  **PASS:**
  ```{lang}
  {good example}
  ```
  **FAIL:**
  ```{lang}
  {bad example}
  ```

## Package / Directory Structure

{The observed layout: directory -> purpose. Grounded in the actual tree.}
```

**Rules:** only include a rule if it is observed consistently; do not import rules from the stack reference
that the repo does not actually follow. No "etc." — enumerate.

---

## Archetype C — Module-hub skill

Exactly one per repo. Routing tables from the module/area map, plus per-area reference files when an area
is complex.

```markdown
---
name: module-hub
description: Module/area reference hub for {this repo}. ACTIVATE when working on any area, or when locating which area a path belongs to.
---

# {Repo} Module Reference Hub

## How to use
1. Find the area from the tables below.
2. Read its reference file if one exists: `references/{area}.md`.
3. Follow that area's patterns.

## Routing Table A — Path to Area
| Path glob | Area | Reference |
| --- | --- | --- |

## Routing Table B — Concept to Area
| If the task mentions… | Area(s) |
| --- | --- |

## Area Semantics
| Area | What it contains | Typical patterns |
| --- | --- | --- |
```

Per-area reference file (`references/{area}.md`) — only when an area warrants it:

```markdown
# {Area}
Purpose: {one paragraph, grounded in code}.
Key files: {table of path -> purpose}.
Entry points: {controllers/handlers/schedulers}.
Data flow: {A -> B -> C using real class/function names}.
Integration points: {events published/consumed, queues, external services}.
```

**Rules:** every routing-table entry points at a real path; every reference file is grounded in actual
source (never generated from memory).
