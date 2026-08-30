"use strict";

// The cross-harness hub tools. `hub` is whichever implementation the entry
// point wired in: the in-process HubFacade (mcp/lib/hub/http.js, used by the
// daemon's /mcp endpoint) or the REST HubClient (mcp/lib/hub/client.js, used
// by the stdio shim) — or null, when the shim booted with no reachable hub.
// A null hub still registers every tool so agents get an actionable error
// instead of a missing tool name.
//
// Design rule carried through every description below: senders finish their
// turn. msg_send and task_publish return immediately and the hub wakes the
// recipient (native push or its single blocking msg_wait) — no tool here is
// meant to be called in a status-polling loop.

const { z } = require("zod");

const HARNESS_ENUM = z.enum(["claude", "codex", "grok", "antigravity"]);

function unavailable() {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          "ultracode hub is not reachable from this session. Ask the user to start it (node <plugin " +
          "root>/mcp/hub-ctl.js ensure) and start a new session — running plugin code yourself is " +
          "denied by plugin-guard. Core ultracode tools (gate/report/memory) still work without it.",
      },
    ],
  };
}

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function registerHubTools(server, hub) {
  const call = (method) => async (args) => {
    if (!hub) return unavailable();
    try {
      return jsonResult(await hub[method](args));
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  };

  server.registerTool(
    "ultracode_session_register",
    {
      description:
        "Register this interactive session with the machine-level ultracode hub so other harnesses can " +
        "message it and route tasks to it. Call once per session (re-calling is safe and rotates the " +
        "secret). Pass your real harness session id explicitly — never a placeholder. Set native_channel/" +
        "native_address when this session can be woken natively (a named Codex session → codex-queue; a " +
        "named Claude Code session → claude-uds); otherwise omit them and rely on ultracode_msg_wait. " +
        "Returns the session_key + session_secret every later hub call needs, and the message cursor to " +
        "start waiting from.",
      inputSchema: {
        harness: HARNESS_ENUM.describe("Which harness this session runs in."),
        session_id: z
          .string()
          .describe("This session's canonical harness session id (the session-dir formula's id), passed explicitly."),
        display_name: z.string().optional().describe("Human-friendly name shown in ultracode_session_list."),
        repo_roots: z
          .array(z.string())
          .describe("Absolute roots of every repo this session works in; the first owns its session dir."),
        session_dir: z
          .string()
          .describe("This session's own ultracode session dir (the exact Session dir: value it uses for spawns)."),
        capabilities: z
          .array(z.string())
          .optional()
          .describe('What kinds of tasks this session will claim, e.g. ["implement", "review"].'),
        native_channel: z
          .enum(["codex-queue", "claude-uds", "none"])
          .optional()
          .describe("Native wake channel for this session, if any."),
        native_address: z
          .string()
          .optional()
          .describe("The session's native name for that channel (Codex/Claude session name)."),
      },
    },
    call("registerSession"),
  );

  server.registerTool(
    "ultracode_session_heartbeat",
    {
      description:
        "Refresh this session's hub registration (sessions go stale after 10 minutes without one) and " +
        "learn whether messages or claimable tasks are pending. Call it when resuming work — not on a timer.",
      inputSchema: {
        session_key: z.string(),
        session_secret: z.string(),
      },
    },
    call("heartbeat"),
  );

  server.registerTool(
    "ultracode_session_list",
    {
      description:
        "List sessions registered with the hub — other harnesses' interactive sessions that can receive " +
        "messages or claim tasks. Use it before delegating so the user can choose the target harness/session.",
      inputSchema: {
        harness: HARNESS_ENUM.optional().describe("Only sessions of this harness."),
        repo_root: z.string().optional().describe("Only sessions registered for this absolute repo root."),
      },
    },
    call("listSessions"),
  );

  server.registerTool(
    "ultracode_session_query",
    {
      description:
        "List the shared ultracode sessions the hub knows for a repo — their session id, dir, inferred " +
        "pipeline stage (spec-drafted / planned / spec-approved / plan-approved), participants, and last " +
        "activity. Use it on hub-listen to show the user which session to take (adopt) for this managed " +
        "session, and to find a session to resume after a harness broke mid-run.",
      inputSchema: {
        repo_root: z.string().optional().describe("Only sessions whose primary repo root is this absolute path."),
      },
    },
    call("queryUltracodeSessions"),
  );

  server.registerTool(
    "ultracode_session_adopt",
    {
      description:
        "Authorize THIS session to work inside a shared ultracode session it did not create — the mechanism " +
        "that lets a harness pick up a session it could never inherit by native id, and that makes a broken " +
        "session resumable. Give the target by session_dir (exact, e.g. a delegated task's source.session_dir) " +
        "or by ultracode_session_id + repo_root (resume by id from ultracode_session_query). After adopting, " +
        "use the returned session_dir as your Session dir: for every spawn and hub call: its gates, spec, plan, " +
        "and reports are the shared ones, so the pipeline continues where it left off instead of re-approving. " +
        "Only adopt a session the user chose.",
      inputSchema: {
        session_key: z.string(),
        session_secret: z.string(),
        session_dir: z.string().optional().describe("Exact shared session dir to adopt."),
        ultracode_session_id: z.string().optional().describe("Adopt by id (with repo_root); for resume."),
        repo_root: z.string().optional().describe("Absolute repo root that owns the session (with ultracode_session_id)."),
      },
    },
    call("adoptSession"),
  );

  server.registerTool(
    "ultracode_msg_send",
    {
      description:
        "Send a message to another registered session (to_session_key) or broadcast to every session of a " +
        "harness (to_harness) — exactly one of the two. Returns immediately; the hub wakes the recipient " +
        "(native push, or its pending ultracode_msg_wait). The body must carry ADDRESSES — paths into the " +
        "shared .ultracode session dir — not file contents; it is capped at 64 KiB for that reason. After " +
        "sending, finish your turn: the reply arrives as a wake, not as something to poll for. Pass a " +
        "dedupe_key when retrying so a resend cannot double-deliver.",
      inputSchema: {
        from_session_key: z.string(),
        from_secret: z.string(),
        to_session_key: z.string().optional().describe("Direct recipient (from ultracode_session_list)."),
        to_harness: HARNESS_ENUM.optional().describe("Broadcast to every session of this harness instead."),
        body: z.string().describe("The message: addresses + a short note, never inlined artifacts."),
        reply_to: z.number().int().optional().describe("Message id this replies to."),
        task_id: z.number().int().optional().describe("Task this message concerns."),
        dedupe_key: z.string().optional().describe("Idempotency key; a resend returns the original message id."),
      },
    },
    call("sendMessage"),
  );

  server.registerTool(
    "ultracode_msg_wait",
    {
      description:
        "Fetch messages addressed to this session, blocking until one arrives or the timeout passes. This " +
        "is ONE long-poll call, and the only blocking wait permitted — never call it in a loop. If it times " +
        "out, finish your turn; a native push or the user will wake you, and the cursor means nothing is " +
        "lost. Pass the cursor from your registration or from the previous result; passing it back is the ack.",
      inputSchema: {
        session_key: z.string(),
        session_secret: z.string(),
        cursor: z.number().int().describe("Last message id already seen (from register or the previous call)."),
        timeout_ms: z
          .number()
          .int()
          .optional()
          .describe("How long to block (default 25000, max 120000 — stay under your harness's MCP tool timeout)."),
      },
    },
    call("waitMessages"),
  );

  server.registerTool(
    "ultracode_task_publish",
    {
      description:
        "Publish a task for another harness's interactive session to claim and execute. The payload carries " +
        "explicit addresses (repo_root, repo_key, source.session_dir plus spec/phase/report paths) exactly " +
        "like a subagent spawn prompt — the worker reads those artifacts itself, so publish addresses, never " +
        "content. The HUB resolves the target harness itself from the repo's CURRENT repo-profile.json " +
        "`harnesses` section (re-read on every publish, so a mid-session profile edit wins) using " +
        "payload.agent_hint and the phase file's complexity: OMIT target_harness whenever the profile routes " +
        "this stage. Pass target_harness only for a user-directed delegation with no profile route; a value " +
        "contradicting the current profile is refused with the routed harness named. Active sessions that " +
        "could claim the task are woken automatically. After publishing, FINISH YOUR TURN and say you are " +
        "waiting to be woken by the task's completion — do not poll.",
      inputSchema: {
        from_session_key: z.string(),
        from_secret: z.string(),
        title: z.string().describe("Short human-readable task title."),
        target_harness: HARNESS_ENUM.optional().describe(
          "Only for a user-directed delegation with no profile route; omit when repo-profile.json routes this stage — the hub resolves that itself, fresh, and refuses a contradicting value.",
        ),
        capability: z.string().optional().describe('Required worker capability, e.g. "implement".'),
        payload: z
          .object({
            agent_hint: z.string().optional().describe("Which ultracode agent role fits this task."),
            task: z.string().describe("Self-contained statement of the work."),
            repo_root: z.string().describe("Absolute root of the repo the work happens in."),
            repo_key: z.string().describe("The repo's lowercase session-state key."),
            source: z
              .object({
                session_dir: z.string().describe("Publisher's session dir (read-only for the worker)."),
                spec_file: z.string().optional(),
                phase_file: z.string().optional(),
                report_files: z.array(z.string()).optional(),
              })
              .passthrough(),
            constraints: z.object({}).passthrough().optional(),
          })
          .passthrough(),
        notify: z.boolean().optional().describe("Wake candidate sessions (default true)."),
      },
    },
    call("publishTask"),
  );

  server.registerTool(
    "ultracode_task_claim",
    {
      description:
        "Claim one open hub task for this session to execute, taking a lease (default 15 min, max 60). " +
        "Returns the task with its address payload, or task:null when the queue has nothing for this " +
        "harness/capability. Execute the claimed work through the normal ultracode pipeline in YOUR OWN " +
        "session dir, treating every source.* path as read-only, then call ultracode_task_complete. A lease " +
        "that expires un-completed reopens the task for someone else.",
      inputSchema: {
        session_key: z.string(),
        session_secret: z.string(),
        task_id: z.number().int().optional().describe("Claim this specific task instead of the oldest match."),
        capability: z.string().optional().describe("Only claim tasks requiring exactly this capability."),
        lease_seconds: z.number().int().optional().describe("Lease length (default 900, max 3600)."),
      },
    },
    call("claimTask"),
  );

  server.registerTool(
    "ultracode_task_complete",
    {
      description:
        "Report the outcome of a task this session claimed: done or failed, a one-paragraph summary, and " +
        "the report file you wrote INSIDE YOUR OWN session dir (the publisher reads it from there). The hub " +
        "notifies and wakes the publisher automatically — do not also message them about the same task.",
      inputSchema: {
        session_key: z.string(),
        session_secret: z.string(),
        task_id: z.number().int(),
        status: z.enum(["done", "failed"]),
        summary: z.string().describe("What happened, in the publisher's terms."),
        report_file: z.string().optional().describe("Absolute path to your report, inside your own session dir."),
      },
    },
    call("completeTask"),
  );
}

module.exports = { registerHubTools };
