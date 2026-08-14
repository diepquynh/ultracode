# Meta-Author

**Goal:** Write instruction files that a model reads top-to-bottom, once, and executes without ambiguity.

The initializer loads this skill when generating per-repo skills; a prompt-generation agent loads it when
writing prompts or agents. Templates for the three skill shapes live in
`{{plugin_root}}/refs/skill-archetypes.md`.

---

## The 15 Writing Laws

Apply every law to every sentence of instruction text.

1. **Define before reference.** Never use a term before its definition. Put a Definitions table first.
2. **One instruction per sentence.** Split compound instructions.
3. **Explicit ALL / ANY.** Write "ALL of" or "ANY of"; never leave quantifiers implied.
4. **Concrete over abstract.** "Add `final` to the field" — not "follow the standard pattern."
5. **Show both sides.** Every rule shows a PASS and a FAIL example.
6. **Explicit stop / continue.** Every decision point states both branches ("If X … If not X …").
7. **Exact error codes / strings.** Return exact literals, never paraphrases.
8. **No synonyms.** One word per concept, used everywhere. Pick "entity" and never also say "record/model".
9. **Anchor cross-references.** Reference stable section names/anchors, not "above/below".
10. **Exhaustive enumerations.** List every case. Never "etc." or "and so on".
11. **Fallback for every rule.** Every matching rule has an else-branch.
12. **Priority on conflict.** When rules can conflict, state which wins.
13. **Constrain output formats.** Every output field has a type, allowed values, and conditions.
14. **Self-check instruction.** End with a checklist the model re-runs against its own output.
15. **Grounding over generation.** Prefer instructions grounded in real files/exemplars over invented ones.

## Chain-of-Thought structure

- The reader accumulates context top-to-bottom. No forward references ("as in Step 5 below").
- Order steps by dependency (bottom-up for construction: build prerequisites first).
- One logical operation per step. Each step ends with a **Pass condition** and, where it can fail, a **Fail condition** with the exact output to emit.

---

## Writing a SKILL.md

- YAML front matter: `name` (kebab-case, matches directory) and an exhaustive `description` with concrete
  trigger conditions. (Routing is done by the INVENTORY, but a good description still helps discovery.)
- Pick the archetype (creation / convention / module-hub) from `refs/skill-archetypes.md` and fill it.
- Creation skills: list every placeholder up front; order steps by dependency; the template must compile/parse
  after substitution; name every secondary file that must change (registration, migration, index, DI module).
- Convention skills: every rule has PASS and FAIL; only include rules the repo actually follows.
- End with a checklist (Law 14).

## Writing a subagent markdown file

- Front matter: `name`, `description`, `model`, `effort` (optional), `tools`, `timeout`, `context`.
  `name` matches the filename. Do NOT put `hooks`, `mcpServers`, or `permissionMode` in agent front matter.
- Definitions table before Step 1.
- Every step: one operation, a Pass condition, and a Fail condition with exact fallback output.
- Output format defined in exactly one place (the final step), with a field table (type + allowed values)
  and one example per distinct output case.
- Constraints section: scope, output format, no-generation (if read-only), no-delegation.

## Writing an LLM system prompt

- Four sections in order: Objective, Operational Requirements, Output Format, Constraints.
- State the specific role ("You are a {domain} reviewer"), never "helpful AI assistant".
- Number every validation step with PASS and FAIL branches; define every output field (type, allowed values, condition).

---

## Self-review checklist (run against your own output — Law 14)

- [ ] Every term defined before first use? (L1)
- [ ] One instruction per sentence? (L2)
- [ ] ALL/ANY explicit? (L3)
- [ ] Concrete, not abstract? (L4)
- [ ] Every rule shows PASS and FAIL? (L5)
- [ ] Every decision has both branches? (L6)
- [ ] Exact literals for codes/strings? (L7)
- [ ] One word per concept, no synonyms? (L8)
- [ ] Cross-refs use stable anchors? (L9)
- [ ] Enumerations exhaustive, no "etc."? (L10)
- [ ] Fallback for every rule? (L11)
- [ ] Conflicts prioritized? (L12)
- [ ] Output field formats constrained? (L13)
- [ ] Self-check present? (L14)
- [ ] Grounded in real exemplars, not invented? (L15)
- [ ] Reads top-to-bottom with no forward reference?

If any item fails, edit the file and re-check before returning.

## Anti-patterns

- Vague role: "You are a helpful assistant." → State the domain.
- Forward reference: "as described in Step 5." → Restructure so the info precedes its use.
- Missing fail branch: "If valid, continue." → State what happens when invalid.
- Synonyms for one concept. → Pick one word.
- "etc." in an enumeration. → List every case.
- "Follow the standard pattern." → Write the exact pattern; the reader has no memory.
