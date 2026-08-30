"use strict";

// Machine-level hub configuration: where the hub daemon keeps its state and
// how every client (hub-shim.js, hub-ctl.js, push adapters, tests) discovers
// the running endpoint. One hub per machine — all repos, sessions, and
// harnesses share it and address their own state explicitly per call, so
// nothing here is repo- or harness-scoped.
//
//   ~/.ultracode/hub.json     discovery file: { url, port, token, pid?, version, started_at? }
//   ~/.ultracode/hub/         daemon state: hub.sqlite3, hub.lock, hub.log
//
// The bearer token lives in hub.json (0600) and survives daemon restarts, so
// static registrations never have to change when the hub is restarted or
// upgraded. ULTRACODE_HUB_HOME relocates the whole tree (tests use a temp dir).

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 45777;

function machineStateRoot() {
  return path.resolve(process.env.ULTRACODE_HUB_HOME || path.join(os.homedir(), ".ultracode"));
}

function hubHome() {
  return path.join(machineStateRoot(), "hub");
}

function hubInfoPath() {
  return path.join(machineStateRoot(), "hub.json");
}

function hubDatabasePath() {
  return path.join(hubHome(), "hub.sqlite3");
}

function hubLockPath() {
  return path.join(hubHome(), "hub.lock");
}

function hubLogPath() {
  return path.join(hubHome(), "hub.log");
}

function pluginVersion() {
  try {
    return require("../../../package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Atomic + private: the discovery file carries the bearer token, so it is
// written 0600 through a PID-suffixed temp file (same pattern as
// mcp/lib/report.js) — a reader never sees a torn write, and other local
// users never see the token.
function writeHubInfo(info) {
  const target = hubInfoPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
  return info;
}

function readHubInfo() {
  try {
    const parsed = JSON.parse(fs.readFileSync(hubInfoPath(), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Idempotent: creates the state dirs and mints a token once. Never touches an
// existing token (rotation is explicit via rotateToken), so provisioning from
// every shim boot is safe.
function provision() {
  fs.mkdirSync(hubHome(), { recursive: true, mode: 0o700 });
  const existing = readHubInfo();
  if (existing && typeof existing.token === "string" && existing.token) return existing;
  return writeHubInfo({
    ...(existing || {}),
    token: generateToken(),
    port: (existing && existing.port) || resolvePreferredPort(),
    version: pluginVersion(),
  });
}

function rotateToken() {
  const info = provision();
  return writeHubInfo({ ...info, token: generateToken() });
}

// Preferred port only — the daemon falls back to an ephemeral port when this
// one is taken by a foreign process and records the real one in hub.json.
// Clients must always read hub.json rather than assuming the default.
function resolvePreferredPort() {
  const raw = Number.parseInt(process.env.ULTRACODE_HUB_PORT || "", 10);
  if (Number.isInteger(raw) && raw >= 0 && raw <= 65535) return raw;
  const recorded = readHubInfo();
  if (recorded && Number.isInteger(recorded.port)) return recorded.port;
  return DEFAULT_PORT;
}

function hubUrl(port) {
  return `http://127.0.0.1:${port}`;
}

module.exports = {
  DEFAULT_PORT,
  machineStateRoot,
  hubHome,
  hubInfoPath,
  hubDatabasePath,
  hubLockPath,
  hubLogPath,
  pluginVersion,
  provision,
  rotateToken,
  readHubInfo,
  writeHubInfo,
  resolvePreferredPort,
  hubUrl,
};
