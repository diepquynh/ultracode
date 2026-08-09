# Ultracode

**Burn more tokens — on purpose, for better software.** Ultracode turns a one-shot coding request into a full
end-to-end engineering pipeline: a fleet of specialist subagents that explore, plan, implement and review — then,
when you ask for it, trace execution paths, test, review again, and document — every stage grounded in your repo's
own conventions. One cheap prompt becomes many deliberate ones, and you trade tokens for correctness, coverage,
and code that matches how your team already writes.

Concretely, it's a portable Claude Code plugin: a **repo-agnostic agentic engineering pipeline** plus a
**codebase-scouting initializer** that generates per-repo skills and a routing inventory for whatever language
and framework a repo uses. Install it once; run `/init-kit` in any repo to bootstrap it.

## Why burn more tokens?

Cheap, single-shot answers are cheap for a reason: one model, one pass, no verification. Ultracode goes the
other way on purpose. It spends tokens where they buy quality:

- **Fan-out over one-shot.** Research, planning, implementation, and testing are separate subagents, each with a
  clean context window focused on one job — not one overloaded prompt juggling all of them. Separate stages also
  mean you can stop after any of them.
- **Verify, don't trust.** Every code change passes through a `code-reviewer` gate against your repo's own
  review rules, and the loop repeats until it clears.
- **Tests when you want them, not by reflex.** Test writing is an **opt-in** stage that runs after *every* coding
  phase is done — never between them, so a phase's tests are never written against code a later phase will still
  change. Once the code is complete the orchestrator asks once: write tests? update the module docs? It runs what
  you pick and tells you what it skipped. When you do want tests, they aren't guessed — an
  `execution-path-analyzer` enumerates the branches first, then `write-test` covers one path per test, and a phase
  the planner marked as pure boilerplate (DTOs, enums, config, re-exports) stays uncovered because it has no
  branch to enumerate.
- **Grounded, not generic.** The initializer scouts your codebase and writes per-repo skills, so generated code
  follows *your* patterns instead of a framework's defaults.
- **Parallel where it pays.** `/init-kit` fans scouting out across the repo in parallel slices — and skill
  generation out to one agent per skill — so more tokens don't linearly become more wall-clock time.

The payoff: you spend more tokens than a quick prompt would, and you get an end-to-end change — explored,
planned, implemented, reviewed, and (on request) tested and documented — that you'd otherwise stitch together by
hand across a dozen turns.

## Benchmarks

None. On purpose.

| Benchmark | Ultracode's score |
| --- | --- |
| SWE-bench Verified | didn't run it |
| HumanEval | pass@🤷 |
| That leaderboard in your other tab | not on it |
| Your repo, at 11pm before the demo | the only eval we play |

A benchmark is a fixed test with a public answer key. Your repo isn't in the set and its answer key doesn't
exist — so there's no *max* to benchmaxx toward. The only number we keep is [what a real task
costs](#how-much-does-it-actually-cost-in-a-real-world-task). :")

## Documentation

The deep dives live under [`docs/`](docs/):

- [The team you don't have](docs/philosophy.md) — the SDLC pains Ultracode's roles map to, and why they were built for teams.
- [Architecture](docs/architecture.md) — the plugin/per-repo split, inventory-based routing, how agents communicate, and design notes.
- [Agents](docs/agents.md) — every `subagent_type`, its role, the namespace prefix rule, and how existing skills are re-used.
- [Commands](docs/commands.md) — the slash command per pipeline stage, for running one agent instead of the whole pipeline.
- [Tested models](docs/tested-models.md) — field notes per role, per model, to seed your `repo-profile.json` `models` block.
- [Extending & publishing](docs/extending.md) — add a new stack reference, and publish/validate the plugin.

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

> **Always invoke `ultracode:orchestrate` first — before doing anything else.** It is the pipeline's single
> router; every task should begin by activating the orchestrate skill, which then drives the whole flow
> (explore → generate-spec → plan → implement → code-review, per phase — then, only if you ask:
> execution-path-analysis → write-test → code-review, and module-docs). It's set to activate at session start and for any code-changing task, but if it hasn't kicked
> in, start it explicitly before touching code.

In any repo where the plugin is enabled:

1. **`/init-kit`** — the command spawns the `ultracode:initializer` agent directly, fanning it out in parallel
   where the work is independent, with your approval gate in the middle:
   - **detect** (1 agent) — identify the stack, pick `refs/<stack>.md`, plan the parallel slices, and
     discover any skills already under `.claude/skills/`.
   - **scout** (N agents, in parallel, read-only) — each owns one slice, finds every recurring component
     type, ranks by ubiquity across modules, captures one real exemplar + its invariants.
   - **propose** (1 agent) — merges findings and presents a ranked skill list **for your approval**, marking
     any already-present skill for reuse.
   - **generate** (N agents in parallel, one per skill you chose to (re)generate — then 1 to assemble the
     inventory) — writes the skills + `INVENTORY.md` + `repo-profile.json` into `.claude/`; reused skills are
     registered without being rewritten.
2. **Reload** so the new project skills register: `/reload-plugins` or restart the session. (Routing via
   `INVENTORY.md` works immediately regardless; only the Skill-tool registration needs a reload.)
3. **Work normally.** The `ultracode:orchestrate` skill drives the pipeline
   (explore → generate-spec → plan → implement → code-review per phase, then the optional
   execution-path-analysis → write-test → code-review and module-docs stages it offers once the code is done),
   routing every decision through the generated inventory.

Want one stage instead of the whole pipeline? Each has its own slash command — `/explore`, `/generate-spec`,
`/plan`, `/implement`, `/code-review`, `/epa`, `/write-test`, `/module-docs`, `/prompt-gen` — that spawns just
that agent and infers its inputs from the current session directory. See [Commands](docs/commands.md).

Commit the generated `.claude/ultracode/` and `.claude/skills/` so your team shares them.

For the agent roster, architecture, model notes, and how to extend Ultracode to a new stack, see [`docs/`](docs/).

## How much does it actually cost in a real-world task?

Well.... :")

![Session cost breakdown](assets/cost.png)

This is a single session on a multi-repo task, with Opus 4.8 as the orchestrator model. The task working repos are a multi-module Java
backend, a FastAPI backend and React Native mobile app. The session involves 3 iterations of plan reviews and re-explore.

The rest of the implementation? I let it run and go to sleep, then wake up the following day to review the codes, manual regression test
and plan for the migration :")

By the time I wrote this README file and created this kit, I was using the Claude Max 5x plan.

Two honest disclaimers, then. **This isn't for vibe coding** — prompt-and-pray and your quota runs dry long
before you have a working MVP. **And it isn't for the blank slate** — Ultracode matches your repo's existing
patterns, so a fresh `git init` gives it nothing to work with. Bring a real task and a real repo. :")

## Going against the crowd — for now

Everyone else is racing to spend *fewer* tokens; we spend more, on purpose, because that's today's honest price
for a change that's actually reviewed and tested. *On purpose* isn't *forever*, though — next we want the cost
down without losing the fan-out's reactivity and quality. :")
