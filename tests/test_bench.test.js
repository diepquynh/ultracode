#!/usr/bin/env node
// Bench agent attribution across a rename. `RENAMED_AGENTS` in
// bench/lib/transcripts.js documents why the two spellings have to share a
// bucket; this checks that they do, end to end from a transcript to a report row.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { RENAMED_AGENTS, canonicalAgent } = require("../bench/lib/transcripts");
const { measureRun, summarize } = require("../bench/lib/metrics");

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-bench-"));

test.after(() => fs.rmSync(WORKSPACE, { recursive: true, force: true }));

// One subagent transcript with a single Read, enough for measureRun to produce a
// run record whose only interesting field here is the agent it is attributed to.
function transcript(name) {
  const file = path.join(WORKSPACE, `agent-${name}.jsonl`);
  const lines = [
    {
      message: {
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/src/App.ts" } }],
      },
    },
    {
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "export const a = 1;\n" }],
      },
    },
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}

test("canonicalAgent folds a renamed agent onto its current name", () => {
  assert.equal(canonicalAgent("implement"), "implementer");
  assert.equal(canonicalAgent("ultracode:implement"), "ultracode:implementer");
  // Already-current names and unrenamed agents pass through untouched.
  assert.equal(canonicalAgent("implementer"), "implementer");
  assert.equal(canonicalAgent("ultracode:implementer"), "ultracode:implementer");
  assert.equal(canonicalAgent("ultracode:write-test"), "ultracode:write-test");
  assert.equal(canonicalAgent("code-reviewer"), "code-reviewer");
  // The prefix is preserved either way, so report and baseline keys keep shape.
  assert.equal(canonicalAgent(""), "");
  assert.equal(canonicalAgent(null), "");
});

test("every RENAMED_AGENTS target is itself a current name", () => {
  for (const [from, to] of RENAMED_AGENTS) {
    assert.notEqual(from, to, `${from}: a rename must change the name`);
    assert.ok(!RENAMED_AGENTS.has(to), `${to}: rename targets must not chain`);
  }
});

test("pre-rename and post-rename runs roll up into one agent row", async () => {
  const spawn = (subagentType) => ({ subagentType, parentSession: "session-1", promptChars: 0 });
  const runs = await Promise.all([
    measureRun(transcript("old"), spawn("ultracode:implement")),
    measureRun(transcript("new"), spawn("ultracode:implementer")),
    measureRun(transcript("tests"), spawn("ultracode:write-test")),
  ]);
  assert.deepEqual(
    runs.map((r) => r.agent),
    ["ultracode:implementer", "ultracode:implementer", "ultracode:write-test"],
  );

  const report = summarize(runs);
  const names = report.agents.map((a) => a.agent).sort();
  assert.deepEqual(names, ["ultracode:implementer", "ultracode:write-test"]);
  const implementer = report.agents.find((a) => a.agent === "ultracode:implementer");
  assert.equal(implementer.runs, 2, "both spellings count toward the same role");
});
