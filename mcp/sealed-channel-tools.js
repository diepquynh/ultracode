"use strict";

// The sealed-channel tools: the plaintext side of codex's encrypted spawn
// channel. Codex with OpenAI models seals collaboration messages end-to-end —
// no hook ever reads a spawn prompt (contract IN) or a child's final message
// (results OUT) — but plain MCP tool arguments are never sealed. These two
// tools are that plaintext detour; hooks/lib/codex-spawn.js is the hook-side
// counterpart and docs/harness-limitations.md carries the source citations.
//
// They are registered on every harness (the server factory is shared and the
// calls are harmless anywhere), but only the generated prompts of harnesses
// that need them instruct them: codex uses both, grok uses only
// ultracode_factcheck (its spawn prompts are readable, but a child's final
// message rarely reaches a parent-side hook — hooks/lib/grok-hooks.js, fact
// 4). Elsewhere the readable prompt and the PostToolUse recorder already
// cover both directions.

const { z } = require("zod");
const { bareAgentName, knownAgents } = require("../hooks/lib/common");
const { validateSubagentParameters, displayName } = require("../hooks/lib/subagent-params");
const { fileTicket, TICKET_TTL_MS } = require("../hooks/lib/spawn-ticket");
const { recordFactcheckVerdict } = require("./lib/gate");

// Injectable state writers, merged into create-server.js's defaultDeps.
const sealedChannelDefaultDeps = {
  fileSpawnTicket: fileTicket,
  recordFactcheckVerdict,
  knownAgents,
};

function registerSealedChannelTools(server, deps) {
  // ultracode_spawn_ticket — contract IN. The orchestrator files the spawn's
  // required parameters here before spawning; session-guard validates and
  // consumes the single-use ticket instead of the unreadable prompt, and
  // refuses a sealed spawn without one. Validation is eager: a ticket that
  // would be refused at spawn time is refused now, while it is cheap to fix.
  server.registerTool(
    "ultracode_spawn_ticket",
    {
      description:
        "File the required parameter contract for your NEXT ultracode subagent spawn, on harnesses where " +
        "spawn messages are end-to-end encrypted and hooks cannot read the prompt's `Label: value` lines " +
        "(Codex). Call this immediately before each spawn with exactly the same values the spawn prompt " +
        "carries; the spawn is refused without it. Single-use and short-lived: one ticket authorizes one " +
        "spawn, so file a fresh one every time, including retries. Not needed on harnesses with readable " +
        "spawn prompts — there the prompt lines themselves are enforced.",
      inputSchema: {
        harness_session_id: z
          .string()
          .min(1)
          .describe("This session's native id — the same value used as $SESSION_ID for session-dir derivation."),
        agent: z
          .string()
          .describe('The agent about to be spawned, e.g. "ultracode_generate_spec" (any ultracode prefix form).'),
        parameters: z
          .record(z.string())
          .describe(
            "The spawn prompt's `Label: value` lines, keyed by snake_case parameter name: repo_root, " +
              "session_dir, repo_key, primary_repo_root, task, and any agent-specific fields " +
              "(spec_file, phase_file, report_file, ...). Values must match the prompt exactly.",
          ),
      },
    },
    async ({ harness_session_id, agent, parameters }) => {
      const info = deps.pluginTargetInfo();
      if (!info || !info.target) {
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
      const name = bareAgentName(agent);
      if (!(deps.knownAgents || knownAgents)().has(name)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `ultracode: "${agent}" is not a known ultracode agent; no ticket filed.`,
            },
          ],
        };
      }
      const validation = validateSubagentParameters(name, parameters || {});
      if (!validation.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `ultracode: refusing to file a spawn ticket for ultracode:${name} — the contract is incomplete:\n` +
                validation.errors.map((error) => `- ${error}`).join("\n") +
                `\nFix the parameters and call ultracode_spawn_ticket again; keys are snake_case (` +
                `repo_root for ${displayName("repo_root")} etc.).`,
            },
          ],
        };
      }
      const ticket = deps.fileSpawnTicket(info.target, harness_session_id, name, parameters);
      return {
        content: [
          {
            type: "text",
            text:
              `Spawn ticket ${ticket.id} filed for ultracode:${name}. Single-use, valid ` +
              `${Math.round(TICKET_TTL_MS / 60000)} minutes — spawn now with the same values in the prompt.`,
          },
        ],
      };
    },
  );

  // ultracode_factcheck — results OUT. A codex child's FINAL_ANSWER dispatches
  // no hook, and a grok child's final message usually never reaches PostToolUse
  // either (background-default spawns; hooks/lib/grok-hooks.js, fact 4), so the
  // verdict author writes the ledger itself: same file, same shape, same rounds
  // accounting as hooks/factcheck-record.js (which is deliberately not
  // registered on codex or grok), so ultracode_gate cannot tell the writers
  // apart at approval time.
  server.registerTool(
    "ultracode_factcheck",
    {
      description:
        "FACT-CHECK AGENT ONLY: record your verdict in this session's factcheck.json so ultracode_gate " +
        "can verify it at approval time. Call this once, right before returning your final " +
        "{verdict, target, findings} JSON, with exactly the same values — then still return that JSON as " +
        "your final message. Required on harnesses where your final message never reaches a parent-side " +
        "hook (Codex: sealed agent messages; Grok Build: background-default spawns); on other harnesses " +
        "the parent-side hook records your final message instead and this call is unnecessary.",
      inputSchema: {
        session_dir: z.string().describe("The exact Session dir: value from your spawn prompt."),
        repo_key: z.string().describe("The exact Repo key: value from your spawn prompt."),
        target: z.enum(["spec", "plan"]).describe("Which artifact you fact-checked."),
        verdict: z.enum(["PASS", "FAIL"]).describe("Your verdict."),
        findings: z
          .array(z.string())
          .optional()
          .describe("Your findings, one string each; empty or omitted for a clean PASS."),
      },
    },
    async ({ session_dir, repo_key, target, verdict, findings }) => {
      const result = deps.recordFactcheckVerdict(session_dir, repo_key, target, verdict, findings);
      return {
        ...(result.ok ? {} : { isError: true }),
        content: [{ type: "text", text: result.message }],
      };
    },
  );
}

module.exports = { registerSealedChannelTools, sealedChannelDefaultDeps };
