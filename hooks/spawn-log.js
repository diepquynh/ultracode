#!/usr/bin/env node
// Record every spawned subagent into progress.json under the primary repository's
// session tree. Work-repo identity is retained in each record.

"use strict";

const { readHookInput } = require("./lib/common");
const { HookContext } = require("./lib/hook-context");
const { loadProgress, saveProgress, summarize, statusOf } = require("./lib/spawn-record");

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);
  const parentAgent = context.currentActor().agent;
  const status = statusOf(context.toolResponse);
  const summary = summarize(context.toolResponse);
  const recordsBySession = new Map();

  for (const spawn of context.spawns) {
    if (!spawn.agent || !spawn.effectiveSessionDir) continue;
    const phaseFile = spawn.parameters.phase_file || "";
    const phaseMatch = (phaseFile || spawn.prompt).match(/phase-(\d+)/);
    const record = {
      ts: new Date().toISOString(),
      agent: spawn.agent,
      repoKey: spawn.repoKey || null,
      repoRoot: spawn.workRepoRoot,
      phase: phaseMatch ? `phase-${phaseMatch[1]}` : null,
      status,
      summary,
      ...(parentAgent ? { spawnedBy: parentAgent } : {}),
      ...(spawn.parameters.report_file ? { reportFile: spawn.parameters.report_file } : {}),
    };
    const records = recordsBySession.get(spawn.effectiveSessionDir) || [];
    records.push(record);
    recordsBySession.set(spawn.effectiveSessionDir, records);
  }

  for (const [sessionDir, records] of recordsBySession) {
    try {
      const progress = loadProgress(sessionDir);
      progress.records.push(...records);
      saveProgress(sessionDir, progress);
    } catch {
      // Best-effort bookkeeping only.
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
