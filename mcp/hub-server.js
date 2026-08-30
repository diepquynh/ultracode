#!/usr/bin/env node
// The ultracode hub daemon: one per machine. Binds loopback only, serves the
// REST + /mcp surface from mcp/lib/hub/http.js, owns the single writable
// SQLite connection, and records its endpoint in ~/.ultracode/hub.json for
// every client to discover. Started by `hub-ctl.js ensure` (installer) and
// lazily by any hub-shim.js boot that finds it dead — never by hand-editing
// registrations.

"use strict";

const fs = require("node:fs");
const {
  provision,
  readHubInfo,
  writeHubInfo,
  resolvePreferredPort,
  hubDatabasePath,
  hubLogPath,
  hubUrl,
  pluginVersion,
} = require("./lib/hub/config");
const { acquireLock, releaseLock } = require("./lib/hub/lock");
const { HubState } = require("./lib/hub/state");
const { createHubHttpServer } = require("./lib/hub/http");

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const EXPIRE_INTERVAL_MS = 60 * 1000;

// Append-only log with a single .1 rotation — enough to debug delivery
// without growing unbounded. Never logs message bodies or tokens.
function makeLogger(logPath) {
  return (line) => {
    try {
      try {
        if (fs.statSync(logPath).size > LOG_ROTATE_BYTES) fs.renameSync(logPath, `${logPath}.1`);
      } catch {
        // no log yet
      }
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // logging must never take the hub down
    }
  };
}

function main() {
  provision();
  const log = makeLogger(hubLogPath());

  const lock = acquireLock({ port: null });
  if (!lock.acquired) {
    log(`startup skipped: hub already running as pid ${lock.holder && lock.holder.pid}`);
    process.stdout.write(
      `ultracode hub already running (pid ${lock.holder && lock.holder.pid}); nothing to do.\n`,
    );
    process.exit(0);
  }

  const state = new HubState(hubDatabasePath());
  const { server, facade } = createHubHttpServer({
    state,
    getToken: () => {
      const info = readHubInfo();
      return info && info.token;
    },
    version: pluginVersion(),
    log,
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down on ${signal}`);
    facade.close();
    server.close(() => {
      state.close();
      const info = readHubInfo();
      if (info && info.pid === process.pid) {
        const { pid, started_at, ...rest } = info;
        writeHubInfo(rest);
      }
      releaseLock();
      process.exit(0);
    });
    // A stuck connection must not block shutdown forever.
    setTimeout(() => {
      state.close();
      releaseLock();
      process.exit(0);
    }, 5000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    log(`uncaught exception: ${error.stack || error.message}`);
    shutdown("uncaughtException");
  });

  const preferred = resolvePreferredPort();
  server.once("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      // Preferred port taken by a foreign process (a live hub was already
      // excluded by the lock): fall back to an ephemeral port — clients read
      // the real one from hub.json, never assume the default.
      log(`port ${preferred} in use by a foreign process; falling back to an ephemeral port`);
      server.listen(0, "127.0.0.1");
    } else {
      log(`listen failed: ${error.message}`);
      releaseLock();
      process.exit(1);
    }
  });
  server.on("listening", () => {
    const port = server.address().port;
    const info = readHubInfo() || {};
    writeHubInfo({
      ...info,
      url: hubUrl(port),
      port,
      pid: process.pid,
      version: pluginVersion(),
      started_at: new Date().toISOString(),
    });
    log(`listening on ${hubUrl(port)} (pid ${process.pid}, version ${pluginVersion()})`);
    const sweeper = setInterval(() => {
      try {
        facade.expireStale();
      } catch (error) {
        log(`expireStale failed: ${error.message}`);
      }
    }, EXPIRE_INTERVAL_MS);
    sweeper.unref();
  });
  server.listen(preferred, "127.0.0.1");
}

main();
