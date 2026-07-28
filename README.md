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
- **Parallel where it pays.** `/init-kit` fans scouting out across the repo in parallel slices — and skill
  generation out to one agent per skill — so more tokens don't linearly become more wall-clock time.

The payoff: you spend more tokens than a quick prompt would, and you get an end-to-end change — explored,
planned, implemented, reviewed, tested, and documented — that you'd otherwise stitch together by hand across a
dozen turns.

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

## The team you don't have

Every classic SDLC pain has a classic fix — a code review, a QA pass, a design sign-off, a second pair of
eyes. The catch is that those fixes were built *for teams*. They assume an engineer who didn't write the code
can review it, a tester who isn't you, and an org that enforces the steps so none get quietly skipped at 11pm.

Solo, you inherit every pain and none of the headcount — and the discipline is the first thing to go, because
nothing outside your own willpower is holding the gate.

Ultracode gives each of those roles to a dedicated agent — a clean context, one job — and an orchestrator that
runs them in order and won't let you skip the hard steps:

| Classic SDLC pain | Solo, it bites like this | The pipeline's answer |
| --- | --- | --- |
| Jumping to code before you understand the problem | No one to challenge a wrong assumption before it's 400 lines deep | `explore` runs a grounded research pass first |
| No design phase, so the architecture drifts | You're the architect, at 11pm, with no one to sanity-check the approach | `plan` returns a phased strategy with risks and success criteria, held for your approval |
| No code review — the one a solo dev can't fake | You can't objectively review code you wrote an hour ago | `code-reviewer` gates every change against *your* repo's rules, looping until clean |
| Testing as an afterthought, cut under deadline | No QA net; tests are the first thing dropped when you're the only one shipping | `execution-path-analyzer` enumerates the branches, then `write-test` covers one path per test — coverage becomes systematic, not optional |
| Defects found late cost the most to fix | A bug surfacing three features later is one you alone still own | per-phase review gates catch mistakes before they compound downstream |
| Documentation debt | "I'll remember how this works" — until six months later you don't | `module-documentation` refreshes the area references automatically as the final step |
| Drift from your own conventions | No teammate to say "we don't do it that way here" | every stage routes off your repo's scouted conventions, so new code matches the old |

These are the pains the V-Model and every process after it were built to fix — and every one of those fixes
assumed a team.

Ultracode runs that process for a single person: the orchestrator is the senior who holds each
gate so shipping doesn't ride on your discipline at 11pm, and the fan-out hands every role a fresh, focused
context instead of one tired brain wearing seven hats. You don't get more headcount — you get the process the
headcount was for.

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

## How the agents communicate

Every subagent runs in a **forked context** — it can't see the main conversation, can't see another agent's
window, and can't spawn agents of its own. They are **leaf agents**: each does one job and returns a file
path. All coordination runs through a single hub (the orchestrator) and a single shared medium (the session
directory), so every stage gets a clean context focused on one task — and every handoff between stages is an
artifact you can open and read.

```
 ORCHESTRATOR — the only router: mints the session dir, hands each agent a
 self-contained prompt, reads the report it returns, decides the next step.
   │
   │  no agent calls another; every hop is a report file in the SESSION DIR
   │  (.claude/ultracode/session/ultracode-session-XXXX) — written by one agent, read by the next
   ▼
   explore                 ─▶ research doc + criteria doc (rates the request single-spec | multi-spec)
   generate-spec           ─▶ spec index + one SDD spec per shippable deliverable   (multi-spec only)
   plan                    ─▶ master plan + one self-contained file per phase       (one plan agent per spec)
   ── per spec, in spec order ──
   ── per phase (two independent review loops, one per fix agent) ──
   implement               ─▶ change report    (its Changed Files list = what to trace & cover)
   code-reviewer (impl)    ⇄  implement        (⇄ review ledger, loops until clean)
   execution-path-analyzer ─▶ EPA report       (one path per test: P1, P2 … NEW/EXISTING)
   write-test              ─▶ test report
   code-reviewer (tests)   ⇄  write-test       (⇄ review ledger, loops until clean)
   ── after all phases of all specs ──
   module-documentation    ─▶ area references  (reads every prior report)
```

**The spec tier is gated, not mandatory.** `explore` rates each request's **requirement scale**. A
`single-spec` request — one repo, one shippable deliverable, no criterion waiting on a contract another
criterion creates — skips `generate-spec` and goes straight to `plan`. A `multi-spec` request runs
`generate-spec`, which groups the criteria into an ordered set of specs, each stating its requirements in
**EARS** notation (`WHEN <trigger> THE SYSTEM SHALL <response>`) with Given/When/Then acceptance criteria and an
explicit list of the contracts it provides and consumes. One `plan` agent then runs per spec — in parallel,
since planning is read-only — and the orchestrator executes the resulting plans **one spec at a time**, so every
spec lands as a verified, shippable increment. Inside the plan currently executing, phases still fan out
wherever they don't block each other.

Two user-approval gates sit on that path: the **spec set** is approved before any planning starts, and the
**plans** are approved before any code is written.

**The orchestrator is the only router.** Because leaf agents can't see the conversation, each spawn prompt is
**self-contained** — it carries the session dir, the exact prior-report paths, the resolved build/test
commands, and a `Required skills:` line derived from the inventory. An agent works, writes its report, and
returns the path; the orchestrator reads that report and decides what runs next.

Reports are written for the next agent to consume — exact paths, full signatures, patterns shown in full
rather than referenced — and
each stage's report is the contract for the one after it (a plan's per-phase files feed `implement` one phase
at a time; an EPA report's enumerated paths become `write-test`'s coverage contract).

**Some channels are structured, not prose:**

- **Review ledger.** Each phase runs *two* independent review loops — one on the implementation, one on the
  tests — and each is a back-and-forth held through one file. The `code-reviewer` logs findings (`F1`, `F2`
  …); the matching fix agent (`implement` for the implementation loop, `write-test` for the test loop) writes
  back `FIXED`/`WONTFIX` **with a rationale**; the reviewer reads that rationale on the next pass to decide
  whether to re-raise. Each loop repeats until its change is clean, capped so it can't spin forever.
- **JSON findings.** The `code-reviewer` returns one machine-parseable JSON object — not prose — so the
  orchestrator can split findings by severity and rule ID. Findings the inventory marks **auto-fixable** carry
  an exact, backtick-delimited replacement, so the orchestrator applies the edit itself and skips a fix-agent
  round-trip.
- **Progress log.** The `implement` agent checkpoints after every step, so a re-spawn resumes where the last
  run stopped instead of redoing completed work.
- **`HANDOFF:` / `STUCK:` escalation.** A leaf agent can't spawn help, so it escalates *upward* by prefixing
  its return text. `HANDOFF:` tells the orchestrator to spawn a specialist (e.g. `prompt-generation` for a
  `SKILL.md` or prompt file) and then resume the original agent; `STUCK:` asks for rescue context or a user
  decision after repeated failures.

**Initialization runs on the same channel, spawned directly.** `/init-kit` fans the `initializer` out with the
**Agent tool** — the main loop spawns it in each mode, in parallel where the work is independent (multiple
Agent calls in one message). Each stage writes its output to the session dir as a file and returns the path;
the main loop reads that file to drive the next stage, and the `propose` stage's machine-readable
`ultracode-proposal.json` is the structured hand-off it reads to build the approved skill set.

Scouting and generation straddle a **user-approval gate**: the main loop presents the proposal and waits for
your decision before it spawns the generate agents.

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
> (explore → generate-spec (if `multi-spec`) → plan → implement → code-review → execution-path-analysis →
> write-test → code-review → module-docs). It's set to activate at session start and for any code-changing task, but if it hasn't kicked
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
   (explore → generate-spec (if `multi-spec`) → plan → implement → code-review → execution-path-analysis →
   write-test → code-review → module-docs), routing every decision through the generated inventory.

Commit the generated `.claude/ultracode/` and `.claude/skills/` so your team shares them.

### Re-using existing skills

Re-running `/init-kit` — or running it the first time in a repo that already ships hand-authored skills — does
**not** clobber what's there. During **detect** the initializer discovers every skill already under
`.claude/skills/`. In **propose** each is marked `status: existing` and, by default, **re-used as-is**: kept
on disk and registered in `INVENTORY.md`, never regenerated.

At the approval gate you can override per skill and force a **regenerate** to refresh a stale one from the
current code. Bespoke skills the team wrote — ones that map to no scouted component type (say a `deploy` or
`db-migration` skill) — are folded into the routing inventory too, so the pipeline can load them.

The upshot: re-scans are idempotent — your manual edits to a skill survive, and only the skills you explicitly
ask to (re)generate are rewritten.

## Agents

Every agent is registered under the plugin's `ultracode:` namespace, so its **`subagent_type` is the prefixed
name** — `ultracode:explore`, not `explore`. The prefix keeps `explore` and `plan` from colliding with Claude
Code's built-in `Explore` and `Plan` agents, which are not ultracode agents and do not follow this pipeline.
Spawn the names below verbatim.

| Agent (`subagent_type`) | Role |
| --- | --- |
| `ultracode:initializer` | Detect stack → scout patterns (parallel) → propose → generate skills (parallel) + inventory. |
| `ultracode:explore` | Research a topic; write a grounded research document plus a criteria document that rates the request `single-spec` or `multi-spec`. |
| `ultracode:generate-spec` | Group the criteria into an ordered set of SDD specs (EARS + Given/When/Then), each with its provided/consumed contracts. |
| `ultracode:plan` | Design a phased, verifiable implementation plan — one agent per spec, or one from the criteria when the request is `single-spec`. |
| `ultracode:implement` | Write code per a plan/phase; report changes; escalate via HANDOFF/STUCK. |
| `ultracode:code-reviewer` | Review changes against the repo's Review Rule Set; emit JSON findings. |
| `ultracode:execution-path-analyzer` | Enumerate execution paths per function to drive test writing. |
| `ultracode:write-test` | Write one test per new execution path, using the repo's test framework. |
| `ultracode:module-documentation` | Update area references under `skills/module-hub/references/`. |
| `ultracode:prompt-generation` | Author/edit prompts, skills, and agent files via the meta-author standard. |

The prefix comes from the plugin loader, which registers each agent as `{plugin}:{frontmatter name}`. Agent
files therefore keep a **bare** `name:` in their front matter — writing `name: ultracode:explore` would register
it as `ultracode:ultracode:explore`. The same holds for `repo-profile.json`'s `models` keys, which stay bare.

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
- **Model tiers, per repo and per phase.** `repo-profile.json` carries a `models` block the orchestrator
  follows when spawning each subagent, so a repo tunes cost vs. capability without touching the plugin.
  `/init-kit` seeds sensible defaults; edit the block to override. (Init-kit's own skill generation always runs
  on Opus, set by the `/init-kit` command when it spawns the generate-skill agents — that's separate from this
  block.)
  - `models.byAgent` fixes a model per stage — `explore`, `plan`, and the authoring stages
    `prompt-generation`/`module-documentation` run on Opus; `code-reviewer` and `execution-path-analyzer` run
    on Sonnet.
  - `models.byPhaseComplexity` switches the `implement` and `write-test` model by the plan phase's
    complexity/stake tier (the `plan` agent tags every phase Low/Medium/High) — default `low`/`medium` →
    Haiku, `high` → Sonnet, so cheap phases stay cheap while hard phases get a stronger model.
  - **Not everyone runs Claude Code on Anthropic-hosted models** — it can point at a gateway or proxy, Amazon
    Bedrock, Google Vertex, or another backend, and each name resolves to whatever model *your* Claude Code
    serves. That's why the block is per-subagent and per-repo: match every stage to the models your setup
    actually runs and to your own cost, latency, and capability needs.

## Publish

Set an explicit `version` in `.claude-plugin/plugin.json` and bump it on every release (pushing commits alone
does not trigger updates for version-pinned installs). Validate before distributing:
`claude plugin validate .` (or `/plugin validate .` inside Claude Code).

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
