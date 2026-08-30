#!/usr/bin/env node
// Lifecycle CLI for the machine-level ultracode hub daemon.
//
//   hub-ctl.js ensure [--restart-if-older]   provision + start if dead (idempotent)
//   hub-ctl.js start                         alias of ensure
//   hub-ctl.js stop                          SIGTERM the running daemon
//   hub-ctl.js status                        print hub.json + live health as JSON
//   hub-ctl.js rotate-token                  mint a new bearer token (clients re-read per call)
//
// Used by install.sh / uninstall.sh and by humans; the stdio shim runs the
// same ensure path in-process at boot.

"use strict";

const { provision, readHubInfo, rotateToken } = require("./lib/hub/config");
const { currentHolder } = require("./lib/hub/lock");
const { HubClient } = require("./lib/hub/client");

async function main() {
  const command = process.argv[2] || "status";
  const flags = new Set(process.argv.slice(3));
  const client = new HubClient();

  switch (command) {
    case "ensure":
    case "start": {
      const health = await client.ensureRunning({ restartIfOlder: flags.has("--restart-if-older") });
      if (!health) {
        process.stderr.write("ultracode hub failed to start within the timeout; see ~/.ultracode/hub/hub.log\n");
        process.exit(1);
      }
      const info = readHubInfo();
      process.stdout.write(`ultracode hub running at ${info.url} (version ${health.version})\n`);
      return;
    }
    case "stop": {
      const holder = currentHolder();
      if (!holder) {
        process.stdout.write("ultracode hub is not running.\n");
        return;
      }
      await client.stopDaemon();
      process.stdout.write(`ultracode hub (pid ${holder.pid}) stopped.\n`);
      return;
    }
    case "status": {
      const info = readHubInfo();
      const health = await client.healthz();
      process.stdout.write(
        `${JSON.stringify(
          {
            running: Boolean(health),
            version: health ? health.version : null,
            url: info ? info.url || null : null,
            port: info ? info.port || null : null,
            pid: (currentHolder() || {}).pid || null,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    case "rotate-token": {
      provision();
      rotateToken();
      process.stdout.write("ultracode hub token rotated; clients pick it up on their next call.\n");
      return;
    }
    default:
      process.stderr.write(`Unknown command '${command}'. Use: ensure | start | stop | status | rotate-token\n`);
      process.exit(2);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
