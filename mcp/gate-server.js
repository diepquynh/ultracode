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

const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { readTextIfFile } = require("../hooks/lib/common");
const { pluginTargetInfo } = require("../hooks/lib/session");
const { appendLesson } = require("./lib/memory");
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

// ultracode_memory — durable, repo-scoped lessons (a non-obvious constraint, a
// subtle invariant, a workaround for a specific bug) that survive across
// sessions, mirroring Pi's knowledge.md. Lives at {runtime_dir}/memory/, not
// under session/ scratch, so it is meant to be committed alongside
// INVENTORY.md and repo-profile.json. Dedupe-by-(area,lesson) and the
// max-entries cap are code-enforced (mcp/lib/memory.js) rather than left to
// whichever agent appends last to keep the file well-formed.
server.tool(
  "ultracode_memory",
  "Record a durable, repo-scoped lesson so every future session on this repo starts with it — a non-obvious " +
    "constraint, a subtle invariant, or a workaround for a specific bug. One line, no restating what the code " +
    "already makes obvious. Deduped and capped automatically; do not hand-edit knowledge.md.",
  {
    repo_root: z.string().describe("Absolute repo root (the prompt's Repo root: value)."),
    area: z.string().describe('Short slug for the affected area, e.g. "auth", "build".'),
    lesson: z.string().describe("The one-line lesson."),
    source: z.string().describe('Which agent recorded this, e.g. "ultracode:implement".'),
  },
  async ({ repo_root, area, lesson, source }) => {
    const info = pluginTargetInfo();
    if (!info) {
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
    const knowledgePath = path.join(repo_root, info.runtimeDir, "memory", "knowledge.md");
    const current = readTextIfFile(knowledgePath) || "";
    const updated = appendLesson(current, { area, lesson, source });
    fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
    fs.writeFileSync(knowledgePath, updated, "utf-8");
    return {
      content: [{ type: "text", text: `Recorded lesson for [${area}] in ${knowledgePath}.` }],
    };
  },
);

server.connect(new StdioServerTransport());
