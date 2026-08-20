# ultracode bench

Measures what the pipeline actually costs, from transcripts of sessions that already ran.

ultracode's premise is that spending tokens deliberately beats spending them accidentally. That is
only a defensible claim with numbers attached, and it is easy to "optimize" a pipeline into being
cheaper and worse. This harness exists so every change to the plugin can be checked against real
history rather than intuition.

```bash
node bench/ultracode-bench.js                        # measure and print
node bench/ultracode-bench.js --save base.json       # record a baseline
node bench/ultracode-bench.js --baseline base.json   # compare against it
node bench/ultracode-bench.js --agent implement      # one agent only
node bench/ultracode-bench.js --since 2026-08-01     # recent sessions only
node bench/ultracode-bench.js --baseline base.json --fail-on-regression   # CI gate
```

## What it reads

Claude Code records the main conversation at `~/.claude/projects/<project>/<session>.jsonl` and each
subagent run at `.../<session>/subagents/agent-<agentId>.jsonl`.

A subagent transcript does not record which agent type it is. The only authoritative attribution is
the parent's `Agent`/`Task` tool call — which carries `subagent_type` — paired with the tool result
that echoes `agentId: <id>`. `lib/transcripts.js` rebuilds that mapping before measuring anything.

Guessing the agent type from the spawn prompt's text does not work, and fails in a way that looks
like it worked: orchestrators write freeform prompts, and a `Session dir: …/ultracode/session/…`
line makes a naive `/ultracode[:/](\w+)/` match report the agent type as `session`. On the reference
corpus that mistake attributed 800 of 1158 runs to a nonexistent agent.

Runs whose `subagent_type` is not `ultracode:*` are skipped: other agents working in the same repo
are not this pipeline's cost, and including them dilutes every ratio.

## The metrics, and why each one

**`cacheReadPerToolCall`** — the headline. Cache-read dominates spend, and it bills resident context
× turns, so the marginal cost of one more tool call is roughly one whole resident context. This
converts "how many round-trips does a stage take" into tokens, and it is the number most design
choices actually move.

**Read composition and `overheadShare`** — how much of what subagents read is the repo's code versus
ultracode's own scaffolding (routing tables, session documents). Overhead is not waste by itself; the
pipeline needs its own state. It becomes waste when it crowds out the code the agent came to read.

**Redundancy** — the same file read again by a different subagent in the same session. Each subagent
has a private context, so a file read by N subagents is paid N times. Reported separately for all
reads and for routing files, because the fixes differ.

**Preamble (`pre`, `pre%`)** — tool calls before the first mutation, for agents that mutate. High
preamble means the agent is spending its budget discovering context it could have been handed.

**Build loops** — the longest run of consecutive failing build/test commands, and the cache-read
burned by runs that exceed the threshold. Detection is deliberately strict (see `BUILD_FAILED` in
`lib/metrics.js`); a looser pattern counts builds that merely print the word "error" and inflates the
result. Expect this number to be lower, and more trustworthy, than a hand-rolled grep suggests.

**Search quality** — call count and the share returning nothing. Worth watching mainly to *avoid* a
wrong fix: on the reference corpus only ~1% of searches came back empty, so search precision was
never the problem and "make grep smarter" would have optimized nothing. The cost was the number of
round-trips, not their hit rate.

**Tool errors** — grouped by cause. `Edit:string-not-found` and `Read:missing-path` indicate an agent
working from stale or guessed context. `Skill:unknown` is a configuration bug, not a model failure:
per-repo skills under `.claude/skills/` are not resolvable by the Skill tool, so they must be routed
by `repo-profile.json` `skills[].path`.

## Reading a comparison honestly

`--baseline` reports only the metrics in `LOWER_IS_BETTER`, and a metric moving is not the same as a
metric mattering:

- Redundancy and preamble fall trivially if agents simply do less work. Read them next to error rate
  and to whether the pipeline still completed its phases.
- Small corpora move a lot on one unusual session. `--since` and `--agent` narrow the comparison, but
  a handful of runs cannot support a percentage claim.
- Detection strictness changes absolute values. Comparing a baseline recorded under different
  detection rules to a fresh run measures the rule change, not the pipeline.
