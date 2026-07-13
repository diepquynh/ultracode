# Ultracode

**Burn more tokens — on purpose, for better software.** Ultracode turns a one-shot coding request into a full
end-to-end engineering pipeline: a fleet of specialist subagents that explore, plan, implement, review, trace
execution paths, test, review again, and document — every stage grounded in your repo's own conventions. One
cheap prompt becomes many deliberate ones, and you trade tokens for correctness, coverage, and code that matches
how your team already writes.

Concretely, it's a portable Claude Code plugin: a **repo-agnostic agentic engineering pipeline** plus a
**codebase-scouting initializer** that generates per-repo skills and a routing inventory for whatever language
and framework a repo uses. Install it once; run `/init-kit` in any repo to bootstrap it.

## Why burn more tokens?

Cheap, single-shot answers are cheap for a reason: one model, one pass, no verification. Ultracode goes the
other way on purpose. It spends tokens where they buy quality:

- **Fan-out over one-shot.** Research, planning, implementation, and testing are separate subagents, each with a
  clean context window focused on one job — not one overloaded prompt juggling all of them.
- **Verify, don't trust.** Every code change passes through a `code-reviewer` gate against your repo's own
  review rules, and the loop repeats until it clears. Tests aren't guessed — an `execution-path-analyzer`
  enumerates the branches first, then `write-test` covers one path per test.
- **Grounded, not generic.** The initializer scouts your codebase and writes per-repo skills, so generated code
  follows *your* patterns instead of a framework's defaults.
- **Parallel where it pays.** Scouting fans out across the repo in parallel slices, so more tokens don't
  linearly become more wall-clock time.

The payoff: you spend more tokens than a quick prompt would, and you get an end-to-end change — explored,
planned, implemented, reviewed, tested, and documented — that you'd otherwise stitch together by hand across a
dozen turns.

## The idea: engine + seed (plugin) → crop (per repo)

The plugin is intentionally split into two layers:

```
┌─ PLUGIN  (install once, everywhere) ─────────────────┐
│  agents/    generalized pipeline  +  the INITIALIZER  │
│  skills/    orchestrate + meta-author  (stack-neutral)│
│  refs/      java-spring · typescript-node · python ·  │ ← the initializer's case-by-case library
│             go · _generic · archetypes · contracts    │
│  commands/  /init-kit        hooks/  SessionStart     │
└────────────────────────┬──────────────────────────────┘
                         │  run /init-kit in a repo
                         ▼
┌─ TARGET REPO  .claude/  (GENERATED, commit these) ────┐
│  skills/<component>/SKILL.md × N   +  convention  +    │
│  skills/module-hub/ (routing tables + references/)     │
│  ultracode/INVENTORY.md   the master routing table     │
│  ultracode/repo-profile.json  build/test/fmt · map     │
└───────────────────────────────────────────────────────┘
```

The pipeline **agents never hardcode a build tool, skill name, or review rule.** At run time they read
`.claude/ultracode/INVENTORY.md` and `repo-profile.json` — written by the initializer — and route from there.

## Route by inventory, not by description

Harnesses don't reliably route off skill front-matter `description` fields. So the source of truth is
`INVENTORY.md`, a plain markdown file every agent is told to **Read** first. It carries: component-type →
skill, path-glob → area, and the build/test/format commands. Skill auto-discovery is a convenience on top;
the inventory works the moment it's written because it's just a file.

## Install

**From a published marketplace.** Push this repo to any git host, then:

```bash
claude plugin marketplace add <owner>/ultracode      # or a git URL
claude plugin install ultracode@ultracode            # <plugin>@<marketplace>
```

**From a local marketplace** — install straight off the filesystem, no publishing needed. Point the
marketplace at the directory holding `.claude-plugin/marketplace.json` (this repo's root); a plain,
non-git directory works and local paths raise no trust prompt:

```bash
claude plugin marketplace add ./ultracode            # relative ('./' required) or an absolute path
claude plugin install ultracode@ultracode            # both names are "ultracode"
```

Local marketplaces do **not** auto-update. After editing the plugin, refresh the cache, then reload:

```bash
claude plugin marketplace update ultracode
```

Follow it with `/reload-plugins` (or restart the session) to re-register skills, agents, and hooks. Every
command above has an in-session equivalent: `/plugin marketplace add <path>`,
`/plugin install ultracode@ultracode`, `/plugin marketplace update ultracode`.

**For active development**, skip the marketplace and load the plugin directly — it reloads fresh each launch
and takes precedence over any installed copy for that session:

```bash
claude --plugin-dir /path/to/ultracode
```

Use `--plugin-dir` for fast iteration; use the local marketplace to rehearse the exact flow your users will follow.

## Use

In any repo where the plugin is enabled:

1. **`/init-kit`** — the initializer runs in four modes, orchestrated by the command:
   - **detect** (1 agent) — identify the stack, pick `refs/<stack>.md`, plan the parallel slices.
   - **scout** (N agents, in parallel, read-only) — each owns one slice, finds every recurring component
     type, ranks by ubiquity across modules, captures one real exemplar + its invariants.
   - **propose** (1 agent) — merges findings and presents a ranked skill list **for your approval**.
   - **generate** (1 agent, after you approve) — writes the skills + `INVENTORY.md` + `repo-profile.json`
     into `.claude/`.
2. **Reload** so the new project skills register: `/reload-plugins` or restart the session. (Routing via
   `INVENTORY.md` works immediately regardless; only the Skill-tool registration needs a reload.)
3. **Work normally.** The `ultracode:orchestrate` skill drives the pipeline
   (explore → plan → implement → code-review → execution-path-analysis → write-test → code-review →
   module-docs), routing every decision through the generated inventory.

Commit the generated `.claude/ultracode/` and `.claude/skills/` so your team shares them.

## Agents

| Agent | Role |
| --- | --- |
| `initializer` | Detect stack → scout patterns (parallel) → propose → generate skills + inventory. |
| `explore` | Research a topic; write a grounded research document. |
| `plan` | Design a phased, verifiable implementation plan. |
| `implement` | Write code per a plan/phase; report changes; escalate via HANDOFF/STUCK. |
| `code-reviewer` | Review changes against the repo's Review Rule Set; emit JSON findings. |
| `execution-path-analyzer` | Enumerate execution paths per function to drive test writing. |
| `write-test` | Write one test per new execution path, using the repo's test framework. |
| `module-documentation` | Update area references under `skills/module-hub/references/`. |
| `prompt-generation` | Author/edit prompts, skills, and agent files via the meta-author standard. |

## Extending to a new stack

Add `refs/<stack>.md` following the shape of `refs/java-spring.md`: detection signals, slicing strategy,
conventional commands, test framework, a component catalog (find pattern + invariants per type), conventions,
and review-rule seeds. Add a detection row to the initializer's detect-mode table (`agents/initializer.md`,
Step D2). The `_generic.md` fallback handles unknown stacks by discovering components empirically.

## Design notes

- **Portable tools only.** Every agent uses `Read/Edit/Write/Bash/Grep/Glob` (+ `Skill`). No MCP or language
  server is assumed. If a code-graph MCP exists, agents prefer it; otherwise they fall back to Grep/Glob.
- **Seeded from real setups.** The pipeline agents, `orchestrate`, `meta-author`, and the stack references
  were generalized from production agent kits and grounded against real Java/Spring, TypeScript, and Go codebases.
- **Model tiers.** Scouting and most pipeline stages run on Sonnet; authoring stages
  (`prompt-generation`, `module-documentation`) run on Opus. Override per your needs.

## Publish

Set an explicit `version` in `.claude-plugin/plugin.json` and bump it on every release (pushing commits alone
does not trigger updates for version-pinned installs). Validate before distributing:
`claude plugin validate .` (or `/plugin validate .` inside Claude Code).
