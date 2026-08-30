#!/usr/bin/env node
// The stdio entry point every harness registers (as the MCP server name
// "ultracode-gate"). It exists because command-based stdio registration is
// the one shape all four harnesses reliably support today, while the hub is
// a shared HTTP daemon:
//
//   * AGY only registers MCP servers dependably via `agy mcp add <cmd>`;
//   * bearer tokens/ports stay out of generated configs (this process reads
//     ~/.ultracode/hub.json itself, so rotation never breaks a registration);
//   * booting at harness MCP startup makes every session a hub supervisor —
//     a dead hub is revived here, bounded, even on harnesses with no hooks;
//   * with no hub at all, the five core tools still work exactly like
//     mcp/gate-server.js, so nothing offline depends on the daemon.
//
// Core tools always run locally against mcp/lib (identical online/offline);
// only the hub tools travel over REST via HubClient.

"use strict";

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createUltracodeServer } = require("./create-server");
const { HubClient } = require("./lib/hub/client");

async function main() {
  let hub = null;
  // ULTRACODE_HUB_DISABLE=1 opts a machine/session out of the hub entirely:
  // no daemon is spawned, no ~/.ultracode is provisioned, and the hub tools
  // answer with their offline error. Tests use it for deterministic offline
  // boots; users use it to keep a machine daemon-free.
  if (process.env.ULTRACODE_HUB_DISABLE !== "1") {
    try {
      // Bounded (≤5 s inside ensureRunning): harness MCP startup must never
      // hang on hub recovery. restartIfOlder lets the newest installed plugin
      // version replace a stale daemon — hub state is all in SQLite, so a
      // restart is cheap and invisible to other sessions beyond one reconnect.
      const client = new HubClient();
      const health = await client.ensureRunning({ restartIfOlder: true });
      if (health) hub = client;
    } catch {
      // fall through to offline mode
    }
  }
  createUltracodeServer({ hubTools: true, hub }).connect(new StdioServerTransport());
}

main();
