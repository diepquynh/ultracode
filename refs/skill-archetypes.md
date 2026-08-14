# Skill Archetypes

The initializer's **generate** mode fills one of these four templates per skill. They mirror the four
skill shapes that work well in practice: a **creation** skill (how to build a recurring component), a
**convention** skill (rules applied to all edits), a **module-hub** skill (routing tables + references), and
a **test** skill (how to write a test for a recurring component type).

Creation and test skills are proposed from the stack reference's two catalogs — the **Component catalog**
(source components) and the **Test component catalog** (test types) — one skill per type that recurs.

Every generated skill must also satisfy the meta-author standards in
`{{plugin_root}}/skills/meta-author/SKILL.md` (15 Laws, Chain-of-Thought, self-review).

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

---

## Archetype D — Test skill

Use for a recurring **test** type: a unit test for a service, repository, controller/route handler, or UI
component, or an integration/slice test. Proposed from the stack reference's **Test component catalog** — one
skill per test type that recurs. Ground every section in a captured **test** exemplar (a real
`*Test`/`*_test`/`*.spec` file). When the repo has **no tests yet**, ground in the stack reference's test
convention and mark the skill `convention-seeded` — it establishes the pattern that fills the T1 gap ("new
public function without a test"), not an existing convention to mirror.

```markdown
---
name: unit-test-{component-type}
description: Write a {framework} test for a {component type} in {this repo}. Covers {test doubles, fixture/slice setup, one-path-per-test, assertion + interaction verification}. Apply the shared test-convention skill first.
---

# {Component Type} Test

Location: `{observed test-file convention}` — e.g. co-located `foo_test.go`, mirrored `tests/<domain>/test_<module>.py`, `src/test/java/.../{X}Test.java`, or co-located `*.spec.ts`.
Framework: `{runner + assertion lib + test-double lib, from the stack reference}`.
Fixture / base: `{observed base test class, fixture, or slice annotation, or "none"}`.

## Steps

### 1. Set up the system under test with its collaborators doubled

{Grounded instruction: construct the SUT and replace each collaborator with the stack's test double —
Mockito `@Mock`/`@InjectMocks`, `unittest.mock.AsyncMock`, a hand-written Go fake struct, a Jasmine spy.
Name the fixture/slice annotation or app-under-test wiring if one is required (`@DataJpaTest`,
`@SpringBootTest`+`MockMvc`, `TestClient`, `TestBed`).}

```{lang}
{distilled setup template from the exemplar, with {placeholders}}
```

### 2. Write one test per execution path

One test function per path through the unit: the happy path, each branch, each early return, each
error/exception path, and empty/null/boundary inputs (this is what review rule T8 checks). Name each test
for the behavior it pins (`should{Behavior}` / `test_should_{behavior}` / `Should {behavior}`), one behavior
per test.

```{lang}
{distilled single-test template from the exemplar}
```

### 3. Assert the result AND verify interactions

Assert the return value / response body / rendered state, then verify collaborators were (or were NOT)
called as expected (`verify(...)`/`verifyNoInteractions`, `assert_awaited_once`/`assert_not_awaited`, spy
`toHaveBeenCalledWith`). Do not assert framework-guaranteed behavior (inherited CRUD, the framework's own
request validation) — test the unit's own logic.

## Checklist

- [ ] Test file in the observed location, named per convention.
- [ ] Every collaborator replaced with the stack's test double; no real network/DB/queue in a unit test.
- [ ] One test per execution path (happy, branches, errors, boundaries) — covers T8.
- [ ] Each test asserts results and verifies interactions.
- [ ] No test of framework-guaranteed behavior.
- [ ] Applies the shared test-convention skill.
```

**Rules:** ground every template line in a real test exemplar; when the repo has no tests, ground in the
stack reference's test convention and mark the skill `convention-seeded`. One execution path per test. Never
assert framework internals.
