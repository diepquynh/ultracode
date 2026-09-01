# Ultracode

Ultracode turns a one-shot coding request into a full end-to-end engineering pipeline: a fleet of specialist
subagents that explore, plan, implement and review — then, when you ask for it, trace execution paths, test,
review again, and document — every stage grounded in your repo's own conventions. One cheap prompt becomes
many deliberate ones, and you trade tokens for correctness, coverage, and code that matches how your team
already writes.

## Why Ultracode?

The name is stolen, deliberately — but I like it. Before it was a plugin, it was just a pile of workflows I
rebuilt for every project I touched, and all of them came out of the same frustrations: a startup job where one
person manages several projects at once, on deadlines nobody sane agreed to.

- **Project and client management by vibes.** One PIC, many projects, all urgent, no process holding any of it.
- **Zero documentation from day one.** Almost every project I worked on ran this way — too rushed to write
  anything down, which is exactly what hurts later, when the thing has to be handed over to another dev or to
  the client.
- **Coupling.** Multiple moving parts means remembering to mirror a change everywhere it lands. On a big change
  you *will* forget one, no matter how well you planned.
- **Overlooking.** Most planning failures are just a component nobody remembered. As the single PIC for
  everything, you can't hold all of it in your head.
- **Idea testing and fact checks.** Before you build, you should check what the system already does and where it
  technically can't go. That takes time, and startups don't grant it — businessmen are greedy as hell.
- **Guardrails and auditing.** Especially with the cheaper models. You want the changes audited, and audited
  *visibly to you*, not a model hallucinating its way through the codebase. Your tokens are an asset; spend them
  responsibly.

## Does it fix all that?

As much as software can. The pipeline exists to make building and idea-testing fast, and to make failure early:
if something is going to fail, it should fail now, not three phases later.

The other half is going AFK. The whole design points at leaving the subagents running and coming back to
finished work instead of babysitting a terminal 9 to 5 — and that only holds if the pipeline is tight enough
that the model doesn't hallucinate itself off a cliff on badly injected context.

## When should I use it?

- **When the codebase got big enough that controlling it hurts.** Multi-module, multi-repo, or just old enough
  that nobody holds the whole map anymore.
- **When the deadline for a big feature is unrealistic.** The kind where the planning is the part you'd skip.
- **When you want the smartest *and* the cheapest model on each job** — without typing "bro let's use X for
  implementing" into every prompt.

The flip side — when *not* to reach for it — is [further down](#how-much-does-it-actually-cost-in-a-real-world-task),
after you've seen the bill.

## What's in the box

Aimed at serious developers. Battle-tested on real repos, not benchmaxxed.

**An orchestrator.** A pipeline is only as good as the thing routing it. It derives the session directory, hands
each subagent a self-contained prompt, reads the report that comes back, and decides what runs next. It's the
only entry point and the only router — nothing else spawns anything.

**Subagents**, one job each, spawned with the skills your repo's inventory says apply, so their output follows
your conventions instead of a framework's defaults:

| Agent | What it's for |
| --- | --- |
| `explore` | A fast fact check of your requirements against the repo, plus suggestions from its own research. Anything the repo doesn't already use gets looked up and cited, never recalled. |
| `generate-spec` · `plan` | Turn the request into one spec, then a phased plan the implementers actually follow. |
| `fact-check` | Hunts hallucinations in specs and plans *before* either reaches you for approval, so nobody downstream gets false instructions. Its `PASS` is what unlocks the approval gate. |
| `implement` · `write-test` | The two that build your requirements and cover them. |
| `code-reviewer` | Makes sure the implementers know what they're doing, and stops them going haywire. Loops until clean. |
| `execution-path-analyzer` | Enumerates the branches first, so tests are written against real paths instead of guesses. |
| `module-documentation` | A brief write-up of how each method works, refreshed as the final step. |
| `prompt-generation` | CoT-following prompt authoring — for when the thing you're building is itself an agent. |

How they run, end to end — approval gates on the spec and the plan, a review loop per phase, tests and docs
only on request (the full picture, with what enforces each gate, is in [Architecture](docs/architecture.md)):

```mermaid
flowchart LR
    E["explore"] --> S["generate-spec"] --> F1["fact-check"] --> A1{"spec<br/>approval"} --> P["plan"] --> F2["fact-check"] --> A2{"plan<br/>approval"} --> I["implement<br/>(per phase)"]
    I <-- "loops until clean" --> R["code-reviewer"]
    R --> C{"closing gate<br/>(opt-in)"}
    C -- tests --> X["execution-path-analyzer"] --> W["write-test"] <--> R2["code-reviewer"]
    C -- docs --> D["module-documentation"]
```

**Model router** - driving your subagents at the most efficient model. See [Model routing](docs/model-routing.md)

**A cross-harness hub** — one loopback HTTP MCP daemon per machine that lets your interactive sessions on
different harnesses message each other and hand each other tasks by *address* (paths into the shared session
dir), not by re-serialized context. Delegate a phase to the harness best suited for it, end your turn, and get
woken when the result lands — no third-party model proxy, no polling. See [The cross-harness hub](docs/hub.md)

**Tools and hooks** — strict guardrails that prevent the subagents from going haywire, and tools
that helps them learn and improve, just like humans :p

## Documentation

- [Philosophy](docs/philosophy.md)
- [Installation](docs/installation.md)
- [Architecture](docs/architecture.md)
- [Agents](docs/agents.md)
- [Harness limitations](docs/harness-limitations.md)
- [Model routing](docs/model-routing.md)
- [The cross-harness hub](docs/hub.md)
- [Tested models](docs/tested-models.md)
- [Definition authoring](docs/definitions.md)
- [Extending & publishing](docs/extending.md)

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

# Antigravity CLI only
curl -fsSL https://raw.githubusercontent.com/diepquynh/ultracode/main/install.sh | bash -s -- antigravity
```

Uninstall with the same harness argument (default `all` unregisters every harness and removes the checkout):

```bash
curl -fsSL https://raw.githubusercontent.com/diepquynh/ultracode/main/uninstall.sh | bash
```

See [Installation](docs/installation.md) for manual installation and uninstall.

## Usage

| Action | Claude Code | Grok Build | Codex | Antigravity |
| --- | --- | --- | --- | --- |
| Initialize the current repository | `/init-kit` | `/init-kit` | `$init-kit` | `/init-kit` |
| Explicitly activate the pipeline router | `/ultracode:orchestrate` | `/ultracode:orchestrate` | `$orchestrate` | `/ultracode:orchestrate` |
| Explicitly activate the prompt-authoring standard | `/ultracode:meta-author` | `/ultracode:meta-author` | `$meta-author` | `/ultracode:meta-author` |
| Toggle unattended autonomy (YOLO) for a session | `/ultracode:yolo on\|off\|status` | `/ultracode:yolo on\|off\|status` | `$yolo on\|off\|status` | `/ultracode:yolo on\|off\|status` |
| Invoke a generated project skill | `/<skill-name>` | `/<skill-name>` | `$<skill-name>` | `/<skill-name>` |
| Reload newly generated project skills | `/reload-plugins` or restart | Press `r` in `/plugins` or start a new session | Start a new session | Restart agy session |
| Runtime inventory and profile | `.ultracode/` | `.ultracode/` | `.ultracode/` | `.ultracode/` |
| Generated project skills | `.claude/skills/` | `.grok/skills/` | `.agents/skills/` | `.agents/skills/` |

Generated Ultracode artifacts can be committed to your repository (except sessions artifacts), so you don't need
to worry about handover or moving to a new machine.

## Use multiple harnesses in one Ultracode session

An Ultracode session is its **artifact directory** — `.ultracode/session/ultracode-session-<id>`, holding the
specs, plans, reports, and pipeline gates — not any harness's chat history. Any harness that resolves that
directory can carry the pipeline forward. That lets a frontier-model harness handle exploration, planning, and
spec generation, then hand implementation to a cheaper harness that is still effective at coding — without
copying artifacts or starting a second Ultracode run.

There are two ways to get a second harness into a session: the [cross-harness hub](docs/hub.md) — the primary
path — or launching both harnesses with the same native session ID, the manual fallback for when you'd rather
not run the hub daemon.

### With the hub (recommended): delegate and adopt

Open a session on the harness you want doing the work and run `/ultracode:hub-listen`; the orchestrating
session publishes tasks to it and gets woken when they complete. No session IDs are copied anywhere: the
worker discovers the shared session through the hub and **adopts** it (`ultracode_session_adopt`), which
authorizes the worker's own native session to work inside a session directory it did not create.

```mermaid
flowchart TD
    ORCH["Orchestrating session — /ultracode:orchestrate<br/>registers with the hub at session start"] -- "task_publish: addresses into<br/>its session dir, never content" --> HUB["cross-harness hub<br/>one loopback daemon per machine"]
    WORK["Worker session on any harness —<br/>/ultracode:hub-listen: register,<br/>drain the queue, park msg_wait, end turn"] --- HUB
    HUB -- "wake notice<br/>(push or long-poll)" --> WORK
    WORK --> ADOPT["ultracode_session_query → pick the shared session →<br/>ultracode_session_adopt authorizes it<br/>for this native session"]
    ADOPT --> RUN["worker runs the delegated stage IN the shared dir —<br/>recorded spec/plan approvals hold, so a plan-gated<br/>stage spawns without re-approval"]
    RUN -- "task_complete<br/>(report path)" --> HUB
    HUB -- "wake notice —<br/>no polling in between" --> ORCH
```

Because adoption is hub-authorized rather than ID-inherited, it also covers what the shared-ID trick never
could: Codex and Antigravity joining a session they didn't start, and **resume** — a session whose original
harness broke is still listed by `ultracode_session_query`, so another harness adopts it by ID and continues
from its recorded stage. Add a `harnesses` block to `repo-profile.json` and the orchestrator decides "spawn
here" vs "publish a hub task" per stage automatically — see the Harness routing section of
[the hub docs](docs/hub.md).

### Without the hub: share the native session ID

Ultracode derives the session directory from the harness's native session ID, so two harnesses launched from
the same repository with the same ID resolve the same directory. The setup path depends on whether the
harness that starts the session can choose its own ID:

```mermaid
flowchart TD
    PICK{"Which harness starts<br/>the shared session?"}
    PICK -- "Claude Code / Grok Build:<br/>accept a custom UUID" --> MINT["Terminal 1 — launch with a chosen UUID:<br/>claude --session-id 550e8400-e29b-41d4-a716-446655440000"]
    MINT --> JOINA["Terminal 2 — same repository root, exact same UUID:<br/>grok --session-id 550e8400-e29b-41d4-a716-446655440000"]
    PICK -- "Codex / Antigravity (agy):<br/>cannot choose a new session's ID" --> INIT["Start codex or agy first<br/>and initialize Ultracode"]
    INIT --> COPY["Copy the ID from the resulting<br/>.ultracode/session/ultracode-session-&lt;id&gt; path"]
    COPY --> JOINB["Start Claude Code or Grok Build from the same repository<br/>with --session-id &lt;that id&gt; — it inherits and continues<br/>the existing Ultracode session"]
    JOINA --> SHARED["Both harnesses resolve the same session dir:<br/>specs, plans, reports, and pipeline gates shared"]
    JOINB --> SHARED
```

Claude Code and Grok Build require the supplied value to be a valid UUID; when reopening a conversation
that already exists in that harness, use its `--resume <id>` option instead of `--session-id`.

### Either way

Hand ownership over at clear phase boundaries and tell the receiving harness to continue from the existing
approved spec or plan. Do not run the same phase against the same repo from two harnesses at once: they share
both the working tree and session state. See
[How the agents communicate](docs/architecture.md#how-the-agents-communicate) for the session layout.

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
