# Ultracode

**Burn more tokens — on purpose, for better software.** Ultracode turns a one-shot coding request into a full
end-to-end engineering pipeline: a fleet of specialist subagents that explore, plan, implement and review — then,
when you ask for it, trace execution paths, test, review again, and document — every stage grounded in your repo's
own conventions. One cheap prompt becomes many deliberate ones, and you trade tokens for correctness, coverage,
and code that matches how your team already writes.

Concretely, it's a portable Claude Code, Grok Build, and Codex plugin: a **repo-agnostic agentic engineering
pipeline** plus a **codebase-scouting initializer** that generates per-repo skills and a routing inventory for
whatever language and framework a repo uses. Install it once; run `/init-kit` on Claude Code or Grok Build, or
`$init-kit` on Codex, to bootstrap any repo.

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
- **Parallel where it pays.** The init-kit entry point fans scouting out across the repo in parallel slices —
  and skill generation out to one agent per skill — so more tokens don't linearly become more wall-clock time.

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
- [Installation](docs/installation.md) — published, manual, and local development installation flows.
- [Architecture](docs/architecture.md) — the plugin/per-repo split, inventory-based routing, how agents communicate, and design notes.
- [Agents](docs/agents.md) — every `subagent_type`, its role, the namespace prefix rule, and how existing skills are re-used.
- [Tested models](docs/tested-models.md) — field notes per role, per model, to seed your `repo-profile.json` `models` block.
- [Definition authoring](docs/definitions.md) — edit harness-neutral agent, skill, and command sources and generate either target.
- [Extending & publishing](docs/extending.md) — add a new stack reference, and publish/validate the plugin.

## Install

Requires Node 22.5+ and the CLI for each harness you install.

```bash
# Install for every harness
curl -fsSL https://raw.githubusercontent.com/diepquynh/ultracode/main/install.sh | bash

# Claude Code only
curl -fsSL https://raw.githubusercontent.com/diepquynh/ultracode/main/install.sh | bash -s -- claude

# Grok Build only
curl -fsSL https://raw.githubusercontent.com/diepquynh/ultracode/main/install.sh | bash -s -- grok

# Codex only
curl -fsSL https://raw.githubusercontent.com/diepquynh/ultracode/main/install.sh | bash -s -- codex
```

See [Installation](docs/installation.md) for manual installation.

## Use

| Action | Claude Code | Grok Build | Codex |
| --- | --- | --- | --- |
| Initialize the current repository | `/init-kit` | `/init-kit` | `$init-kit` |
| Explicitly activate the pipeline router | `/ultracode:orchestrate` | `/ultracode:orchestrate` | `$orchestrate` |
| Explicitly activate the prompt-authoring standard | `/ultracode:meta-author` | `/ultracode:meta-author` | `$meta-author` |
| Invoke a generated project skill | `/<skill-name>` | `/<skill-name>` | `$<skill-name>` |
| Reload newly generated project skills | `/reload-plugins` or restart | Press `r` in `/plugins` or start a new session | Start a new session |
| Runtime inventory and profile | `.claude/ultracode/` | `.grok/ultracode/` | `.codex/ultracode/` |
| Generated project skills | `.claude/skills/` | `.grok/skills/` | `.agents/skills/` |

Run the initializer once per repository, reload the harness, then invoke the orchestrator yourself — it's the
only entry point into the pipeline, and it only runs when you ask for it (there's no session-start nag and no
auto-activation on an arbitrary coding request). Explicitly invoke it with `/ultracode:orchestrate`, or ask for
it in plain language, and it takes it from there. Individual stages (`explore`, `generate-spec`, `plan`,
`implement`, `code-review`, `epa`, `write-test`, `module-docs`, `prompt-gen`) are internal subagents the
orchestrator spawns on your behalf; they aren't separate slash commands, so you never need to know which one to
run.

Commit the generated runtime files so your team shares them: `.claude/ultracode/` and `.claude/skills/` for
Claude Code, `.grok/ultracode/` and `.grok/skills/` for Grok Build, or `.codex/ultracode/` and `.agents/skills/`
for Codex. Grok also auto-loads Claude Code plugins; if Ultracode is already installed for Claude, install only
one copy so skills and hooks do not double-fire.

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
