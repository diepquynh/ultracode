# Architecture

## The idea: engine + seed (plugin) → crop (per repo)

The plugin is intentionally split into two layers:

```
┌─ PLUGIN  (install once, everywhere) ─────────────────┐
│  agents/    neutral definition + prompt sources        │
│  skills/    neutral definition + prompt sources        │
│  refs/      java-spring · typescript-node · python ·  │ ← the initializer's case-by-case library
│             go · _generic · archetypes · contracts    │
│  commands/  neutral definition + prompt sources        │
│  hooks/     SessionStart  +  PreToolUse model router  │
└────────────────────────┬──────────────────────────────┘
                         │  run /init-kit in a repo
                         ▼
┌─ TARGET REPO  (GENERATED, commit these) ──────────────┐
│  harness skill dir: component skills + module hub      │
│  harness runtime dir:                                  │
│    INVENTORY.md          the master routing table      │
│    repo-profile.json     build/test/fmt · map          │
└───────────────────────────────────────────────────────┘
```

Harness-ready plugins are build output, generated under `dist/claude/ultracode/`, `dist/grok/ultracode/`, and
`dist/codex/ultracode/` rather than committed — `install.sh` regenerates them from the checkout on every
install. Target-specific hook configs, shared hook scripts, references, assets, and neutral command definitions
remain at the root and are translated into the applicable distribution.

The pipeline **agents never hardcode a build tool, skill name, or review rule.** At run time they read the
active harness's inventory and profile — `.claude/ultracode/` for Claude Code, `.grok/ultracode/` for Grok
Build, or `.codex/ultracode/` for Codex — and route from there. Generated project skills likewise use
`.claude/skills/`, `.grok/skills/`, or `.agents/skills/`. Agent, plugin-skill, and command authoring is
harness-neutral: each definition directory contains `definition.json` and `prompt.md`. All three plugin
distributions are generated from those sources. See [Definition authoring](definitions.md) for the layout and
per-target output.

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

That shared medium needs one path everybody agrees on, and a forked agent cannot see how the orchestrator chose
it. So the path is **derived, never generated**:

Claude Code derives this as
`{repo-root}/.claude/ultracode/session/ultracode-session-${CLAUDE_CODE_SESSION_ID:-${GROK_SESSION_ID:-no-session-id}}`.
Grok Build derives this as
`{repo-root}/.grok/ultracode/session/ultracode-session-${GROK_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-no-session-id}}`.
Codex derives it as
`{repo-root}/.codex/ultracode/session/ultracode-session-${CODEX_THREAD_ID:-no-session-id}`. The selected harness
identifier is inherited unchanged by spawned agents. Grok also injects `GROK_SESSION_ID` into plugin hooks, so
the same derivation works from a hook process that never saw the spawn prompt.
Two properties follow, and the pipeline leans on both. It is **idempotent** — any agent, in any working
directory, at any point in the session, recomputes the same path, so re-running the derivation never forks a
second dir mid-run. And it is **collision-free per session** — two sessions against one repo get separate dirs
without coordinating.

Prompts still carry an explicit `Session dir:` line; the derivation is the fallback for when one doesn't, not a
reason to drop it. What the derivation replaced was worse on both counts: a random suffix (`openssl rand`) that
had to be threaded through every prompt or the artifacts scattered, and a "newest dir under `session/`" lookup
that silently picked up a *different* session's artifacts whenever two ran against one repo. Neither is safe in
a forked-context pipeline; if you extend ultracode, derive the path rather than reintroducing either.

```
 ORCHESTRATOR — the only router: derives the session dir, hands each agent a
 self-contained prompt, reads the report it returns, decides the next step.
   │
   │  no agent calls another; every hop is a report file in the SESSION DIR
   │  (.claude/ultracode/session/ultracode-session-<session-id>) — written by one, read by the next
   ▼
   explore                 ─▶ research doc + criteria doc      (one agent per repo)
   generate-spec           ─▶ ONE spec file, deliverables D1…Dn inside it
   plan                    ─▶ master plan + one self-contained file per phase  (reads only the spec file)
   ── per phase (one review loop; the loop ends here) ──
   implement               ─▶ change report    (its Changed Files list = what to trace & cover)
   code-reviewer (impl)    ⇄  implement        (⇄ review ledger, loops until clean)
   ── after all phases: format, then the CLOSING GATE — both stages below are optional ──
   tests?  ─▶ execution-path-analyzer ─▶ EPA report  (one path per test: P1, P2 … NEW/EXISTING)
                                         all covered phases at once — read-only, so they cannot collide
             ── then one covered phase at a time: they share the test suite ──
             write-test               ─▶ test report
             code-reviewer (tests)    ⇄  write-test  (⇄ review ledger, loops until clean)
   docs?   ─▶ module-documentation    ─▶ area references  (reads every prior report)
```

**Writing tests and updating the docs are opt-in, and they never run between phases.** The per-phase loop ends
at the implementation review, so a phase's code is never covered before a later phase can still change it. Once
every coding phase has passed review and `format` has run, the orchestrator asks once — write tests? update the
module docs? — and runs only what you pick. Ask for either later, or up front in your request, and it runs
without a gate. Whatever you decline is named in the completion report, along with how to ask for it later — just
tell the orchestrator to run it, so a skipped stage is never silent.

**Within a requested test run, a boilerplate-only phase stays uncovered.** The `plan` agent tags every phase with
a **Test policy** of `Required` or `Skip`, alongside its complexity tier. `Skip` means every step in the phase
produces a file with no execution path of its own — a DTO or value type, an interface or enum declaration, a
config/DI/registration file, a re-export index — so there is nothing for the EPA to trace and nothing for a test
to assert. The tag doesn't decide *whether* tests happen — you do, at the gate — it decides *which* phases a run
covers, saving three subagent spawns per skipped phase. One logic step anywhere in the phase, or one step the
plan agent can't confidently classify, makes it `Required`: the tie always breaks toward testing, because a
wasted test pass costs tokens while a wrongly skipped one ships untested behavior. The verdict is visible in the
Phase Index at the plan-approval gate, so you can overrule it before any code is written.

**Every planned request goes through the spec tier, and the spec is one file.** `generate-spec` merges the
criteria and research into a single `ultracode-spec-*.md` stating every requirement in **EARS** notation
(`WHEN <trigger> THE SYSTEM SHALL <response>`) with Given/When/Then acceptance criteria, plus the contracts the
work provides and consumes. Independently shippable units live *inside* that file as deliverables `D1`, `D2`, …
in a Delivery Order table, rather than as separate files.

**The `plan` agent reads that spec file and nothing else** — no research doc, no criteria doc, no loose answer
text. One requirements source means the plan can't be built against two documents that disagree. It turns the
spec's deliverables into one master plan whose phases carry a deliverable ID, a repo, and a dependency set, and
those phases fan out wherever they don't block each other.

Two user-approval gates sit on that path: the **spec** is approved before planning starts, and the **plan** is
approved before any code is written. Anything the user changes at either gate is written back into the spec
file — by re-running `generate-spec` — so the spec always stays the single source every later stage traces to.

**The orchestrator is the only router.** Because leaf agents can't see the conversation, each spawn prompt is
**self-contained** — it carries the session dir, the exact prior-report paths, the resolved build/test
commands, and a `Required skills:` line derived from the inventory. An agent works, writes its report, and
returns the path; the orchestrator reads that report and decides what runs next.

Reports are written for the next agent to consume — exact paths, full signatures, patterns shown in full
rather than referenced — and
each stage's report is the contract for the one after it (a plan's per-phase files feed `implement` one phase
at a time; an EPA report's enumerated paths become `write-test`'s coverage contract).

**Some channels are structured, not prose:**

- **Review ledger.** Every change gets a review loop — one on each phase's implementation, and one on each
  requested phase's tests — and each is a back-and-forth held through one file. The `code-reviewer` logs findings
  (`F1`, `F2` …); the matching fix agent (`implement` for the implementation loop, `write-test` for the test loop)
  writes back `FIXED`/`WONTFIX` **with a rationale**; the reviewer reads that rationale on the next pass to decide
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

## Design notes

- **Portable tools only.** Every agent uses `Read/Edit/Write/Bash/Grep/Glob` (+ `Skill`). No MCP or language
  server is assumed. If a code-graph MCP exists, agents prefer it; otherwise they fall back to Grep/Glob.
- **Seeded from real setups.** The pipeline agents, `orchestrate`, `meta-author`, and the stack references
  were generalized from production agent kits and grounded against real Java/Spring, TypeScript, and Go codebases.
- **Model tiers, per repo and per phase.** `repo-profile.json` carries a `models` block that decides which
  model each subagent spawn runs on, so a repo tunes cost vs. capability without touching the plugin.
  `/init-kit` seeds sensible defaults; edit the block to override. (Init-kit's own skill generation always runs
  on the active harness's advanced model, set by the init-kit entry point when it spawns the generate-skill
  agents — that's separate from this block. The `initializer` is the one agent the hook never denies for a
  missing route: it keeps the model init-kit chose, so re-initializing an already-initialized repo works.)
  - **The hook owns the decision end to end.** `hooks/model-router.py` runs as a `PreToolUse` hook on agent
    spawns, resolves the route from *that spawn's* repo, translates neutral tiers for the active harness, and
    sets the call's `model` argument via `updatedInput`. The orchestrator passes no `model` argument at all, so
    there is no second place to keep in sync. Once a profile exists, malformed or
    missing routes deny the spawn. Set a route to `"default"` to select the generated agent default or `"inherit"` to intentionally
    leave the spawn model untouched. The hook re-reads the profile per spawn, so mid-session edits apply next.
  - **Generated defaults are the floor.** Claude and Grok agents retain their frontmatter defaults. Codex role
    TOML omits `model`, because a role-level Codex model outranks the spawn argument; the hook supplies its
    generated default when the profile is absent or explicitly says `"default"`. Grok hook stdin is camelCase
    (`toolInput`, `sessionId`); the shared hook helpers accept both that envelope and Claude/Codex snake_case.
  - **Effort cannot be routed this way.** `effort` is a subagent-definition field only — the Agent tool takes no
    per-invocation `effort`, and there is no `CLAUDE_CODE_SUBAGENT_EFFORT`. Every agent's `effort: high` in
    front matter therefore holds regardless of tier, and it overrides the session effort level.
  - `models.byAgent` fixes a neutral tier per stage — `explore`, `generate-spec`, `plan`, and the authoring
    stages use `advanced`; `code-reviewer` and `execution-path-analyzer` use `balanced`.
  - `models.byPhaseComplexity` switches `implement` and `write-test` by plan complexity — default
    `low`/`medium` → `fast`, `high` → `balanced`.
  - **Not everyone runs Claude Code on Anthropic-hosted models** — it can point at a gateway or proxy, Amazon
    Bedrock, Google Vertex, or another backend, and each name resolves to whatever model *your* Claude Code
    serves. That's why the block is per-subagent and per-repo: match every stage to the models your setup
    actually runs and to your own cost, latency, and capability needs.
