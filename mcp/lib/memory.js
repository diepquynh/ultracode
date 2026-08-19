"use strict";

// SQLite-backed durable, repo-scoped memory for the ultracode_memory / ultracode_memory_recall /
// ultracode_memory_forget MCP tools. Deliberately uncapped and never auto-expired: a large
// multi-module repo can't be fully explored in one session's token budget, so lessons accumulate
// across many sessions and subagent failures rather than aging out on a timer or a size limit.
// deleteLesson exists only for the narrow, agent-confirmed case — a specific recorded lesson
// turned out to be wrong or stale — so it's a targeted removal by exact (area, lesson), never a
// bulk sweep or an automatic trim. FTS5 (built into node:sqlite) ranks recall results by bm25 so
// an agent can pull just the lessons relevant to its task or failure instead of reading the whole
// store. `timeout` on DatabaseSync sets SQLite's busy_timeout, so concurrent writers (parallel
// phases each recording a lesson) wait on the real SQLite file lock instead of failing outright —
// node:sqlite is real file-backed SQLite, not an in-memory copy that has to be serialized back by
// hand, so this concurrency safety comes for free.

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const BUSY_TIMEOUT_MS = 5000;
const DEFAULT_LIMIT = 8;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area TEXT NOT NULL,
    lesson TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(area, lesson)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(area, lesson, content='lessons', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS lessons_ai AFTER INSERT ON lessons BEGIN
    INSERT INTO lessons_fts(rowid, area, lesson) VALUES (new.id, new.area, new.lesson);
  END;
  CREATE TRIGGER IF NOT EXISTS lessons_ad AFTER DELETE ON lessons BEGIN
    INSERT INTO lessons_fts(lessons_fts, rowid, area, lesson) VALUES('delete', old.id, old.area, old.lesson);
  END;
  CREATE TRIGGER IF NOT EXISTS lessons_au AFTER UPDATE ON lessons BEGIN
    INSERT INTO lessons_fts(lessons_fts, rowid, area, lesson) VALUES('delete', old.id, old.area, old.lesson);
    INSERT INTO lessons_fts(rowid, area, lesson) VALUES (new.id, new.area, new.lesson);
  END;
`;

function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS });
  db.exec(SCHEMA);
  return db;
}

// Newest occurrence of a (area, lesson) pair wins — the row's source/created_at update in
// place rather than inserting a duplicate, so re-learning the same lesson doesn't grow the store.
function recordLesson(dbPath, { area, lesson, source }) {
  const db = openDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO lessons (area, lesson, source, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(area, lesson) DO UPDATE SET source = excluded.source, created_at = excluded.created_at`,
    ).run(area, lesson, source, new Date().toISOString());
    return db.prepare("SELECT count(*) AS total FROM lessons").get().total;
  } finally {
    db.close();
  }
}

// Exact-match removal of a single confirmed-stale lesson, keyed the same way recordLesson
// dedupes (area, lesson) — not a bulk or age-based sweep. No-op (rather than an error) when the
// lesson or the store itself doesn't exist, so a caller acting on a recall result it already has
// in hand can't fail on a race with another agent forgetting the same lesson first.
function deleteLesson(dbPath, { area, lesson }) {
  if (!fs.existsSync(dbPath)) return { deleted: false, total: 0 };
  const db = openDatabase(dbPath);
  try {
    const result = db.prepare(`DELETE FROM lessons WHERE area = ? AND lesson = ?`).run(area, lesson);
    const total = db.prepare("SELECT count(*) AS total FROM lessons").get().total;
    return { deleted: result.changes > 0, total };
  } finally {
    db.close();
  }
}

function escapeFtsToken(token) {
  return `"${token.replace(/"/g, '""')}"`;
}

// Any-token-matches, not all-tokens: recall is recall-oriented (surface anything plausibly
// related), and the caller's own scoring/scope narrows it down, not a strict AND on every word.
function ftsQueryFromText(text) {
  const tokens = (text || "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.map(escapeFtsToken).join(" OR ");
}

function toEntry(row) {
  return { area: row.area, lesson: row.lesson, source: row.source, created_at: row.created_at };
}

// Buckets, most relevant first: lessons scoped to `area` (and its "area::..." sub-scopes),
// ranked by text relevance if a query was given else by recency; then, as fill only, global
// text matches outside that scope; then, only if neither area nor query was given, the most
// recent lessons overall. Deduped across buckets since a row can legitimately appear in more
// than one bucket.
function recallLessons(dbPath, { area, query, limit = DEFAULT_LIMIT } = {}) {
  if (!fs.existsSync(dbPath)) return [];
  const db = openDatabase(dbPath);
  try {
    const ftsQuery = ftsQueryFromText(query);
    const buckets = [];
    if (area && ftsQuery) {
      buckets.push(
        db
          .prepare(
            `SELECT l.area, l.lesson, l.source, l.created_at FROM lessons_fts
             JOIN lessons l ON l.id = lessons_fts.rowid
             WHERE lessons_fts MATCH ? AND (l.area = ? OR l.area LIKE ?)
             ORDER BY bm25(lessons_fts)`,
          )
          .all(ftsQuery, area, `${area}::%`),
      );
    } else if (area) {
      buckets.push(
        db
          .prepare(
            `SELECT area, lesson, source, created_at FROM lessons
             WHERE area = ? OR area LIKE ? ORDER BY created_at DESC`,
          )
          .all(area, `${area}::%`),
      );
    }
    if (ftsQuery) {
      buckets.push(
        db
          .prepare(
            `SELECT l.area, l.lesson, l.source, l.created_at FROM lessons_fts
             JOIN lessons l ON l.id = lessons_fts.rowid
             WHERE lessons_fts MATCH ? ORDER BY bm25(lessons_fts)`,
          )
          .all(ftsQuery),
      );
    } else if (!area) {
      buckets.push(
        db.prepare(`SELECT area, lesson, source, created_at FROM lessons ORDER BY created_at DESC`).all(),
      );
    }

    const seen = new Set();
    const merged = [];
    for (const bucket of buckets) {
      for (const row of bucket) {
        const key = `${row.area}::${row.lesson}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(toEntry(row));
        if (merged.length >= limit) return merged;
      }
    }
    return merged;
  } finally {
    db.close();
  }
}

module.exports = { recordLesson, recallLessons, deleteLesson, ftsQueryFromText, openDatabase };
