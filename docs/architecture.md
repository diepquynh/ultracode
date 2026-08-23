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
│  .ultracode/  (shared runtime dir, any harness)        │
│    INVENTORY.md          the master routing table      │
│    repo-profile.json     build/test/fmt · map          │
└───────────────────────────────────────────────────────┘
```

Harness-ready plugins (`dist/claude/ultracode/`, `dist/grok/ultracode/`, `dist/codex/ultracode/`, `dist/antigravity/ultracode/`) are build
output, not committed — `install.sh` regenerates them from the checkout on every install. Everything else
(hook configs, shared hook scripts, refs, assets, neutral command definitions) lives at the root and is
translated per target.

Pipeline agents never hardcode a build tool, skill name, or review rule. At run time they read the repo's
inventory and profile from its runtime dir.

The runtime dir is `.ultracode/` at the project root, **outside** every harness's state dir, so a single
`/init-kit` run bootstraps the repo for Claude Code, Grok Build, Codex, and Antigravity alike. Only skill and
agent discovery stays harness-native, because each harness scans its own directory:

| Harness | Inventory/profile dir | Generated project skills |
|---|---|---|
| Claude Code | `.ultracode/` | `.claude/skills/` |
| Grok Build | `.ultracode/` | `.grok/skills/` |
| Codex | `.ultracode/` | `.agents/skills/` |
| Antigravity | `.ultracode/` | `.agents/skills/` |

A repo bootstrapped by an older version still has its runtime dir inside a harness state dir (e.g. the claude
state dir's `ultracode` subdirectory). `/init-kit`'s `detect` mode finds those, offers them as cross-harness
candidates, and `adopt` migrates one into `.ultracode/` rather than re-scouting the repo.

Agent/skill/command authoring is harness-neutral — each definition directory has `definition.json` +
`prompt.md`, and all four distributions are generated from those sources. See
[Definition authoring](definitions.md).

## Route by inventory, not by description

Harnesses don't reliably route off a skill's `description` front-matter, so the source of truth is
`INVENTORY.md` — a plain markdown file every agent reads first. It carries component-type → skill, path-glob →
area, and the build/test/format commands. Skill auto-discovery is just a convenience layered on top.

## Repo memory (the self-improving part)

Alongside `INVENTORY.md` and `repo-profile.json`, the runtime dir holds `memory/knowledge.sqlite3`: durable,
repo-scoped lessons — a non-obvious constraint, a subtle invariant, a workaround for a specific bug — that
survive across sessions, mirroring Pi's `memory.ts`.

Three MCP tools, served from `mcp/gate-server.js` (storage logic in `mcp/lib/memory.js`) alongside the
`ultracode_gate` spec/plan-approval tool:

- **`ultracode_memory_recall`** — any agent, not just the orchestrator, passes its own `repo_root`, an optional
  `area` scope (matching hierarchical sub-scopes like `billing-service::InvoiceCalculator`), and a free-text
  `query` describing its task or its failure. It gets back just the relevant lessons, ranked by bm25 within
  scope, then by relevance repo-wide as fill. Agents call it before starting work in an area, and again with
  the error as the query after a failure — instead of dumping the whole store into context.
- **`ultracode_memory`** — record a lesson worth keeping. Entries dedupe on `(area, lesson)`: the newest
  occurrence updates the existing row's source and timestamp in place rather than growing the store.
- **`ultracode_memory_forget`** — the only way an entry ever leaves. A narrow, agent-initiated removal of a
  single lesson an agent has confirmed is now wrong or stale, by exact `(area, lesson)` match. Never a bulk
  sweep, never an automatic trim.

The store is deliberately uncapped and never expires on a timer or a size limit: a large multi-module repo
accumulates more lessons, across more subagent failures, than any single session's budget can gather in one
pass, so it has to keep growing rather than aging out. That scale is also why it's a real SQLite database
(`node:sqlite`, with an FTS5 virtual table for ranked full-text search) rather than a flat file agents read in
full — and real file-backed SQLite means two phases running in parallel each recording a lesson wait on
SQLite's own file lock instead of clobbering each other, which an in-memory engine like `sql.js` would have
needed a hand-rolled lock file to match.

Commit it alongside the other generated routing files, same as `INVENTORY.md` and `repo-profile.json` — it's
binary, so expect it to diff opaquely. `node:sqlite` requires Node ≥22.5 and is still an experimental API
(`package.json`'s `engines` field reflects this): the price of real FTS5/bm25 ranking and OS-level file locking
with zero added dependency, over a WASM engine that runs anywhere but lacks FTS5 and locking.

## How the agents communicate

Every subagent runs in a **forked context**: it can't see the main conversation, another agent's window, or
spawn agents of its own. They're **leaf agents** — one job each, returning a file path. The orchestrator is the
single hub, and the session directory is the single shared medium, so every handoff is an artifact you can
open and read.

**Session dir**, derived (never generated) so a forked agent can compute it without seeing how the orchestrator
chose it:

| Harness | Path |
|---|---|
| Claude Code | `.ultracode/session/ultracode-session-${CLAUDE_CODE_SESSION_ID:-${GROK_SESSION_ID:-no-session-id}}` |
| Grok Build | `.ultracode/session/ultracode-session-${GROK_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-no-session-id}}` |
| Codex | `.ultracode/session/ultracode-session-${CODEX_THREAD_ID:-no-session-id}` |
| Antigravity | `.ultracode/session/ultracode-session-${ANTIGRAVITY_CONVERSATION_ID:-${AGY_CONVERSATION_ID:-no-session-id}}` |

The selected harness identifier passes unchanged to spawned agents; Grok also injects `GROK_SESSION_ID` into
plugin hooks so a hook process that never saw the spawn prompt can still derive it.

This is **idempotent** (any agent, anywhere, recomputes the same path) and **collision-free per session** (two
sessions against one repo never share a dir). Prompts still carry an explicit `Session dir:` line — the
derivation is a fallback, not a reason to drop it. It replaced two fragile schemes: a random suffix that had to
thread through every prompt, and a "newest dir" lookup that could silently pick up another session's artifacts.
Don't reintroduce either.

Each repo in scope gets its own subdirectory of that dir, named by its **repo key**, and every spawn prompt
carries the key on a `Repo key:` line beside `Session dir:`. Pipeline state splits along that seam:

| State | Lives at | Written by | Read by |
|---|---|---|---|
| `factcheck.json` | `{session dir}/{repo key}/` | `hooks/factcheck-record.js` (`hooks/agy-message-record.js` on Antigravity) | the `ultracode_gate` MCP tool, before it will record an approval |
| `gates.json` | `{session dir}/` | the `ultracode_gate` MCP tool | `hooks/pipeline-gate.js`, before it will allow the next stage to spawn |

The asymmetry is deliberate: a fact-check verdict is about one repo's spec or plan claims, while an approval is
one session-level decision over one spec and one plan. What matters is that **both sides of each pair resolve
the same path from the same inputs** — every reader and writer normalizes a declared session dir to the
`ultracode-session-*` directory first (`hooks/lib/session.js`), then re-appends the repo key if that state is
per repo. Joining a filename onto whichever form a prompt happened to pass is what previously wrote a real
`PASS` into `{session dir}/{repo key}/` and looked for it in `{session dir}/`, leaving the gate to refuse an
approval for a verdict that existed. A spawn or gate call with no repo key is refused outright rather than
defaulted, for the same reason: there is no key to guess that both sides would guess alike.

```
 ORCHESTRATOR — the only router: derives the session dir, hands each agent a
 self-contained prompt, reads the report it returns, decides the next step.
   │
   │  no agent calls another; every hop is a report file in the SESSION DIR
   │  (.ultracode/session/ultracode-session-<session-id>) — written by one, read by the next
   ▼
   explore                 ─▶ research doc + criteria doc      (one agent per repo)
   generate-spec           ─▶ ONE spec file, deliverables D1…Dn inside it
   fact-check (spec)       ─▶ verdict JSON — PASS required before the spec gate opens
   plan                    ─▶ master plan + one self-contained file per phase  (reads only the spec file)
   fact-check (plan)       ─▶ verdict JSON — PASS required before the plan gate opens
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

Two approval gates sit on this path: the spec (before planning) and the plan (before coding). Each is preceded
by a mandatory `fact-check` pass — `ultracode_gate` will not record approval without a `PASS`, whatever the
orchestrator or the user decides — so no artifact reaches you carrying a claim that isn't true of the repo.
Anything the user changes at either gate is written back into the spec via `generate-spec`, so the spec stays
the one source everything else traces to.

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
  subagent spawn runs on — a static tier per agent, and a per-phase-complexity tier for `implement` and
  `write-test`. `hooks/model-router.js` applies it as a `PreToolUse` hook on every spawn, translates it for the
  active harness, and denies any spawn it cannot resolve. `/init-kit` seeds defaults; edit the block to
  override. See [Model routing](model-routing.md) for the value forms, the denial cases, and the two exempt
  agents.
  - Init-kit's own skill generation always runs on the active harness's advanced model, set by the init-kit
    entry point rather than the profile.
  - `PreToolUse` hooks do not compose — both hooks on a matcher see the original tool input and only one
    `updatedInput` survives — so `model-router.js` is the only place an agent spawn may be rewritten at all.
    Spawn-time prompt injection lives there for that reason, not because it belongs there.
  - Hook policy consumes `hooks/lib/hook-context.js`, not raw payload casing. `hooks/lib/harness.js` declares
    each harness's tool-input, result, session, actor, transcript, prompt, model, command, and path fields. It
    normalizes Claude/Codex snake_case, Grok camelCase, and Antigravity's `toolCall.args.Subagents[]` envelope.
  - A spawn call is a list, even on harnesses whose normal form is one flat object. Routing and every spawn
    guard iterate the complete list; a malformed later `Subagents[]` entry denies the whole call instead of
    bypassing policy behind entry zero.
  - `hooks/subagent-parameters.json` is the runtime contract: one parameter catalog plus the required set for
    every agent (including initializer mode-specific requirements). `definitions/subagent-parameters.schema.json`
    defines that manifest's shape. `session-guard.js` validates the literal `Label: value` lines before spawn.
  - `Repo root:` and session ownership are intentionally separate. `Repo root:` is the checkout the leaf agent
    works in; required `Primary repo root:` names the repository that owns the deterministic
    `.ultracode/session/ultracode-session-*` root.
    Reports, gates, fact-checks, progress, scope, and build-streak state stay in that primary root even when the
    work repo is another checkout, preventing fragmented pipeline state.
  - Write/Edit/Bash scope guards therefore safeguard **two** roots for a leaf spawn: the primary session dir
    (reports/state only) and the work `Repo root:` (source, constrained further by the phase allowlist when
    present). `currentActor()` prefers transcript `Repo root:` / `Repo key:` / `Session dir:` over the harness
    cwd so a Claude secondary-repo implement is not confined to the primary checkout.
  - **Current harness limitations (live, 2026-08-22):**
    - Claude Code 2.1.220 and Antigravity CLI 1.1.18 dispatch Ultracode plugin spawn hooks. Claude rewrites must
      live only in `hookSpecificOutput.updatedInput` — a top-level `overwrite` fails Claude's hook schema and is
      discarded. Claude's `Agent` tool is async by default: `PostToolUse:Agent` sees only the launch ack
      (`Async agent launched successfully…`), so `hooks/factcheck-record.js` also registers on `SubagentStop`
      (`matcher: ^ultracode:fact-check$`) and records from `last_assistant_message` plus the leaf transcript's
      spawn prompt. Claude leaf `PostToolUse` Bash events also often omit `agent_type`, so `build-streak.js` /
      `build-streak-gate.js` cannot attribute failures inside a forked implement/write-test turn even when the
      matching PreToolUse Bash call carried the actor.
    - Grok CLI 1.0.5 currently discovers the Ultracode plugin (`has_hooks=true`) but expands **zero** plugin
      handlers into its runtime registry (`total_hooks=0`), so parent Bash/Write denials never fire either —
      this is broader than the earlier spawn-only bypass. Separately, Grok honors top-level `{decision:"deny"}`
      and fail-opens on Claude-style `hookSpecificOutput.permissionDecision`; Ultracode emits the Grok shape.
    - Codex CLI 0.147.0 still does not dispatch plugin handlers for native `spawn_agent` (parent Bash/Write
      hooks can still fire once trusted). Generated leaf prompts therefore repeat the parameter contract and
      fail before their first tool call when a required line is missing.
