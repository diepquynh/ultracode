"use strict";

// REST client for the hub daemon, implementing the same method surface as
// HubFacade so mcp/hub-tools.js can be handed either one. Used by the stdio
// shim (mcp/hub-shim.js), hub-ctl.js, and tests. Discovers the endpoint and
// bearer token from ~/.ultracode/hub.json on every call, so a token rotation
// or port change needs no client restart.

const { spawn } = require("node:child_process");
const path = require("node:path");
const {
  provision,
  readHubInfo,
  hubUrl,
  pluginVersion,
} = require("./config");
const { currentHolder, pidAlive } = require("./lock");

// Mirrors MAX_WAIT_MS in ./http.js without importing it (that would pull the
// whole server stack into every shim process).
const MAX_WAIT_MS = 120 * 1000;

const HUB_SERVER_PATH = path.join(__dirname, "..", "..", "hub-server.js");
const ENSURE_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

function compareVersions(a, b) {
  const left = String(a || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const right = String(b || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

class HubClient {
  baseUrl() {
    const info = readHubInfo();
    if (!info || !Number.isInteger(info.port)) return null;
    return info.url || hubUrl(info.port);
  }

  async request(method, route, body, { timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
    const info = readHubInfo();
    const base = this.baseUrl();
    if (!base || !info || !info.token) {
      throw new Error("ultracode hub endpoint unknown: no ~/.ultracode/hub.json (run hub-ctl.js ensure).");
    }
    // timeoutMs 0 = no client-side deadline (an infinite msg_wait park); the
    // caller's cancellation signal — the harness aborting the tool call when
    // the user hits ESC — is then the only way this fetch ends early.
    const signals = [];
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    if (signal) signals.push(signal);
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${info.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error body
    }
    if (!response.ok) {
      const message = (parsed && parsed.error) || `hub responded ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return parsed;
  }

  // --- the HubFacade-compatible tool surface -------------------------------

  registerSession(args) {
    return this.request("POST", "/api/v1/sessions", args);
  }

  heartbeat(args) {
    return this.request("POST", "/api/v1/sessions/heartbeat", args);
  }

  listSessions(args = {}) {
    const params = new URLSearchParams();
    if (args.harness) params.set("harness", args.harness);
    if (args.repo_root) params.set("repo_root", args.repo_root);
    const query = params.toString();
    return this.request("GET", `/api/v1/sessions${query ? `?${query}` : ""}`);
  }

  queryUltracodeSessions(args = {}) {
    const params = new URLSearchParams();
    if (args.repo_root) params.set("repo_root", args.repo_root);
    const query = params.toString();
    return this.request("GET", `/api/v1/ultracode-sessions${query ? `?${query}` : ""}`);
  }

  adoptSession(args) {
    return this.request("POST", "/api/v1/sessions/adopt", args);
  }

  sendMessage(args) {
    return this.request("POST", "/api/v1/messages", args);
  }

  waitMessages(args, { signal } = {}) {
    // The HTTP timeout must outlive the server-side long-poll window;
    // timeout_ms 0 (infinite park) disables the client deadline entirely and
    // relies on the cancellation signal / connection lifetime instead.
    const requested = Number.isInteger(args && args.timeout_ms) ? args.timeout_ms : 25000;
    const timeoutMs = requested === 0 ? 0 : Math.min(requested, MAX_WAIT_MS) + REQUEST_TIMEOUT_MS;
    return this.request("POST", "/api/v1/messages/wait", args, { timeoutMs, signal });
  }

  publishTask(args) {
    return this.request("POST", "/api/v1/tasks", args);
  }

  claimTask(args) {
    return this.request("POST", "/api/v1/tasks/claim", args);
  }

  completeTask(args) {
    return this.request("POST", "/api/v1/tasks/complete", args);
  }

  // --- lifecycle ------------------------------------------------------------

  async healthz({ timeoutMs = 1500 } = {}) {
    const base = this.baseUrl();
    if (!base) return null;
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  spawnDaemon() {
    const child = spawn(process.execPath, [HUB_SERVER_PATH], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  }

  async stopDaemon({ timeoutMs = ENSURE_TIMEOUT_MS } = {}) {
    const holder = currentHolder();
    if (!holder) return true;
    try {
      process.kill(holder.pid, "SIGTERM");
    } catch {
      return true;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!pidAlive(holder.pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      process.kill(holder.pid, "SIGKILL");
    } catch {
      // already gone
    }
    return true;
  }

  // Bounded so a harness's MCP-server startup can never hang on hub recovery:
  // provision, health-check, (optionally) replace an older hub with this
  // plugin copy's version, spawn if dead, and poll until healthy or timeout.
  async ensureRunning({ timeoutMs = ENSURE_TIMEOUT_MS, restartIfOlder = false } = {}) {
    provision();
    let health = await this.healthz();
    if (health && restartIfOlder && compareVersions(health.version, pluginVersion()) < 0) {
      await this.stopDaemon();
      health = null;
    }
    if (health) return health;
    this.spawnDaemon();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      health = await this.healthz({ timeoutMs: 500 });
      if (health) return health;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  }
}

module.exports = { HubClient, compareVersions, HUB_SERVER_PATH };
