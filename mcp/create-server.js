"use strict";
// Shared tool factory for the ultracode MCP server. Both transport entry
// points — mcp/gate-server.js (stdio, offline-capable) and mcp/hub-shim.js /
// mcp/hub-server.js (machine-level HTTP hub) — build their McpServer here, so
// the tool surface cannot drift between transports. Handlers stay thin: all
// state logic lives in mcp/lib/* and is injectable via `deps` for tests.

const path = require("node:path");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { pluginTargetInfo } = require("../hooks/lib/session");
const { recordLesson, recallLessons, deleteLesson } = require("./lib/memory");
const { recordGateDecision } = require("./lib/gate");
const { writeReport, markLessonsRecorded } = require("./lib/report");
const { registerSealedChannelTools, sealedChannelDefaultDeps } = require("./sealed-channel-tools");

const SERVER_NAME = "ultracode-gate";
const SERVER_VERSION = "1.0.0";

const defaultDeps = {
  pluginTargetInfo,
  recordLesson,
  recallLessons,
  deleteLesson,
  recordGateDecision,
  writeReport,
  markLessonsRecorded,
  ...sealedChannelDefaultDeps,
};

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

// ultracode_gate — the one custom tool this plugin adds beyond hook-mutated
// built-ins. Spec/plan approval (Rules D3, D5) happens as a judgment call in
// conversation; there is no artifact recording that the user actually said
// yes. This MCP tool gives the orchestrator an explicit, hook-observable way
// to record that decision, so hooks/pipeline-gate.js can refuse to spawn
// ultracode:plan or a plan-driven ultracode:implementer until it has happened —
// converting "the orchestrator should remember it got approval" into "the
// orchestrator's next spawn is mechanically refused otherwise."
function registerCoreTools(server, deps = defaultDeps) {
  function resolveMemoryDbPath(repo_root) {
    const info = deps.pluginTargetInfo();
    if (!info) return null;
    return path.join(repo_root, info.runtimeDir, "memory", "knowledge.sqlite3");
  }

  server.registerTool(
    "ultracode_gate",
    {
      description:
        "Record a spec or plan approval decision for this session so ultracode's pipeline-gate hook " +
        "can allow the next stage to spawn. Call this immediately after the user approves (or rejects) " +
        "the spec or the plan — never speculatively, and never before the user has actually answered. " +
        "An 'approved' decision is refused unless ultracode:fact-check has already returned a PASS for " +
        "that same target under the same repo_key — spawn and pass fact-check first.",
      inputSchema: {
        session_dir: z
          .string()
          .describe("The exact Session dir: value already used for this session's spawns."),
        repo_key: z
          .string()
          .describe(
            "The repo key this decision is for — the same lowercase slug the ultracode:fact-check spawn " +
              "carried on its `Repo key:` line. Required: the verdict this tool checks is stored per repo " +
              "key, so a different key (or none) finds no verdict.",
          ),
        gate: z.enum(["spec", "plan"]).describe("Which gate this decision is for."),
        decision: z.enum(["approved", "rejected"]).describe("What the user decided."),
        notes: z.string().optional().describe("Optional one-line context (e.g. a rejection reason)."),
      },
    },
    async ({ session_dir, repo_key, gate, decision, notes }) => {
      const result = deps.recordGateDecision(session_dir, repo_key, gate, decision, notes);
      return {
        ...(result.ok ? {} : { isError: true }),
        content: [{ type: "text", text: result.message }],
      };
    },
  );

  // ultracode_memory / ultracode_memory_recall / ultracode_memory_forget — durable, repo-scoped
  // lessons (a non-obvious constraint, a subtle invariant, a workaround for a specific bug) that
  // survive across sessions. Lives at {runtime_dir}/memory/knowledge.sqlite3, not under session/
  // scratch, so it is meant to be committed alongside INVENTORY.md and repo-profile.json.
  // Deliberately uncapped and never auto-expired — a large multi-module repo accumulates more
  // lessons than any one session can gather, across many spawns and subagent failures — so agents
  // retrieve just what's relevant via recall (mcp/lib/memory.js) rather than reading the whole
  // store. _forget is a narrow escape hatch for a single lesson an agent has confirmed is now wrong
  // or stale, not a bulk or automatic trim.
  server.registerTool(
    "ultracode_memory",
    {
      description:
        "Record a durable, repo-scoped lesson so every future session on this repo starts with it — a non-obvious " +
        "constraint, a subtle invariant, or a workaround for a specific bug. One line, no restating what the code " +
        "already makes obvious. Deduped automatically by (area, lesson); never capped or auto-expired, so it's " +
        "always safe to record another one. If a past lesson turns out to be wrong or stale, use " +
        "ultracode_memory_forget to remove that one entry rather than leaving it to mislead future sessions. " +
        "Do not hand-edit knowledge.sqlite3.",
      inputSchema: {
        repo_root: z.string().describe("Absolute repo root (the prompt's Repo root: value)."),
        area: z
          .string()
          .describe(
            'Slug for the affected area, e.g. "auth", "build", or a hierarchical scope like ' +
              '"billing-service::InvoiceCalculator" for a large multi-module repo.',
          ),
        lesson: z.string().describe("The one-line lesson."),
        source: z.string().describe('Which agent recorded this, e.g. "ultracode:implementer".'),
        session_dir: z
          .string()
          .optional()
          .describe(
            "Pass the prompt's Session dir: value when this lesson comes from recovering a build failure — " +
              "it clears the pending-lesson block on ultracode_report. Optional otherwise.",
          ),
      },
    },
    async ({ repo_root, area, lesson, source, session_dir }) => {
      const dbPath = resolveMemoryDbPath(repo_root);
      if (!dbPath) return missingRuntimeDirError();
      const total = deps.recordLesson(dbPath, { area, lesson, source });
      // Keeps ultracode_report's gate honest: the flag is cleared by a lesson
      // actually landing in the store, never by an agent asserting it did.
      const cleared = session_dir ? deps.markLessonsRecorded(session_dir, source) : 0;
      return {
        content: [
          {
            type: "text",
            text:
              `Recorded lesson for [${area}] in ${dbPath} (${total} lessons total).` +
              (cleared ? ` Cleared ${cleared} pending failure-recovery lesson(s).` : ""),
          },
        ],
      };
    },
  );

  // ultracode_report — the pipeline's stage-to-stage handoff. The orchestrator
  // declares the path; this tool writes it. See mcp/lib/report.js for why the agent
  // does not get to choose the filename.
  server.registerTool(
    "ultracode_report",
    {
      description:
        "Write your stage's report to the exact path the orchestrator declared for this spawn, without having to " +
        "know that path: pass the full markdown body as `content` and the tool resolves the location. The next " +
        "stage reads the declared path, and a filename you invent is a filename it cannot find. If this call " +
        "stalls or fails, you may instead write the same content yourself to the declared `Report file:` path " +
        "with your write tool or a shell heredoc — that exact path is enforced either way. It refuses if you " +
        "recovered from a build-failure streak without recording what fixed it.",
      inputSchema: {
        session_dir: z
          .string()
          .describe("The exact Session dir: value from your prompt."),
        agent: z
          .string()
          .describe('Your own agent name, e.g. "ultracode:implementer" (the prefix is optional).'),
        content: z.string().describe("The complete markdown body of the report."),
        unrecorded_lesson_reason: z
          .string()
          .optional()
          .describe(
            "Only when the tool refused for an unrecorded failure-recovery lesson AND the fix genuinely " +
              "teaches nothing reusable: one line saying why. Do not use this to skip recording a real lesson.",
          ),
      },
    },
    async ({ session_dir, agent, content, unrecorded_lesson_reason }) => {
      const result = deps.writeReport(session_dir, agent, content, {
        allowUnrecordedLesson: Boolean(unrecorded_lesson_reason && unrecorded_lesson_reason.trim()),
      });
      return {
        ...(result.ok ? {} : { isError: true }),
        content: [{ type: "text", text: result.message }],
      };
    },
  );

  // The codex sealed-channel tools (ultracode_spawn_ticket, ultracode_factcheck)
  // live in mcp/sealed-channel-tools.js — one file for the whole "no hook can
  // read a codex spawn prompt or child result" story.
  registerSealedChannelTools(server, deps);

  server.registerTool(
    "ultracode_memory_recall",
    {
      description:
        "Retrieve durable, repo-scoped lessons relevant to the task or failure at hand, instead of reading the " +
        "whole memory store. Call this before starting work in an area, and again with the error/symptom as the " +
        "query if you hit a failure. Ranked by text relevance to `query` and scoped to `area` (and its " +
        "\"area::...\" sub-scopes) when given; returns at most `limit` lessons, most relevant first.",
      inputSchema: {
        repo_root: z.string().describe("Absolute repo root (the prompt's Repo root: value)."),
        area: z
          .string()
          .optional()
          .describe('Scope to an area/module, e.g. "billing-service::InvoiceCalculator". Optional.'),
        query: z.string().optional().describe("Free-text description of the task or failure. Optional."),
        limit: z.number().int().positive().max(50).optional().describe("Max lessons to return (default 8)."),
      },
    },
    async ({ repo_root, area, query, limit }) => {
      const dbPath = resolveMemoryDbPath(repo_root);
      if (!dbPath) return missingRuntimeDirError();
      const lessons = deps.recallLessons(dbPath, { area, query, limit: limit || 8 });
      if (!lessons.length) {
        return { content: [{ type: "text", text: "No relevant repo memory found." }] };
      }
      const text = lessons.map((l) => `- [${l.area}] ${l.lesson} — source: ${l.source}`).join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "ultracode_memory_forget",
    {
      description:
        "Remove one specific durable lesson that a recall already surfaced and that has since been confirmed wrong " +
        "or outdated (e.g. the constraint it described no longer holds, or the workaround it recorded is no " +
        "longer needed). Requires the exact area and lesson text as returned by ultracode_memory_recall — this is " +
        "a targeted removal, not a bulk or age-based cleanup, and there is no way to wipe an area or the whole " +
        "store through this tool.",
      inputSchema: {
        repo_root: z.string().describe("Absolute repo root (the prompt's Repo root: value)."),
        area: z.string().describe("Exact area of the lesson to remove, as returned by ultracode_memory_recall."),
        lesson: z.string().describe("Exact lesson text to remove, as returned by ultracode_memory_recall."),
      },
    },
    async ({ repo_root, area, lesson }) => {
      const dbPath = resolveMemoryDbPath(repo_root);
      if (!dbPath) return missingRuntimeDirError();
      const { deleted, total } = deps.deleteLesson(dbPath, { area, lesson });
      return {
        content: [
          {
            type: "text",
            text: deleted
              ? `Forgot lesson for [${area}] in ${dbPath} (${total} lessons remaining).`
              : `No matching lesson found for [${area}] in ${dbPath}; nothing removed.`,
          },
        ],
      };
    },
  );
}

// createUltracodeServer — the single place a McpServer is assembled.
//   { }                      → core tools only (gate-server.js, hub-unaware)
//   { hubTools: true, hub }  → core + hub tools; `hub` implements the hub API
//     (mcp/lib/hub/state.js in-process, or mcp/lib/hub/client.js over REST) and
//     may be null, in which case hub tools answer with an actionable error
//     instead of disappearing from the tool list.
function createUltracodeServer({ hub = null, hubTools = false, deps = defaultDeps } = {}) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerCoreTools(server, deps);
  if (hubTools) {
    const { registerHubTools } = require("./hub-tools");
    registerHubTools(server, hub);
  }
  return server;
}

module.exports = { createUltracodeServer, registerCoreTools, SERVER_NAME, SERVER_VERSION };
