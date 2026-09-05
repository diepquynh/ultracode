# ultracode bench

Measures what the pipeline costs, from transcripts of sessions that already ran.

ultracode's premise is that spending tokens on purpose beats spending them by accident. That claim needs
numbers behind it, and it is easy to "optimize" a pipeline into being cheaper and worse. This tool lets every
change to the plugin be checked against real history instead of intuition.

```bash
node bench/ultracode-bench.js                        # measure and print
node bench/ultracode-bench.js --save base.json       # record a baseline
node bench/ultracode-bench.js --baseline base.json   # compare against it
node bench/ultracode-bench.js --agent implementer    # one agent only
node bench/ultracode-bench.js --since 2026-08-01     # recent sessions only
node bench/ultracode-bench.js --baseline base.json --fail-on-regression   # CI gate
```

## What it reads

Claude Code records the main conversation at `~/.claude/projects/<project>/<session>.jsonl` and each subagent
run at `.../<session>/subagents/agent-<agentId>.jsonl`.

A subagent transcript does not record which agent type it is. The only reliable attribution is the parent's
`Agent` or `Task` tool call, which carries `subagent_type`, paired with the tool result that echoes
`agentId: <id>`. `lib/transcripts.js` rebuilds that mapping before measuring anything.

Guessing the agent type from the spawn prompt's text does not work, and it fails in a way that looks like
success. Orchestrators write freeform prompts, and a `Session dir: …/ultracode/session/…` line makes a naive
`/ultracode[:/](\w+)/` match report the agent type as `session`. On the reference corpus that mistake
attributed 800 of 1158 runs to an agent that does not exist.

Runs whose `subagent_type` is not `ultracode:*` are skipped. Other agents working in the same repo are not
this pipeline's cost, and including them dilutes every ratio.

Renamed agents are folded into one bucket. A run carries whatever name it was spawned under, so the corpus
holds both `ultracode:implement` and `ultracode:implementer` for the same role. `RENAMED_AGENTS` in
`lib/transcripts.js` maps the old name to the current one before anything is grouped, and `--agent` accepts
either spelling. Add a row there whenever an agent is renamed. Skip it and the rename alone halves the run
count and takes every median over the wrong sample.

## The metrics, and why each one

**`cacheReadPerToolCall`** is the headline number. Cache reads dominate spend, and they bill resident context
times turns, so the marginal cost of one more tool call is roughly one whole resident context. This metric
converts "how many round-trips does a stage take" into tokens. It is the number most design choices move.

**Read composition and `overheadShare`** show how much of what subagents read is the repo's code versus
ultracode's own scaffolding (routing tables, session documents). Overhead is not waste by itself, since the
pipeline needs its own state. It becomes waste when it crowds out the code the agent came to read.

**Redundancy** counts the same file read again by a different subagent in the same session. Each subagent has
a private context, so a file read by N subagents is paid N times. It is reported separately for all reads and
for routing files, because the fixes differ.

**Preamble (`pre`, `pre%`)** counts tool calls before the first mutation, for agents that mutate. A high
preamble means the agent spends its budget discovering context it could have been handed.

**Build loops** report the longest run of consecutive failing build or test commands, and the cache reads
burned by runs that exceed the threshold. Detection is strict on purpose (see `BUILD_FAILED` in
`lib/metrics.js`). A looser pattern counts builds that merely print the word "error" and inflates the result.
Expect this number to be lower, and more trustworthy, than a hand-rolled grep suggests.

**Search quality** reports the call count and the share of searches returning nothing. It is worth watching
mainly to avoid a wrong fix. On the reference corpus only about 1% of searches came back empty, so search
precision was never the problem, and "make grep smarter" would have optimized nothing. The cost was the
number of round-trips, not their hit rate.

**Tool errors** are grouped by cause. `Edit:string-not-found` and `Read:missing-path` indicate an agent
working from stale or guessed context. `Skill:unknown` is a configuration bug, not a model failure: per-repo
skills under `.claude/skills/` are not resolvable by the Skill tool, so they must be routed by the
`skills[].path` entries in `repo-profile.json`.

## Reading a comparison honestly

`--baseline` reports only the metrics in `LOWER_IS_BETTER`. A metric moving is not the same as a metric
mattering:

- Redundancy and preamble fall trivially if agents simply do less work. Read them next to the error rate and
  next to whether the pipeline still completed its phases.
- Small corpora move a lot on one unusual session. `--since` and `--agent` narrow the comparison, but a
  handful of runs cannot support a percentage claim.
- Detection strictness changes absolute values. Comparing a baseline recorded under different detection rules
  to a fresh run measures the rule change, not the pipeline.
