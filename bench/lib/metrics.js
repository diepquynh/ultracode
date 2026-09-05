#!/usr/bin/env node
// Metric extraction for the ultracode bench harness.
//
// Every metric here is chosen because it maps to a lever the plugin can actually
// pull, and because it is recoverable from recorded transcripts alone — the bench
// replays history, so a change can be measured against runs that already happened
// instead of needing a fresh instrumented corpus.
//
// The headline denominator is `cacheReadPerToolCall`. Cache-read dominates token
// spend (2.95B of 3.45B in the reference corpus) and it bills resident context ×
// turns, so the marginal cost of one extra tool call is roughly one full resident
// context. That single ratio is why "tool calls to first mutation" and "read
// redundancy" are worth tracking at all: they are the two biggest sources of
// avoidable calls.

"use strict";

const path = require("node:path");
const { canonicalAgent, eachJsonLine, resultText } = require("./transcripts");

// Files that are ultracode's own scaffolding rather than the repo's code. Reads
// of these are overhead: necessary, but the pipeline controls how much it costs.
const ROUTING_FILE = /(INVENTORY\.md|repo-profile\.json|SKILL\.md|CLAUDE\.md|AGENTS\.md|[\\/]skills[\\/])/;
// `implement` (not `implementer`) so runs recorded before the agent was renamed
// still classify: the shorter stem matches both artifact prefixes.
const SESSION_DOC = /ultracode-(spec|plan|phase|research|criteria|implement|epa|review|scout|write|module|findings)/i;
const MUTATION_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);
const SEARCH_SHELL = /(^|[\s|;&(])(rg|grep|find|fd|ack)\b/;

function emptyRun() {
  return {
    file: null,
    agent: null,
    parentSession: null,
    toolCalls: 0,
    byTool: {},
    // context composition, in bytes of tool output actually returned
    routingBytes: 0,
    routingReads: 0,
    routingPaths: {},
    sessionDocBytes: 0,
    sourceBytes: 0,
    searchBytes: 0,
    searchCalls: 0,
    searchEmpty: 0,
    readPaths: {},
    // preamble
    firstMutationAt: null,
    // failure surface
    errors: 0,
    errorKinds: {},
    unknownSkill: 0,
    maxBuildStreak: 0,
    buildCalls: 0,
    buildFailures: 0,
    // spend
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    spawnPromptChars: 0,
    thinkingChars: 0,
  };
}

const BUILD_HINT = /\b(mvnw|mvn|gradlew|gradle|npm|pnpm|yarn|tsc|cargo|dotnet|make|pytest|go (build|test)|uv run)\b/;
// Deliberately strict. A looser pattern (a bare /\bERROR\b/, say) counts a build
// that merely PRINTS the word "error" in a log line as a failure, which inflates
// streak counts. "Exit code N" is the harness's own status line and is the
// primary signal; the named markers cover compound commands that swallow it.
const BUILD_FAILED = /^\s*Exit code [1-9]|BUILD FAILURE|BUILD FAILED|Compilation failure|error TS\d+|FAILURES!|npm ERR!/m;

function classifyError(toolName, text) {
  if (/String to replace not found|old_string|not found in file/i.test(text)) return "Edit:string-not-found";
  if (/has not been read yet|must read|Read the file/i.test(text)) return "Edit:file-not-read";
  if (/File has been modified|modified since read/i.test(text)) return "Edit:stale-read";
  if (/Unknown skill/i.test(text)) return "Skill:unknown";
  if (/no such file|does not exist|ENOENT/i.test(text)) return `${toolName}:missing-path`;
  return toolName;
}

// Parses one subagent transcript into a run record. `spawn` is the linkSpawns()
// entry for this agentId, or null when the parent transcript is unavailable.
async function measureRun(file, spawn) {
  const run = emptyRun();
  run.file = file;
  // Canonical, not raw: summarize() groups on this, and a renamed agent must
  // roll up with its own older runs.
  run.agent = spawn && spawn.subagentType ? canonicalAgent(spawn.subagentType) : null;
  run.parentSession = spawn ? spawn.parentSession : null;
  run.spawnPromptChars = spawn ? spawn.promptChars : 0;

  const pending = new Map();
  let index = 0;
  let buildStreak = 0;

  await eachJsonLine(file, (event) => {
    const message = event.message;
    if (message && message.usage) {
      run.usage.input += message.usage.input_tokens || 0;
      run.usage.output += message.usage.output_tokens || 0;
      run.usage.cacheRead += message.usage.cache_read_input_tokens || 0;
      run.usage.cacheCreate += message.usage.cache_creation_input_tokens || 0;
    }
    const content = message && message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === "thinking") run.thinkingChars += (block.thinking || "").length;

      if (block.type === "tool_use") {
        index += 1;
        run.toolCalls += 1;
        run.byTool[block.name] = (run.byTool[block.name] || 0) + 1;
        pending.set(block.id, { name: block.name, input: block.input || {} });
        if (MUTATION_TOOLS.has(block.name) && run.firstMutationAt === null) {
          run.firstMutationAt = index;
        }
        const command = String((block.input || {}).command || "");
        if (SEARCH_TOOLS.has(block.name) || (block.name === "Bash" && SEARCH_SHELL.test(command))) {
          run.searchCalls += 1;
        }
        if (block.name === "Bash" && BUILD_HINT.test(command)) run.buildCalls += 1;
      }

      if (block.type === "tool_result") {
        const meta = pending.get(block.tool_use_id);
        if (!meta) continue;
        const text = resultText(block);
        const size = text.length;
        const filePath = meta.input.file_path || "";

        if (meta.name === "Read") {
          run.readPaths[filePath] = (run.readPaths[filePath] || 0) + 1;
          if (ROUTING_FILE.test(filePath)) {
            run.routingReads += 1;
            run.routingBytes += size;
            run.routingPaths[filePath] = (run.routingPaths[filePath] || 0) + 1;
          } else if (SESSION_DOC.test(filePath)) {
            run.sessionDocBytes += size;
          } else {
            run.sourceBytes += size;
          }
        }

        const command = String(meta.input.command || "");
        if (SEARCH_TOOLS.has(meta.name) || (meta.name === "Bash" && SEARCH_SHELL.test(command))) {
          run.searchBytes += size;
          const head = text.trim().slice(0, 200);
          // "Found nothing" has three shapes: a literally empty result (a shell
          // grep exiting 1 prints nothing), the Grep/Glob tools' own phrasing,
          // and a shell error that means the search never ran at all.
          const foundNothing =
            !head ||
            /^(no matches found|no files found)/i.test(head) ||
            /^\(eval\)|command not found|No such file or directory/i.test(head);
          if (foundNothing) run.searchEmpty += 1;
        }

        if (meta.name === "Bash" && BUILD_HINT.test(command)) {
          if (BUILD_FAILED.test(text.slice(0, 4000)) || block.is_error) {
            run.buildFailures += 1;
            buildStreak += 1;
            if (buildStreak > run.maxBuildStreak) run.maxBuildStreak = buildStreak;
          } else {
            buildStreak = 0;
          }
        }

        if (block.is_error) {
          run.errors += 1;
          const kind = classifyError(meta.name, text.slice(0, 500));
          run.errorKinds[kind] = (run.errorKinds[kind] || 0) + 1;
          if (kind === "Skill:unknown") run.unknownSkill += 1;
        }
      }
    }
  });

  if (run.firstMutationAt !== null) run.preambleCalls = run.firstMutationAt - 1;
  return run;
}

// Cross-run redundancy: within one orchestrated session each subagent has a
// private context, so the same file read by N subagents is paid N times. This is
// the metric the context brief (W3) is meant to move.
function redundancy(runs) {
  const bySession = new Map();
  for (const run of runs) {
    const key = run.parentSession || "(unknown)";
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(run);
  }
  let firstReads = 0;
  let repeatReads = 0;
  let firstRoutingReads = 0;
  let repeatRoutingReads = 0;
  const fanout = new Map();

  for (const [, sessionRuns] of bySession) {
    const seen = new Set();
    const seenRouting = new Set();
    const readers = new Map();
    for (const run of sessionRuns) {
      for (const [file, count] of Object.entries(run.readPaths)) {
        readers.set(file, (readers.get(file) || 0) + 1);
        for (let i = 0; i < count; i += 1) {
          if (seen.has(file)) repeatReads += 1;
          else firstReads += 1;
          seen.add(file);
        }
      }
      for (const [file, count] of Object.entries(run.routingPaths)) {
        for (let i = 0; i < count; i += 1) {
          if (seenRouting.has(file)) repeatRoutingReads += 1;
          else firstRoutingReads += 1;
          seenRouting.add(file);
        }
      }
    }
    for (const [file, n] of readers) {
      if (n > 1) fanout.set(file, Math.max(fanout.get(file) || 0, n));
    }
  }

  const totalReads = firstReads + repeatReads;
  const totalRouting = firstRoutingReads + repeatRoutingReads;
  return {
    sessions: bySession.size,
    reads: { first: firstReads, repeat: repeatReads, repeatShare: totalReads ? repeatReads / totalReads : 0 },
    routing: {
      first: firstRoutingReads,
      repeat: repeatRoutingReads,
      repeatShare: totalRouting ? repeatRoutingReads / totalRouting : 0,
    },
    topFanout: [...fanout.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

// Rolls per-run records into the report shape. Grouped by agent because the
// levers differ per role: implementer's cost is preamble and build loops, explore's
// is search volume, code-reviewer's is re-reading what implementer already read.
function summarize(runs) {
  const byAgent = new Map();
  for (const run of runs) {
    const key = run.agent || "(unattributed)";
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(run);
  }

  const agents = [];
  for (const [agent, group] of [...byAgent.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const mutating = group.filter((run) => run.firstMutationAt !== null);
    agents.push({
      agent,
      runs: group.length,
      medianToolCalls: median(group.map((r) => r.toolCalls)),
      medianPreamble: median(mutating.map((r) => r.preambleCalls || 0)),
      preambleShare:
        sum(mutating.map((r) => r.preambleCalls || 0)) / Math.max(1, sum(mutating.map((r) => r.toolCalls))),
      medianCacheRead: median(group.map((r) => r.usage.cacheRead)),
      totalCacheRead: sum(group.map((r) => r.usage.cacheRead)),
      totalInput: sum(group.map((r) => r.usage.input)),
      totalOutput: sum(group.map((r) => r.usage.output)),
      routingReads: sum(group.map((r) => r.routingReads)),
      routingMB: sum(group.map((r) => r.routingBytes)) / 1e6,
      sessionDocMB: sum(group.map((r) => r.sessionDocBytes)) / 1e6,
      sourceMB: sum(group.map((r) => r.sourceBytes)) / 1e6,
      searchMB: sum(group.map((r) => r.searchBytes)) / 1e6,
      searchCalls: sum(group.map((r) => r.searchCalls)),
      searchEmpty: sum(group.map((r) => r.searchEmpty)),
      errors: sum(group.map((r) => r.errors)),
      errorsPerRun: sum(group.map((r) => r.errors)) / Math.max(1, group.length),
      unknownSkill: sum(group.map((r) => r.unknownSkill)),
      buildCalls: sum(group.map((r) => r.buildCalls)),
      buildFailures: sum(group.map((r) => r.buildFailures)),
      maxBuildStreak: Math.max(0, ...group.map((r) => r.maxBuildStreak)),
      runsOverStreak5: group.filter((r) => r.maxBuildStreak >= 5).length,
      cacheReadOverStreak4: sum(group.filter((r) => r.maxBuildStreak >= 4).map((r) => r.usage.cacheRead)),
      medianSpawnPromptChars: median(group.map((r) => r.spawnPromptChars)),
    });
  }

  const totals = {
    runs: runs.length,
    toolCalls: sum(runs.map((r) => r.toolCalls)),
    cacheRead: sum(runs.map((r) => r.usage.cacheRead)),
    input: sum(runs.map((r) => r.usage.input)),
    output: sum(runs.map((r) => r.usage.output)),
    cacheCreate: sum(runs.map((r) => r.usage.cacheCreate)),
    routingMB: sum(runs.map((r) => r.routingBytes)) / 1e6,
    sessionDocMB: sum(runs.map((r) => r.sessionDocBytes)) / 1e6,
    sourceMB: sum(runs.map((r) => r.sourceBytes)) / 1e6,
    searchMB: sum(runs.map((r) => r.searchBytes)) / 1e6,
    searchCalls: sum(runs.map((r) => r.searchCalls)),
    searchEmpty: sum(runs.map((r) => r.searchEmpty)),
    errors: sum(runs.map((r) => r.errors)),
    unknownSkill: sum(runs.map((r) => r.unknownSkill)),
    runsOverStreak5: runs.filter((r) => r.maxBuildStreak >= 5).length,
    cacheReadOverStreak4: sum(runs.filter((r) => r.maxBuildStreak >= 4).map((r) => r.usage.cacheRead)),
    spawnPromptChars: sum(runs.map((r) => r.spawnPromptChars)),
  };
  totals.cacheReadPerToolCall = totals.toolCalls ? totals.cacheRead / totals.toolCalls : 0;
  const overheadMB = totals.routingMB + totals.sessionDocMB;
  const allReadMB = overheadMB + totals.sourceMB + totals.searchMB;
  totals.overheadShare = allReadMB ? overheadMB / allReadMB : 0;

  const errorKinds = {};
  for (const run of runs) {
    for (const [kind, count] of Object.entries(run.errorKinds)) {
      errorKinds[kind] = (errorKinds[kind] || 0) + count;
    }
  }

  return { totals, agents, errorKinds, redundancy: redundancy(runs) };
}

module.exports = { measureRun, summarize, redundancy, median, percentile, sum };
