# Model routing

Ultracode decides which model runs each subagent, per repo, from a block you edit once. You do not say "use
the cheap one for this" in a prompt, and the orchestrator has no say in it. A hook applies the route on every
spawn and refuses spawns that do not match.

This is where the cost moves. Research, spec, and plan are a small fraction of a session's tokens and benefit
most from an expensive model. Implementation is the bulk of the volume and, given a precise plan, does not.
Routing lets you spend accordingly without thinking about it again.

## Settings

Model settings live in `.ultracode/repo-profile.json`, under `models`. `/init-kit` writes the defaults during
repository initialization:

```json
"models": {
  "byAgent": {
    "explore": "advanced",
    "generate-spec": "advanced",
    "plan": "advanced",
    "fact-check": "advanced",
    "code-reviewer": "balanced",
    "execution-path-analyzer": "balanced",
    "module-documentation": "advanced",
    "prompt-generation": "advanced"
  },
  "byPhaseComplexity": {
    "implementer": { "low": "fast", "medium": "fast", "high": "balanced" },
    "write-test":  { "low": "fast", "medium": "fast", "high": "balanced" }
  }
}
```

Routing works in two ways:

- **By agent.** For subagents that always run on one model.
- **By phase complexity.** For `implementer` and `write-test`, whose model is chosen per plan phase by that
  phase's complexity tier.
- **Pinned.** `hub-wait` always runs on the `fast` tier. It relays hub messages and decides nothing, so the
  router ignores the profile for it: it is never denied for a missing route, and a `byAgent` entry for it has
  no effect. A caller-supplied `model` that differs from the tier's model is still denied, like any other
  spawn.

The hook re-reads the file on every spawn, so an edit takes effect on the next one. No restart, no reload.

## Model naming

| Value | Meaning |
| --- | --- |
| `"fast"` / `"balanced"` / `"advanced"` / `"frontier"` | A neutral tier, resolved to a concrete model for whichever harness is running. The normal case. |
| `"gpt-5.6-sol"` | A concrete model name. Names that belong to another harness's tier get translated (see below). Anything else is passed through as written. |
| `{ "claude": "…", "codex": "…" }` | Pick the model per harness explicitly, with no translation. For when your backends do not line up with the tiers. |
| `"default"` | The tier baked into the agent's own definition. An explicit "I looked at this and the default is fine." |
| `"inherit"` | Leave the spawn's model alone: whatever the harness would have used, including a model the caller passed. |

`"default"` and `"inherit"` exist so that "I meant this" and "I forgot this" do not look the same. Once a
profile exists, a missing route is an error.

## Complexity tiers

`plan` writes a `**Complexity:** low`, `medium`, or `high` line into each phase file. The router reads that
line from the phase file the spawn names and uses it as the key into `byPhaseComplexity`.

If there is no phase file (an inline fix with no plan behind it), the tier is `low`. Work small enough to skip
planning is work small enough for the cheap tier.

So a phase full of DTOs and config runs on `fast`, and the phase that touches the money runs on `balanced`,
without you classifying anything by hand. The planner made that judgement at plan time, in writing, where you
saw it at the approval gate.

## Guardrails

The router denies rather than guessing. In roughly the order you will meet them:

**No route for an agent.**

```
ultracode: /repo/.ultracode/repo-profile.json has no model route for code-reviewer;
set a tier, "default", or "inherit" explicitly.
```

You added an agent, hand-edited the block, or your profile predates an agent that now exists. Add the key.

**A caller passed a model that does not match.**

```
ultracode: spawn model "sonnet" does not match the routed model "opus" for plan.
Omit model, or re-spawn with model: opus — the profile owns this route.
```

The orchestrator is supposed to omit `model` entirely and let the hook fill it in. If you see this, re-spawn
with exactly the model the denial names, or with no model at all.

Why is this a denial instead of a silent correction? Because a silent correction does not hold. Grok treats a
`model` the caller passed as an explicit user override and keeps it even after the hook's `updatedInput` is
applied. A rewrite would look like it worked and bill you at the wrong tier with no warning. So the spawn
fails instead, visibly.

**A broken profile or an unresolvable route.** `repo-profile.json` is not valid JSON, or a route's value is
empty, or a per-harness object has no entry for the harness you are on. All are refused with "refusing an
unenforced spawn."

A spawn that runs without a resolved route is a spawn whose cost nobody chose. Those are the ones that get
expensive without anyone noticing.

## Exceptions

`initializer` and `fact-check` are the only agents a missing route does not stop.

`initializer` is spawned by `/init-kit`, not the orchestrator, and that command picks the model per mode. The
seeded profile carries no `initializer` key on purpose. Denying on a missing route would break every
re-initialization of an already-initialized repo. Add a key by hand if you want to override the per-mode
choice.

`fact-check` is exempt for a duller reason: it became a mandatory gate after some profiles were already
written. Without the exemption, every one of those repos would start failing at spec approval until someone
re-ran `/init-kit`. This affects only which model runs it, never whether it runs. The `ultracode_gate` tool
refuses to record approval without a `PASS` regardless.

## What happens on a spawn

```mermaid
flowchart TD
    FIRE["hook fires on every agent spawn<br/>(PreToolUse, matcher Task|Agent)"] --> DECODE["HookContext decodes the call into a list of canonical spawn entries.<br/>A flat Claude/Codex/Grok call = one-entry list.<br/>Antigravity's Subagents[] stays a complete list"]
    DECODE --> UC{"for each entry:<br/>an Ultracode agent?"}
    UC -- no --> UNTOUCHED["left untouched"]
    UC -- yes --> PROFILE["resolve the work repo from the entry's Repo root: line,<br/>read its .ultracode/repo-profile.json"]
    PROFILE --> LOOKUP{"agent/phase route<br/>found and resolvable?"}
    LOOKUP -- "no, and the agent is not exempt" --> DENY1["DENY:<br/>refusing an unenforced spawn"]
    LOOKUP -- yes --> CONC["resolve the route to a concrete model<br/>for the active harness"]
    CONC --> OVERRIDE{"caller passed a model<br/>for this entry?"}
    OVERRIDE -- "yes, canonicalized,<br/>and it mismatches" --> DENY2["DENY the whole spawn call"]
    OVERRIDE -- "no, or it matches" --> ACC["accumulate the entry's model/prompt patch"]
    ACC --> EMIT["emit ONE harness-native rewrite:<br/>every entry receives its own repo brief;<br/>Antigravity entries also receive the identity and<br/>primary-repo stamps their nested hooks recover"]
```

The final rewrite step also writes part of the prompt. The model router does this because `PreToolUse` hooks
do not compose. With two hooks on the same matcher, both see the original tool input and exactly one hook's
`updatedInput` survives. The other is discarded whole. So a second hook editing an agent spawn would silently
drop the routed model, and routing is deny-on-missing precisely because unenforced spawns are not acceptable.
There is exactly one safe place to rewrite an agent spawn, and this is it. If you add spawn-time behaviour, it
goes in `model-router.js` too, however unrelated it feels.

## Cross-harness translation

Codex's `spawn_agent` schema accepts only lowercase letters, digits, and underscores. Generated Codex roles
and spawn instructions therefore use names prefixed `ultracode_`, such as `ultracode_fact_check`. The harness
adapter normalizes those aliases back to the canonical `fact-check` before routing and policy lookup. Claude
and Grok keep `ultracode:{agent}`. Antigravity uses `ultracode-{agent}`.

**Codex is routed dynamically like every other harness**, through the injected spawn argument, with the role
TOMLs kept model-free on purpose. The chain, confirmed in source on 2026-08-30 (openai/codex@main):

- The v2 `spawn_agent` args struct carries `model` unconditionally. The `expose_spawn_agent_model_overrides`
  feature flag only hides it from the tool schema, so a hook-injected key still parses.
- The handler applies it with no feature gate (`apply_requested_spawn_agent_model_overrides`).
- The role layer overwrites `config.model` only when the role file has one (`agent/role.rs`
  `build_next_config`). A role-file model would override the argument unconditionally, which is why the
  generated TOMLs must never carry one.
- The router (dispatch confirmed live 2026-08-30; re-trust in `/hooks` after matcher updates) injects the
  resolved route as the spawn's `model` and pins `fork_turns: "none"`. Codex treats an absent `fork_turns` as
  `"all"`.

Two codex caveats. First, the handler validates the injected name against codex's own model list and fails
the spawn on an unknown name. A route pointing at a custom gateway model codex has never heard of breaks the
spawn there, visibly. Second, a role with no model inherits the spawner's model (measured: a sol orchestrator
ran every leaf on sol). So if the hooks are not running (untrusted, or a stale plugin cache), nothing
re-routes and every leaf silently bills at the orchestrator's tier. On codex, working hooks are what the
routing economics depend on. With OpenAI models the spawn message itself is end-to-end encrypted, so the
router never touches the prompt on codex. The repo brief would corrupt the ciphertext. Contract enforcement
runs through `ultracode_spawn_ticket` instead (see harness-limitations.md).

**Grok Build routes the same way** (confirmed in source 2026-08-30, xai-org/grok-build@main). The spawn tool's
input has a first-class `model` slug field, the router's `updatedInput` rewrite carries it, and the generated
agent files stay model-free so the definition never outranks the profile. Two grok caveats mirror codex's.
First, a `TaskModelValidator` checks the slug before spawn, so a route naming a model grok does not serve
fails the spawn visibly. Second, grok schema-validates every hook rewrite and blocks the call on an unusable
one. That is why the router's patch must add nothing beyond what `TaskToolInput` declares (no `fork_turns` on
grok), and why the rewrite lives only in `hookSpecificOutput.updatedInput`. As on codex, if the hooks are not
running, a model-less spawn inherits the parent's model and nothing re-routes.

The generated routing table carries the tier-to-model map for the harness it was built for, plus aliases from
every other harness's model names to the local equivalent. Write `"opus"` in a profile and run it on Codex,
and you get that harness's advanced model. A name shared by several tiers resolves through the last tier in
the mapping that lists it, so `gpt-5.6-sol`, which `advanced` and `frontier` share, translates as `frontier`.
A name that belongs to no tier is passed through untouched, so pointing a route at something the mapping has
never heard of still works.

This matters because the profile is a committed file. One repo, one `models` block, a team split across
Claude Code and Codex, and nobody maintains two copies.

## Initialization

On a repo that has not been initialized, every agent falls back to the default tier from its own definition.
That is what lets `/init-kit` run on a fresh checkout. The strictness switches on only once there is a
profile to be strict about.

## Limitations

`effort` is not routable. It is a subagent-definition field. There is no per-invocation `effort` argument on
the spawn tool and no environment variable for it. Claude and Grok carry it in agent front matter, and Codex
carries it as `model_reasoning_effort` in the role TOML. Whatever is written there holds no matter which tier
the router picks. Changing it means editing the definition and regenerating.

The generated agent files omit `model` on Codex and Grok on purpose. A role-level model setting outranks the
spawn argument on those harnesses, which would hand the definition a decision the profile is supposed to own.
Claude agents keep their front-matter default. That is what the router falls back to when a route says
`"default"` or there is no profile at all.

## Choosing your own tiers

The defaults are a starting point, not a recommendation for your setup. The block is per-repo and per-agent
because not everyone runs Anthropic-hosted models. A tier can point at a gateway, a proxy, Bedrock, Vertex,
or whatever else you serve, and the right answer depends on what that costs you.

[Tested models](tested-models.md) holds the field notes: what each model was like in each role, from real
sessions rather than a leaderboard. Start there, then tune the block against your own bill.
