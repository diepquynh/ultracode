#!/usr/bin/env node
// ultracode_gate — the one custom tool this plugin adds beyond hook-mutated
// built-ins. Spec/plan approval (Rules D3, D5) happens as a judgment call in
// conversation; there is no artifact recording that the user actually said
// yes. This MCP tool gives the orchestrator an explicit, hook-observable way
// to record that decision, so hooks/pipeline-gate.js can refuse to spawn
// ultracode:plan or a plan-driven ultracode:implement until it has happened —
// converting "the orchestrator should remember it got approval" into "the
// orchestrator's next spawn is mechanically refused otherwise."

"use strict";

const path = require("node:path");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { pluginTargetInfo } = require("../hooks/lib/session");
const { recordLesson, recallLessons } = require("./lib/memory");
const { recordGateDecision } = require("./lib/gate");

const server = new McpServer({ name: "ultracode-gate", version: "1.0.0" });

server.tool(
  "ultracode_gate",
  "Record a spec or plan approval decision for this session so ultracode's pipeline-gate hook " +
    "can allow the next stage to spawn. Call this immediately after the user approves (or rejects) " +
    "the spec or the plan — never speculatively, and never before the user has actually answered. " +
    "An 'approved' decision is refused unless ultracode:fact-check has already returned a PASS for " +
    "that same target in this session dir — spawn and pass fact-check first.",
  {
    session_dir: z
      .string()
      .describe("The exact Session dir: value already used for this session's spawns."),
    gate: z.enum(["spec", "plan"]).describe("Which gate this decision is for."),
    decision: z.enum(["approved", "rejected"]).describe("What the user decided."),
    notes: z.string().optional().describe("Optional one-line context (e.g. a rejection reason)."),
  },
  async ({ session_dir, gate, decision, notes }) => {
    const result = recordGateDecision(session_dir, gate, decision, notes);
    return {
      ...(result.ok ? {} : { isError: true }),
      content: [{ type: "text", text: result.message }],
    };
  },
);

// ultracode_memory / ultracode_memory_recall — durable, repo-scoped lessons (a non-obvious
// constraint, a subtle invariant, a workaround for a specific bug) that survive across
// sessions. Lives at {runtime_dir}/memory/knowledge.sqlite3, not under session/ scratch, so
// it is meant to be committed alongside INVENTORY.md and repo-profile.json. Deliberately
// uncapped — a large multi-module repo accumulates more lessons than any one session can
// gather, across many spawns and subagent failures — so agents retrieve just what's relevant
// via recall (mcp/lib/memory.js) rather than reading the whole store.

function resolveMemoryDbPath(repo_root) {
  const info = pluginTargetInfo();
  if (!info) return null;
  return path.join(repo_root, info.runtimeDir, "memory", "knowledge.sqlite3");
}

function missingRuntimeDirError() {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "ultracode: no generated hooks/model-routing.json found; cannot resolve this repo's runtime directory.",
      },
    ],
  };
}

server.tool(
  "ultracode_memory",
  "Record a durable, repo-scoped lesson so every future session on this repo starts with it — a non-obvious " +
    "constraint, a subtle invariant, or a workaround for a specific bug. One line, no restating what the code " +
    "already makes obvious. Deduped automatically by (area, lesson); never capped or trimmed, so it's always " +
    "safe to record another one. Do not hand-edit knowledge.sqlite3.",
  {
    repo_root: z.string().describe("Absolute repo root (the prompt's Repo root: value)."),
    area: z
      .string()
      .describe(
        'Slug for the affected area, e.g. "auth", "build", or a hierarchical scope like ' +
          '"billing-service::InvoiceCalculator" for a large multi-module repo.',
      ),
    lesson: z.string().describe("The one-line lesson."),
    source: z.string().describe('Which agent recorded this, e.g. "ultracode:implement".'),
  },
  async ({ repo_root, area, lesson, source }) => {
    const dbPath = resolveMemoryDbPath(repo_root);
    if (!dbPath) return missingRuntimeDirError();
    const total = recordLesson(dbPath, { area, lesson, source });
    return {
      content: [{ type: "text", text: `Recorded lesson for [${area}] in ${dbPath} (${total} lessons total).` }],
    };
  },
);

server.tool(
  "ultracode_memory_recall",
  "Retrieve durable, repo-scoped lessons relevant to the task or failure at hand, instead of reading the " +
    "whole memory store. Call this before starting work in an area, and again with the error/symptom as the " +
    "query if you hit a failure. Ranked by text relevance to `query` and scoped to `area` (and its " +
    "\"area::...\" sub-scopes) when given; returns at most `limit` lessons, most relevant first.",
  {
    repo_root: z.string().describe("Absolute repo root (the prompt's Repo root: value)."),
    area: z
      .string()
      .optional()
      .describe('Scope to an area/module, e.g. "billing-service::InvoiceCalculator". Optional.'),
    query: z.string().optional().describe("Free-text description of the task or failure. Optional."),
    limit: z.number().int().positive().max(50).optional().describe("Max lessons to return (default 8)."),
  },
  async ({ repo_root, area, query, limit }) => {
    const dbPath = resolveMemoryDbPath(repo_root);
    if (!dbPath) return missingRuntimeDirError();
    const lessons = recallLessons(dbPath, { area, query, limit: limit || 8 });
    if (!lessons.length) {
      return { content: [{ type: "text", text: "No relevant repo memory found." }] };
    }
    const text = lessons.map((l) => `- [${l.area}] ${l.lesson} — source: ${l.source}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.connect(new StdioServerTransport());
