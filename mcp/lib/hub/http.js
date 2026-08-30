"use strict";

// The hub's network surface: a small authenticated REST API (used by
// mcp/hub-shim.js, mcp/hub-ctl.js, and tests) plus /mcp, a stateless
// streamable-HTTP MCP endpoint exposing the same tool surface for harnesses
// that register the hub URL directly. Both sit on plain node:http — the only
// runtime dependencies stay the MCP SDK and zod.
//
// HubFacade is the one implementation of the hub tool API. It layers two
// things on HubState that a pure state store cannot own: in-process long-poll
// waiters (a message insert resolves a pending msg_wait instead of making the
// client poll) and native push delivery (mcp/lib/push) so an idle recipient
// session wakes as a new turn. Rows are committed before either is attempted,
// so delivery failure never loses anything.

const crypto = require("node:crypto");
const http = require("node:http");
const { HubError } = require("./state");
const { attemptPush, wakeNotice } = require("../push");
const { writeLink } = require("../../../hooks/lib/session-link");

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_WAIT_MS = 25 * 1000;
const MAX_WAIT_MS = 120 * 1000;
const RATE_LIMIT_PER_MINUTE = 120;

// timeout_ms 0 = wait forever: the park for a listening worker on a pull-only
// harness, ended only by a message, a daemon shutdown, or the user cancelling
// the tool call (ESC — the harness's MCP cancellation aborts the shim's fetch,
// the connection closes, and the close handler reaps the waiter). Finite
// values stay capped so a plain fetch can never look like a hung tool.
function clampWait(timeoutMs) {
  if (timeoutMs === 0) return 0;
  const value = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_MS;
  return Math.min(value, MAX_WAIT_MS);
}

class HubFacade {
  constructor(state, { log = () => {} } = {}) {
    this.state = state;
    this.log = log;
    this.waiters = new Set();
    this.closed = false;
  }

  async registerSession(args) {
    return this.state.registerSession(args);
  }

  async heartbeat(args) {
    return this.state.heartbeat(args);
  }

  async listSessions(args) {
    return this.state.listSessions(args || {});
  }

  async queryUltracodeSessions(args) {
    return this.state.queryUltracodeSessions(args || {});
  }

  // Record the adoption, then write the link file session-guard reads. The DB
  // row is the source of truth for discovery/resume; the file is the hook's
  // local, hub-restart-surviving copy of the authorization.
  async adoptSession(args) {
    const result = this.state.adoptSession(args);
    try {
      writeLink(result.harness, result.harness_session_id, result);
    } catch (error) {
      this.log(`adopt link write failed for ${result.harness}:${result.harness_session_id}: ${error.message}`);
    }
    return result;
  }

  async sendMessage(args) {
    const result = this.state.sendMessage(args);
    if (result.duplicate) {
      return { message_id: result.message_id, duplicate: true, pushed: false, channel: null };
    }
    const delivery = await this.deliver(result.recipient, args.to_harness || null, result.message_id);
    return { message_id: result.message_id, duplicate: false, ...delivery };
  }

  // Wake an in-process waiter first (the recipient is mid msg_wait: resolving
  // it IS the delivery); otherwise try native push so an idle session gets a
  // new turn. Broadcasts push to every active session of the harness.
  async deliver(recipient, toHarness, messageId) {
    const woke = this.wakeWaiters(
      recipient ? { session_key: recipient.session_key } : { harness: toHarness },
    );
    if (woke) {
      this.state.markDelivered(messageId, "long-poll");
      return { pushed: true, channel: "long-poll" };
    }
    const targets = recipient
      ? [recipient]
      : this.state.listSessions({ harness: toHarness }).sessions.filter((s) => s.status === "active");
    for (const target of targets) {
      const result = await attemptPush(target, wakeNotice(target, 1), { log: this.log });
      if (result.pushed) {
        this.state.markDelivered(messageId, result.channel);
        return result;
      }
    }
    return { pushed: false, channel: null };
  }

  wakeWaiters({ session_key, harness }) {
    let woken = false;
    for (const waiter of [...this.waiters]) {
      const match = session_key ? waiter.session_key === session_key : waiter.harness === harness;
      if (!match) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
      woken = true;
    }
    return woken;
  }

  // One blocking call, not a poll loop: fetch, and only when the inbox is
  // empty park until a matching insert (or the timeout / cancellation /
  // daemon shutdown) resolves us, then fetch again. Cursor semantics make
  // every ending lossless. `signal` carries the caller's cancellation (the
  // request's close event, which is also how a user's ESC arrives) — without
  // reaping on it, an infinite waiter whose client vanished would sit in the
  // set forever and swallow a future wake.
  async waitMessages({ session_key, session_secret, cursor, timeout_ms }, { signal } = {}) {
    const first = this.state.fetchMessages({ session_key, session_secret, cursor });
    if (first.messages.length) return { ...first, timed_out: false, shutdown: false };
    if (this.closed) return { ...first, timed_out: false, shutdown: true };
    if (signal && signal.aborted) return { ...first, timed_out: false, shutdown: false, cancelled: true };

    const waitMs = clampWait(timeout_ms);
    const row = this.state.sessionRow(session_key);
    let timedOutLocally = false;
    await new Promise((resolve) => {
      const waiter = { session_key, harness: row.harness, resolve: finish };
      let timer = null;
      const onAbort = () => finish();
      function cleanup() {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      const waiters = this.waiters;
      function finish() {
        waiters.delete(waiter);
        cleanup();
        resolve();
      }
      this.waiters.add(waiter);
      if (waitMs > 0) {
        timer = setTimeout(() => {
          timedOutLocally = true;
          finish();
        }, waitMs);
        timer.unref();
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
    if (signal && signal.aborted) {
      // The client is gone (user ESC or dropped connection); nothing to send,
      // nothing lost — the cursor lets the next wait re-read everything.
      return { messages: [], cursor, timed_out: false, shutdown: this.closed, cancelled: true };
    }
    const again = this.state.fetchMessages({ session_key, session_secret, cursor });
    return {
      ...again,
      timed_out: timedOutLocally && again.messages.length === 0 && !this.closed,
      shutdown: this.closed,
    };
  }

  async publishTask(args) {
    const { task_id, notify_candidates, ...routing } = this.state.publishTask(args);
    let notified = 0;
    if (args.notify !== false && notify_candidates.length) {
      const notices = this.state.notifyTaskPublished(task_id, args.title, notify_candidates);
      for (const notice of notices) {
        const delivery = await this.deliver(notice.recipient, null, notice.message_id);
        if (delivery.pushed) notified++;
      }
    }
    return { task_id, ...routing, candidates: notify_candidates.length, woken: notified };
  }

  async claimTask(args) {
    const { task, notifications } = this.state.claimTask(args);
    // The claim's lease sweep may have failed another publisher's task; wake
    // them now (their failure row is already committed). Their hints never
    // reach the claiming worker's tool result — they are not its business.
    for (const notice of notifications || []) {
      await this.deliver(notice.recipient, null, notice.message_id);
    }
    return { task };
  }

  async completeTask(args) {
    const { notifications } = this.state.completeTask(args);
    let publisherWoken = false;
    for (const notice of notifications) {
      const delivery = await this.deliver(notice.recipient, null, notice.message_id);
      if (delivery.pushed) publisherWoken = true;
    }
    return { ok: true, publisher_woken: publisherWoken };
  }

  expireStale() {
    // Parked waiters mark their sessions alive regardless of heartbeat age.
    const parked = [...this.waiters].map((waiter) => waiter.session_key);
    const notifications = this.state.expireStale(parked);
    return Promise.all(
      notifications.map((notice) => this.deliver(notice.recipient, null, notice.message_id)),
    );
  }

  // Resolve every parked long-poll so a draining daemon never strands a
  // client until its timeout; they see shutdown:true and reconnect later.
  close() {
    this.closed = true;
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }
}

function readBody(req, cap = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > cap) {
        rejected = true;
        // Keep draining rather than destroying the socket, so the 413 the
        // route handler sends actually reaches the client instead of an
        // ECONNRESET mid-upload.
        chunks.length = 0;
        reject(new HubError(413, `Request body exceeds ${cap} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function tokenMatches(givenHeader, expectedToken) {
  if (typeof givenHeader !== "string" || !givenHeader.startsWith("Bearer ")) return false;
  const given = Buffer.from(givenHeader.slice("Bearer ".length));
  const expected = Buffer.from(String(expectedToken || ""));
  return (
    expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected)
  );
}

// createHubHttpServer({ state, getToken, version, log }) → { server, facade }
// The caller (mcp/hub-server.js) owns listening, the loopback bind, and
// lifecycle; tests drive the returned server directly on an ephemeral port.
function createHubHttpServer({ state, getToken, version, log = () => {} }) {
  const facade = new HubFacade(state, { log });
  // Per-minute token bucket for mutating REST routes. Everything arrives from
  // loopback with one shared token, so a single global bucket is enough to
  // stop a runaway agent loop without per-client accounting.
  let bucket = { window: 0, count: 0 };
  function rateLimited() {
    const window = Math.floor(Date.now() / 60000);
    if (bucket.window !== window) bucket = { window, count: 0 };
    bucket.count += 1;
    return bucket.count > RATE_LIMIT_PER_MINUTE;
  }

  const restRoutes = {
    "POST /api/v1/sessions": (body) => facade.registerSession(body),
    "POST /api/v1/sessions/heartbeat": (body) => facade.heartbeat(body),
    "GET /api/v1/sessions": (_body, query) =>
      facade.listSessions({ harness: query.get("harness") || undefined, repo_root: query.get("repo_root") || undefined }),
    "GET /api/v1/ultracode-sessions": (_body, query) =>
      facade.queryUltracodeSessions({ repo_root: query.get("repo_root") || undefined }),
    "POST /api/v1/sessions/adopt": (body) => facade.adoptSession(body),
    "POST /api/v1/messages": (body) => facade.sendMessage(body),
    "POST /api/v1/messages/wait": (body, _query, ctx) => facade.waitMessages(body, { signal: ctx.signal }),
    "POST /api/v1/tasks": (body) => facade.publishTask(body),
    "POST /api/v1/tasks/claim": (body) => facade.claimTask(body),
    "POST /api/v1/tasks/complete": (body) => facade.completeTask(body),
  };
  const longPollRoutes = new Set(["POST /api/v1/messages/wait"]);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const routeKey = `${req.method} ${url.pathname}`;
    try {
      if (routeKey === "GET /healthz") {
        sendJson(res, 200, { ok: true, version });
        return;
      }
      if (!tokenMatches(req.headers.authorization, getToken())) {
        sendJson(res, 401, { error: "Missing or invalid bearer token." });
        return;
      }
      if (routeKey === "GET /api/v1/info") {
        sendJson(res, 200, { ok: true, version, pid: process.pid });
        return;
      }

      if (url.pathname === "/mcp") {
        await handleMcp(req, res, facade);
        return;
      }

      const handler = restRoutes[routeKey];
      if (!handler) {
        sendJson(res, 404, { error: `No such route: ${routeKey}` });
        return;
      }
      if (req.method !== "GET" && !longPollRoutes.has(routeKey) && rateLimited()) {
        sendJson(res, 429, { error: "Rate limit exceeded; retry next minute." });
        return;
      }
      let body = {};
      if (req.method !== "GET") {
        const raw = await readBody(req);
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Request body must be JSON." });
            return;
          }
        }
      }
      // A dropped connection (user ESC aborting the shim's fetch, a dying
      // shim, a network hiccup) must reap any waiter this request parked.
      const cancel = new AbortController();
      res.once("close", () => cancel.abort());
      const result = await handler(body, url.searchParams, { signal: cancel.signal });
      sendJson(res, 200, result);
      log(`${routeKey} ok`);
    } catch (error) {
      if (error instanceof HubError) {
        sendJson(res, error.status, { error: error.message });
      } else {
        log(`${routeKey} error: ${error.stack || error.message}`);
        sendJson(res, 500, { error: "Internal hub error." });
      }
    }
  });

  // Long-polls legitimately hold connections open — including forever, for a
  // timeout_ms 0 park — so the per-request deadline is disabled entirely;
  // dead connections are reaped by the close-signal path above, and headers
  // still have to arrive promptly.
  server.headersTimeout = 60 * 1000;
  server.requestTimeout = 0;

  return { server, facade };
}

// Stateless streamable-HTTP MCP: one throwaway server+transport per POST, the
// SDK's documented pattern when no server-side session state is needed — the
// hub's state is all in SQLite, addressed explicitly per call.
async function handleMcp(req, res, facade) {
  if (req.method !== "POST") {
    sendJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: the hub MCP endpoint is stateless (POST only)." },
      id: null,
    });
    return;
  }
  const raw = await readBody(req);
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    sendJson(res, 400, { error: "Request body must be JSON-RPC." });
    return;
  }
  const {
    StreamableHTTPServerTransport,
  } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { createUltracodeServer } = require("../../create-server");
  const server = createUltracodeServer({ hubTools: true, hub: facade });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

module.exports = { createHubHttpServer, HubFacade, MAX_BODY_BYTES, DEFAULT_WAIT_MS, MAX_WAIT_MS };
