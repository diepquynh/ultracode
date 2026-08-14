# Ultracode

**Burn more tokens — on purpose, for better software.** Ultracode turns a one-shot coding request into a full
end-to-end engineering pipeline: a fleet of specialist subagents that explore, plan, implement and review — then,
when you ask for it, trace execution paths, test, review again, and document — every stage grounded in your repo's
own conventions. One cheap prompt becomes many deliberate ones, and you trade tokens for correctness, coverage,
and code that matches how your team already writes.

Concretely, it's a portable Claude Code and Codex plugin: a **repo-agnostic agentic engineering pipeline** plus a
**codebase-scouting initializer** that generates per-repo skills and a routing inventory for whatever language
and framework a repo uses. Install it once; run `/init-kit` on Claude Code or `$init-kit` on Codex to bootstrap
any repo.

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
- [Architecture](docs/architecture.md) — the plugin/per-repo split, inventory-based routing, how agents communicate, and design notes.
- [Agents](docs/agents.md) — every `subagent_type`, its role, the namespace prefix rule, and how existing skills are re-used.
- [Commands](docs/commands.md) — the Claude slash command and Codex explicit-skill entry point per pipeline stage.
- [Tested models](docs/tested-models.md) — field notes per role, per model, to seed your `repo-profile.json` `models` block.
- [Definition authoring](docs/definitions.md) — edit harness-neutral agent, skill, and command sources and generate either target.
- [Extending & publishing](docs/extending.md) — add a new stack reference, and publish/validate the plugin.

## Install

The generated plugin roots are `dist/claude/ultracode` and `dist/codex/ultracode`. Install the directory for
the harness you use; do not install the repository's neutral authoring sources directly.

### Claude Code

#### Published marketplace

Publish `dist/claude/ultracode` as the marketplace root, then install it with Claude Code:

```bash
claude plugin marketplace add <owner>/ultracode      # or a git URL
claude plugin install ultracode@ultracode            # <plugin>@<marketplace>
```

#### Local checkout

Point Claude Code at this checkout's generated marketplace. The path must start with `./` when it is relative:

```bash
claude plugin marketplace add ./dist/claude/ultracode # or an absolute path
claude plugin install ultracode@ultracode            # both names are "ultracode"
```

Local marketplaces do not auto-update. After regenerating `dist/claude/ultracode`, refresh the marketplace
and reload the session:

```bash
claude plugin marketplace update ultracode
```

Follow it with `/reload-plugins` (or restart the session) to re-register skills, agents, and hooks. Every
command above has an in-session equivalent: `/plugin marketplace add <path>`,
`/plugin install ultracode@ultracode`, `/plugin marketplace update ultracode`.

For active development, load the generated plugin directly. It takes precedence over an installed copy for
that Claude Code session:

```bash
claude --plugin-dir /absolute/path/to/ultracode/dist/claude/ultracode
```

Use `--plugin-dir` for fast iteration; use the local marketplace to rehearse the exact flow your users will follow.

### Codex

Codex plugins are installed from marketplaces. The Codex CLI and Codex in the ChatGPT desktop app support
plugins; the Codex IDE extension does not currently load plugins.

#### Published marketplace

Add the marketplace that publishes Ultracode, then install the plugin:

```bash
codex plugin marketplace add <marketplace-source>     # owner/repo, Git URL, or marketplace path
codex plugin add ultracode@<marketplace-name>
```

You can also launch `codex`, enter `/plugins`, select the configured marketplace, and install Ultracode from
the plugin browser. Start a new Codex session after installation so bundled skills and agents are discovered.

#### Local checkout

Codex has no Claude-style `--plugin-dir` flag. To install `dist/codex/ultracode` locally, place it inside a
temporary local marketplace. This repository ignores `tmp/`, so it is suitable for the staging copy:

```bash
mkdir -p ./tmp/codex-marketplace/.agents/plugins
mkdir -p ./tmp/codex-marketplace/plugins
cp -R ./dist/codex/ultracode ./tmp/codex-marketplace/plugins/ultracode
```

Create `tmp/codex-marketplace/.agents/plugins/marketplace.json`:

```json
{
  "name": "ultracode-local",
  "interface": {
    "displayName": "Ultracode Local"
  },
  "plugins": [
    {
      "name": "ultracode",
      "source": {
        "source": "local",
        "path": "./plugins/ultracode"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

Then add the local marketplace and install the plugin:

```bash
codex plugin marketplace add ./tmp/codex-marketplace
codex plugin add ultracode@ultracode-local
```

After installation, start a new Codex session and open `/hooks`. Review and trust Ultracode's bundled hooks;
Codex intentionally does not trust plugin hooks automatically. Then start another new session so the trusted
SessionStart hook runs. The initialization reminder and strict `repo-profile.json` model enforcement do not run
until the hooks are trusted.

## Use

### Harness quick reference

| Action | Claude Code | Codex |
| --- | --- | --- |
| Initialize the current repository | `/init-kit` | `$init-kit` |
| Explicitly activate the pipeline router | `/ultracode:orchestrate` | `$orchestrate` |
| Explicitly activate the prompt-authoring standard | `/ultracode:meta-author` | `$meta-author` |
| Invoke a generated project skill | `/<skill-name>` | `$<skill-name>` |
| Reload newly generated project skills | `/reload-plugins` or restart | Start a new session |
| Runtime inventory and profile | `.claude/ultracode/` | `.codex/ultracode/` |
| Generated project skills | `.claude/skills/` | `.agents/skills/` |

The `orchestrate` skill is the pipeline's router. Explicitly invoke it before a repository task if it has not
already activated from the request. It drives explore → generate-spec → plan → implement → code-review for each
phase, then offers execution-path analysis, tests, test review, and module documentation only when requested.

### First use in a repository

In any repo where the plugin is enabled:

1. Run `/init-kit` on Claude Code or `$init-kit` on Codex. The entry point spawns the initializer in parallel
   where work is independent, with an approval gate in the middle:
   - **detect** (1 agent) — identify the stack, pick `refs/<stack>.md`, plan the parallel slices, and
     discover any skills already under the active harness's skill directory.
   - **scout** (N agents, in parallel, read-only) — each owns one slice, finds every recurring component
     type, ranks by ubiquity across modules, captures one real exemplar + its invariants.
   - **propose** (1 agent) — merges findings and presents a ranked skill list **for your approval**, marking
     any already-present skill for reuse.
   - **generate** (N agents in parallel, one per skill you chose to (re)generate — then 1 to assemble the
     inventory) — writes the skills + `INVENTORY.md` + `repo-profile.json` into the active harness's repo-local
     directories; reused skills are registered without being rewritten.
2. Reload discovery: use `/reload-plugins` or restart Claude Code; start a new Codex session. Inventory routing
   works immediately, but newly written project skills need the harness to discover them.
3. Work normally, or explicitly invoke `/ultracode:orchestrate` on Claude Code or `$orchestrate` on Codex.

### Direct stage commands

Use these when you want one pipeline stage instead of the complete orchestrated flow. Claude Code emits native
slash commands. Codex packages the same entry points as explicit-only skills, so the leading `$` is required.

| Stage | Claude Code | Codex |
| --- | --- | --- |
| Initialize | `/init-kit [focus]` | `$init-kit [focus]` |
| Research | `/explore <topic>` | `$explore <topic>` |
| Generate specification | `/generate-spec [criteria path]` | `$generate-spec [criteria path]` |
| Plan | `/plan [spec path]` | `$plan [spec path]` |
| Implement | `/implement [phase or instructions]` | `$implement [phase or instructions]` |
| Review | `/code-review [implementation\|test\|full]` | `$code-review [implementation\|test\|full]` |
| Analyze execution paths | `/epa [implement report]` | `$epa [implement report]` |
| Write tests | `/write-test [EPA report]` | `$write-test [EPA report]` |
| Update module documentation | `/module-docs [implement reports]` | `$module-docs [implement reports]` |
| Author an instruction file | `/prompt-gen <task>` | `$prompt-gen <task>` |

Arguments are optional where shown. Without an explicit artifact path, the entry point uses the current
harness session directory. See [Commands](docs/commands.md) for stage inputs, outputs, approval gates, and model
routing behavior.

Commit the generated runtime files so your team shares them: `.claude/ultracode/` and `.claude/skills/` for
Claude Code, or `.codex/ultracode/` and `.agents/skills/` for Codex.

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
