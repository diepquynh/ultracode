"use strict";

// Pure functions for the durable repo-memory file (knowledge.md), mirroring
// Pi's memory.ts dedupe/compact behavior: newest occurrence of a lesson wins
// and moves to the end, and the file is capped at maxEntries so it cannot
// grow without bound across sessions.

const HEADER = "# ultracode repo memory\n\nOne lesson per line, recorded via the ultracode_memory tool. Do not hand-edit.\n\n";
const ENTRY_RE = /^- \[([^\]]+)\] (.+?) — source: (.+)$/;
const DEFAULT_MAX_ENTRIES = 80;

function parseEntries(text) {
  if (!text) return [];
  const entries = [];
  for (const line of text.split("\n")) {
    const match = line.match(ENTRY_RE);
    if (match) entries.push({ area: match[1], lesson: match[2], source: match[3] });
  }
  return entries;
}

function formatEntries(entries) {
  const lines = entries.map((e) => `- [${e.area}] ${e.lesson} — source: ${e.source}`);
  return HEADER + lines.join("\n") + (lines.length ? "\n" : "");
}

function dedupeAndCompact(entries, maxEntries = DEFAULT_MAX_ENTRIES) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = `${entry.area}::${entry.lesson}`;
    if (byKey.has(key)) byKey.delete(key); // re-insert below so the newest occurrence moves to the end
    byKey.set(key, entry);
  }
  const deduped = [...byKey.values()];
  return deduped.slice(Math.max(0, deduped.length - maxEntries));
}

function appendLesson(text, { area, lesson, source }, maxEntries = DEFAULT_MAX_ENTRIES) {
  const entries = parseEntries(text);
  entries.push({ area, lesson, source });
  return formatEntries(dedupeAndCompact(entries, maxEntries));
}

module.exports = { parseEntries, formatEntries, dedupeAndCompact, appendLesson, DEFAULT_MAX_ENTRIES };
