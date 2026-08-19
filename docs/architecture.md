# Architecture

## The idea: engine + seed (plugin) → crop (per repo)

The plugin is split into two layers:

```
┌─ PLUGIN  (install once, everywhere) ─────────────────┐
│  agents/    neutral definition + prompt sources        │
│  skills/    neutral definition + prompt sources        │
│  refs/      java-spring · typescript-node · python ·  │ ← the initializer's case-by-case library
│             go · _generic · archetypes · contracts    │
│  commands/  neutral definition + prompt sources        │
│  hooks/     PreToolUse guards  +  SessionStart(compact) resume │
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

Harness-ready plugins (`dist/claude/ultracode/`, `dist/grok/ultracode/`, `dist/codex/ultracode/`) are build
output, not committed — `install.sh` regenerates them from the checkout on every install. Everything else
(hook configs, shared hook scripts, refs, assets, neutral command definitions) lives at the root and is
translated per target.

Pipeline agents never hardcode a build tool, skill name, or review rule. At run time they read the active
harness's inventory and profile:

| Harness | Inventory/profile dir |
|---|---|
| Claude Code | `.claude/ultracode/` |
| Grok Build | `.grok/ultracode/` |
| Codex | `.codex/ultracode/` |

Generated project skills live in the matching skills dir (`.claude/skills/`, `.grok/skills/`,
`.agents/skills/`). Agent/skill/command authoring is harness-neutral — each definition directory has
`definition.json` + `prompt.md`, and all three distributions are generated from those sources. See
[Definition authoring](definitions.md).

## Route by inventory, not by description

Harnesses don't reliably route off a skill's `description` front-matter, so the source of truth is
`INVENTORY.md` — a plain markdown file every agent reads first. It carries component-type → skill, path-glob →
area, and the build/test/format commands. Skill auto-discovery is just a convenience layered on top.

## Repo memory (the self-improving part)

Alongside `INVENTORY.md` and `repo-profile.json`, the runtime dir holds `memory/knowledge.sqlite3` — durable,
repo-scoped lessons (a non-obvious constraint, a subtle invariant, a workaround for a specific bug) that
survive across sessions, mirroring Pi's `memory.ts`. It's deliberately uncapped and never auto-expired: a
large multi-module repo accumulates more lessons, across more subagent failures, than any single session's
budget can gather in one pass, so the store has to keep growing across sessions rather than aging out on a
timer or a size limit. The one exception is **`ultracode_memory_forget`**, a narrow, agent-initiated removal
of a single lesson an agent has confirmed is now wrong or stale — an exact `(area, lesson)` match, never a
bulk sweep or an automatic trim.

That scale is also why it's a real SQLite database (`node:sqlite`, with an FTS5 virtual table for ranked
full-text search) rather than a flat file agents read in full. Any agent — not just the orchestrator — calls
**`ultracode_memory_recall`** with its own `repo_root`, an optional `area` scope (matching hierarchical
sub-scopes like `billing-service::InvoiceCalculator`), and a free-text `query` describing its task or failure,
and gets back just the relevant lessons, ranked by bm25 within scope, then by relevance repo-wide as fill.
Agents call it before starting work in an area and again with the error as the query after a failure, instead
of dumping the whole store into context. Any agent that learns something worth keeping calls
**`ultracode_memory`** to record it — all three tools are served from `mcp/gate-server.js`
(`mcp/lib/memory.js` holds the storage logic), alongside the `ultracode_gate` spec/plan-approval tool. Entries
are deduped by `(area, lesson)` — the newest occurrence updates the existing row's source and timestamp in
place rather than growing the store — but there is no cap or expiry; the only way an entry leaves the store is
an agent explicitly calling `ultracode_memory_forget` with that exact `(area, lesson)` pair after confirming
it's stale. `node:sqlite` is real file-backed SQLite, so concurrent writers (e.g.
two phases running in parallel each recording a lesson) wait on SQLite's own file lock rather than clobbering
each other; that correctness would have needed a hand-rolled lock file with an in-memory engine like `sql.js`.
The store is meant to be committed alongside the other generated routing files, same as `INVENTORY.md` and
`repo-profile.json` — it's binary, so expect it to diff opaquely, not readably.

`node:sqlite` requires Node ≥22.5 and is still an experimental API (`package.json`'s `engines` field reflects
this) — the trade accepted for real FTS5/bm25 ranking and OS-level file locking with zero added dependency,
over a WASM engine that would run on any Node version but require hand-rolled locking and lacks FTS5.

## How the agents communicate

Every subagent runs in a **forked context**: it can't see the main conversation, another agent's window, or
spawn agents of its own. They're **leaf agents** — one job each, returning a file path. The orchestrator is the
single hub, and the session directory is the single shared medium, so every handoff is an artifact you can
open and read.

**Session dir**, derived (never generated) so a forked agent can compute it without seeing how the orchestrator
chose it:

| Harness | Path |
|---|---|
| Claude Code | `.claude/ultracode/session/ultracode-session-${CLAUDE_CODE_SESSION_ID:-${GROK_SESSION_ID:-no-session-id}}` |
| Grok Build | `.grok/ultracode/session/ultracode-session-${GROK_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-no-session-id}}` |
| Codex | `.codex/ultracode/session/ultracode-session-${CODEX_THREAD_ID:-no-session-id}` |

The selected harness identifier passes unchanged to spawned agents; Grok also injects `GROK_SESSION_ID` into
plugin hooks so a hook process that never saw the spawn prompt can still derive it.

This is **idempotent** (any agent, anywhere, recomputes the same path) and **collision-free per session** (two
sessions against one repo never share a dir). Prompts still carry an explicit `Session dir:` line — the
derivation is a fallback, not a reason to drop it. It replaced two fragile schemes: a random suffix that had to
thread through every prompt, and a "newest dir" lookup that could silently pick up another session's artifacts.
Don't reintroduce either.

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

**Tests and docs are opt-in and never run between phases** — only after every phase passes review and `format`
runs. The orchestrator then asks once; whatever's declined is named in the completion report along with how to
request it later.

**Test coverage is scoped per phase.** `plan` tags each phase `Required` or `Skip`. `Skip` means every step
produces a file with no execution path of its own — a DTO, an interface/enum, a config/DI/registration file, a
re-export index — so there's nothing to trace and nothing to assert. Any logic step, or anything the plan agent
can't confidently classify, makes it `Required` (ties break toward testing: a wasted test pass costs tokens,
but a wrongly skipped one ships untested behavior). Visible in the Phase Index at the plan-approval gate, so
you can overrule it before any code is written.

**Every planned request goes through one spec file.** `generate-spec` merges research + criteria into a single
`ultracode-spec-*.md`: requirements in EARS notation (`WHEN <trigger> THE SYSTEM SHALL <response>`) with
Given/When/Then acceptance criteria, plus the contracts the work provides and consumes. Independently
shippable units are deliverables `D1`, `D2`, … inside that one file, in a Delivery Order table.

**`plan` reads only that spec file** — no research doc, no criteria doc, no loose answer text — so it can't be
built against two documents that disagree. It turns deliverables into a master plan whose phases carry a
deliverable ID, a repo, and a dependency set, fanning out wherever phases don't block each other.

Two approval gates sit on this path: the spec (before planning) and the plan (before coding). Anything the
user changes at either gate is written back into the spec via `generate-spec`, so the spec stays the one source
everything else traces to.

**The orchestrator is the only router.** Every spawn prompt is self-contained: session dir, exact prior-report
paths, resolved build/test commands, and a `Required skills:` line from the inventory. An agent works, writes
its report, and returns the path; the orchestrator reads it and decides what runs next.

Reports are written for the next agent to consume — exact paths, full signatures, patterns shown in full.
Some channels are structured rather than prose:

- **Review ledger** — one review loop per phase's implementation and per requested phase's tests, held through
  one file. `code-reviewer` logs findings (`F1`, `F2`…); `implement`/`write-test` responds `FIXED`/`WONTFIX`
  with a rationale; the reviewer re-raises or closes on the next pass. Capped so it can't spin forever.
- **JSON findings** — `code-reviewer` returns one machine-parseable object so the orchestrator can split
  findings by severity and rule ID. **Auto-fixable** findings carry an exact replacement the orchestrator
  applies directly, skipping a fix-agent round trip.
- **Progress log** — `implement` checkpoints after every step, so a re-spawn resumes instead of redoing work.
- **`HANDOFF:`/`STUCK:` escalation** — a leaf agent can't spawn help, so it escalates upward via a text prefix.
  `HANDOFF:` asks the orchestrator to spawn a specialist (e.g. `prompt-generation` for a `SKILL.md` or prompt
  file) then resume the original agent; `STUCK:` asks for rescue context or a user decision after repeated
  failures.

**Initialization uses the same channel, spawned directly.** `/init-kit` fans the `initializer` agent out via
the Agent tool — parallel calls where stages are independent. Each stage writes a session-dir file and returns
the path; the `propose` stage's `ultracode-proposal.json` is what the main loop reads to build the approved
skill set. A user-approval gate sits between scouting and generation.

## Design notes

- **Portable tools only.** Every agent uses `Read/Edit/Write/Bash/Grep/Glob` — no MCP or language
  server assumed. Skill loading is harness-specific: Claude Code has a `Skill` tool; Codex and Grok Build
  have none, so agents read the skill's `SKILL.md` instead. Agents prefer a code-graph MCP if one exists,
  else fall back to Grep/Glob.
- **Seeded from real setups.** The pipeline agents, `orchestrate`, `meta-author`, and the stack references were
  generalized from production agent kits and grounded against real Java/Spring, TypeScript, and Go codebases.
- **Model tiers, per repo and per phase.** `repo-profile.json`'s `models` block decides which model each
  subagent spawn runs on. `/init-kit` seeds sensible defaults; edit the block to override. (Init-kit's own
  skill generation always runs on the active harness's advanced model, set separately by the init-kit entry
  point — the `initializer` is the one agent the hook never denies for a missing route, so re-initializing an
  already-initialized repo keeps working.)
  - `hooks/model-router.js` runs as a `PreToolUse` hook on every agent spawn, resolves the route for that
    spawn's repo, translates it for the active harness, and sets `model` via `updatedInput` when the spawn
    omitted `model` or already passed the routed slug. A caller `model` that does not resolve to that slug is
    **denied**, not rewritten — Grok treats the original spawn argument as an explicit override even after
    `updatedInput` fires, so a silent rewrite cannot win. The orchestrator should omit `model`; if a hook
    denial names `model: <slug>`, re-spawn with that slug only. Once a profile exists, malformed or missing
    routes deny the spawn. `"default"` = generated agent default; `"inherit"` = leave the spawn model
    untouched (including a caller `model`). The hook re-reads the profile per spawn, so mid-session edits
    apply next call.
  - Claude agents keep their frontmatter defaults. Codex role TOML and Grok agent front matter omit `model`
    so a role-level value cannot outrank the spawn argument — the hook fills its generated default when the
    profile is absent or says `"default"`, and a Grok spawn with no model inherits the parent. Grok hook
    stdin is camelCase (`toolInput`, `sessionId`); shared hook helpers accept both that and Claude/Codex
    snake_case.
  - `effort` can't be routed this way — it's a subagent-definition field only (no per-invocation `effort` on
    the Agent / `spawn_subagent` tool, no env var for it). Claude and Grok write `effort` in agent front
    matter; Codex writes `model_reasoning_effort` in the role TOML. That value always holds regardless of tier.
  - `models.byAgent`: `explore`, `generate-spec`, `plan`, and the authoring stages → `advanced`;
    `code-reviewer`, `execution-path-analyzer` → `balanced`.
  - `models.byPhaseComplexity`: `implement`/`write-test` → `fast` for low/medium complexity, `balanced` for
    high.
  - The block is per-subagent and per-repo because not everyone runs Claude Code on Anthropic-hosted models —
    it can point at a gateway/proxy, Bedrock, Vertex, or another backend. Match each stage to what your setup
    actually serves and to your own cost/latency/capability needs.
