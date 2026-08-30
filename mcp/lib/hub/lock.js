"use strict";

// Single-instance lock for the hub daemon. One machine gets one hub: the lock
// file is opened with O_EXCL, so two daemons racing at boot cannot both win,
// and a lock left behind by a crashed daemon (dead pid) is detected and
// reclaimed instead of wedging the machine until someone deletes it by hand.

const fs = require("node:fs");
const path = require("node:path");
const { hubLockPath } = require("./config");

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user — still alive.
    return error && error.code === "EPERM";
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  } catch {
    return null;
  }
}

// Returns { acquired: true } or { acquired: false, holder } after one
// stale-lock recovery attempt. Never throws on contention — the caller decides
// whether "already running" is success (hub-ctl ensure) or failure.
function acquireLock({ pid = process.pid, port = null } = {}) {
  const lockPath = hubLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid, port, started_at: new Date().toISOString() }));
      fs.closeSync(fd);
      return { acquired: true };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const holder = readLock(lockPath);
      if (holder && pidAlive(holder.pid)) return { acquired: false, holder };
      // Stale lock (crashed daemon or unreadable file): reclaim once.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return { acquired: false, holder: holder || null };
      }
    }
  }
  return { acquired: false, holder: readLock(lockPath) };
}

// Only the holder removes its own lock — a daemon shutting down after losing
// a race must not delete the winner's lock.
function releaseLock({ pid = process.pid } = {}) {
  const lockPath = hubLockPath();
  const holder = readLock(lockPath);
  if (holder && holder.pid !== pid) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function currentHolder() {
  const holder = readLock(hubLockPath());
  return holder && pidAlive(holder.pid) ? holder : null;
}

module.exports = { acquireLock, releaseLock, currentHolder, pidAlive };
