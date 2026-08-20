#!/usr/bin/env node
// ultracode bench — measure the pipeline's real cost from recorded transcripts.
//
// The plugin's whole design bet is that spending tokens deliberately beats
// spending them accidentally. That bet is only checkable with numbers, and every
// number here comes from sessions that already ran: the bench replays transcript
// history rather than requiring a fresh instrumented corpus, so a change can be
// compared against the past on the same footing.
//
// Usage:
//   node bench/ultracode-bench.js                        # measure, print a report
//   node bench/ultracode-bench.js --json out.json        # also write machine output
//   node bench/ultracode-bench.js --baseline base.json   # compare against a saved run
//   node bench/ultracode-bench.js --save base.json       # write a new baseline
//   node bench/ultracode-bench.js --agent implement      # restrict to one agent
//   node bench/ultracode-bench.js --since 2026-08-01     # only sessions modified since
//   node bench/ultracode-bench.js --claude-root DIR      # non-default transcript root
//
// Exit status is 0 unless --fail-on-regression is given and a tracked metric got
// worse than the baseline, so this can gate CI.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  claudeTranscripts,
  linkSpawns,
  agentIdOf,
  parentSessionOf,
} = require("./lib/transcripts");
const { measureRun, summarize } = require("./lib/metrics");

// Metrics where a LOWER number is better, and which --fail-on-regression checks.
const LOWER_IS_BETTER = [
  ["cacheReadPerToolCall", "cache-read tokens per tool call"],
  ["overheadShare", "share of read bytes that is ultracode scaffolding"],
  ["unknownSkill", "Unknown skill errors"],
  ["errors", "errored tool results"],
  ["runsOverStreak5", "runs with a 5+ build-failure streak"],
];

function parseArgs(argv) {
  const options = {
    json: null,
    baseline: null,
    save: null,
    agent: null,
    since: null,
    claudeRoot: null,
    failOnRegression: false,
    top: 15,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--json") options.json = next();
    else if (arg === "--baseline") options.baseline = next();
    else if (arg === "--save") options.save = next();
    else if (arg === "--agent") options.agent = next();
    else if (arg === "--since") options.since = Date.parse(next());
    else if (arg === "--claude-root") options.claudeRoot = next();
    else if (arg === "--top") options.top = Number(next());
    else if (arg === "--fail-on-regression") options.failOnRegression = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const fmt = (n) => Math.round(n).toLocaleString();
const pct = (n) => `${(n * 100).toFixed(1)}%`;

function pad(value, width, align = "right") {
  const text = String(value);
  if (text.length >= width) return text.slice(0, width);
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

function printReport(report, options) {
  const { totals, agents, errorKinds, redundancy } = report;

  console.log("\n=== ultracode bench ===");
  console.log(`subagent runs measured : ${fmt(totals.runs)}`);
  console.log(`tool calls             : ${fmt(totals.toolCalls)}`);
  console.log(
    `tokens                 : ${fmt(totals.cacheRead)} cache-read · ` +
      `${fmt(totals.input)} input · ${fmt(totals.output)} output · ${fmt(totals.cacheCreate)} cache-create`,
  );
  console.log(
    `cache-read / tool call : ${fmt(totals.cacheReadPerToolCall)}   <- marginal cost of one extra round-trip`,
  );

  console.log("\n--- where read bytes go ---");
  const rows = [
    ["project source", totals.sourceMB],
    ["routing + skills", totals.routingMB],
    ["ultracode session docs", totals.sessionDocMB],
    ["search output", totals.searchMB],
  ];
  const allMB = rows.reduce((t, [, mb]) => t + mb, 0) || 1;
  for (const [label, mb] of rows) {
    console.log(`  ${pad(label, 24, "left")} ${pad(mb.toFixed(1), 7)} MB  ${pad(pct(mb / allMB), 7)}`);
  }
  console.log(`  ultracode's own overhead: ${pct(totals.overheadShare)} of all read bytes`);

  console.log("\n--- redundancy (same file re-read by another subagent in one session) ---");
  console.log(
    `  all reads     : ${fmt(redundancy.reads.repeat)} repeats of ${fmt(redundancy.reads.first)} first reads` +
      `  = ${pct(redundancy.reads.repeatShare)} redundant`,
  );
  console.log(
    `  routing files : ${fmt(redundancy.routing.repeat)} repeats of ${fmt(redundancy.routing.first)} first reads` +
      `  = ${pct(redundancy.routing.repeatShare)} redundant`,
  );
  if (redundancy.topFanout.length) {
    console.log("  highest fan-out (distinct subagents reading one file in one session):");
    for (const [file, n] of redundancy.topFanout.slice(0, 6)) {
      console.log(`    ${pad(n, 3)} agents  ${file.replace(process.env.HOME || "~", "~")}`);
    }
  }

  console.log("\n--- per agent ---");
  const header = ["agent", "runs", "calls", "pre", "pre%", "cacheRd/run", "err/run", "?skill", "streak5"];
  const widths = [26, 6, 6, 5, 6, 13, 8, 7, 8];
  console.log(header.map((h, i) => pad(h, widths[i], i === 0 ? "left" : "right")).join(""));
  for (const a of agents) {
    console.log(
      [
        pad(a.agent.replace("ultracode:", ""), widths[0], "left"),
        pad(a.runs, widths[1]),
        pad(a.medianToolCalls, widths[2]),
        pad(a.medianPreamble, widths[3]),
        pad(pct(a.preambleShare), widths[4]),
        pad(fmt(a.medianCacheRead), widths[5]),
        pad(a.errorsPerRun.toFixed(1), widths[6]),
        pad(a.unknownSkill, widths[7]),
        pad(a.runsOverStreak5, widths[8]),
      ].join(""),
    );
  }

  console.log("\n--- build loops ---");
  console.log(`  runs with a 5+ consecutive build-failure streak : ${totals.runsOverStreak5}`);
  console.log(
    `  cache-read burned by runs with a 4+ streak       : ${fmt(totals.cacheReadOverStreak4)}` +
      ` (${pct(totals.cacheRead ? totals.cacheReadOverStreak4 / totals.cacheRead : 0)} of all cache-read)`,
  );

  console.log("\n--- search quality ---");
  console.log(
    `  ${fmt(totals.searchCalls)} search calls, ${fmt(totals.searchEmpty)} returned nothing ` +
      `(${pct(totals.searchCalls ? totals.searchEmpty / totals.searchCalls : 0)})`,
  );

  console.log("\n--- top tool errors ---");
  const kinds = Object.entries(errorKinds).sort((a, b) => b[1] - a[1]).slice(0, options.top);
  for (const [kind, count] of kinds) console.log(`  ${pad(count, 6)}  ${kind}`);
  if (totals.unknownSkill) {
    console.log(
      `  NOTE: ${totals.unknownSkill} "Unknown skill" errors — per-repo skills are not Skill-tool` +
        " resolvable; route by repo-profile.json skills[].path instead.",
    );
  }
}

function flatten(report) {
  const flat = { ...report.totals };
  flat["redundancy.reads.repeatShare"] = report.redundancy.reads.repeatShare;
  flat["redundancy.routing.repeatShare"] = report.redundancy.routing.repeatShare;
  for (const a of report.agents) {
    flat[`agent.${a.agent}.medianPreamble`] = a.medianPreamble;
    flat[`agent.${a.agent}.medianCacheRead`] = a.medianCacheRead;
    flat[`agent.${a.agent}.errorsPerRun`] = a.errorsPerRun;
  }
  return flat;
}

function compare(report, baselinePath) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
  const now = flatten(report);
  const before = flatten(baseline);
  console.log(`\n=== vs baseline (${path.basename(baselinePath)}) ===`);
  let regressed = 0;
  for (const [key, label] of LOWER_IS_BETTER) {
    if (!(key in before) || !(key in now)) continue;
    const from = before[key];
    const to = now[key];
    if (!from && !to) continue;
    const delta = to - from;
    const relative = from ? delta / from : to ? 1 : 0;
    const better = delta <= 0;
    if (!better && Math.abs(relative) > 0.01) regressed += 1;
    const arrow = better ? "improved" : "REGRESSED";
    const shape = (v) => (v > 0 && v < 1 ? pct(v) : fmt(v));
    console.log(
      `  ${pad(arrow, 10, "left")} ${pad(label, 46, "left")} ${shape(from)} -> ${shape(to)}` +
        ` (${delta > 0 ? "+" : ""}${(relative * 100).toFixed(1)}%)`,
    );
  }
  return regressed;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    console.error(`ultracode-bench: ${error.message}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(fs.readFileSync(__filename, "utf-8").split("\n").slice(1, 21).join("\n"));
    return 0;
  }

  const roots = claudeTranscripts(options.claudeRoot || undefined);
  if (!roots.main.length && !roots.subagents.length) {
    console.error("ultracode-bench: no transcripts found — pass --claude-root DIR");
    process.exit(2);
  }

  process.stderr.write(
    `linking spawns across ${roots.main.length} session transcripts...\n`,
  );
  const spawns = await linkSpawns(roots.main);

  let subagentFiles = roots.subagents;
  if (options.since) {
    subagentFiles = subagentFiles.filter((f) => {
      try {
        return fs.statSync(f).mtimeMs >= options.since;
      } catch {
        return false;
      }
    });
  }

  const runs = [];
  let scanned = 0;
  for (const file of subagentFiles) {
    const spawn = spawns.get(agentIdOf(file)) || null;
    const type = spawn && spawn.subagentType;
    // Only ultracode's own subagents — other agents in the same repo are not
    // this pipeline's cost and would dilute every ratio.
    if (!type || !type.startsWith("ultracode:")) continue;
    if (options.agent && type !== `ultracode:${options.agent}` && type !== options.agent) continue;
    scanned += 1;
    if (scanned % 200 === 0) process.stderr.write(`  measured ${scanned} runs\n`);
    const run = await measureRun(file, {
      ...spawn,
      parentSession: spawn.parentSession || parentSessionOf(file),
    });
    runs.push(run);
  }

  if (!runs.length) {
    console.error("ultracode-bench: no ultracode subagent runs matched the filters");
    process.exit(2);
  }

  const report = summarize(runs);
  report.generatedAt = new Date().toISOString();
  printReport(report, options);

  if (options.json) {
    fs.writeFileSync(options.json, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${options.json}`);
  }
  if (options.save) {
    fs.writeFileSync(options.save, JSON.stringify(report, null, 2));
    console.log(`wrote baseline ${options.save}`);
  }
  if (options.baseline) {
    const regressed = compare(report, options.baseline);
    if (regressed && options.failOnRegression) {
      console.error(`\nultracode-bench: ${regressed} tracked metric(s) regressed`);
      process.exit(1);
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code || 0),
  (error) => {
    console.error(`ultracode-bench: ${error.stack || error.message}`);
    process.exit(2);
  },
);
