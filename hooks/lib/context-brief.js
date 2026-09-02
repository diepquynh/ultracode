#!/usr/bin/env node
// Build the resolved repo brief that gets injected into a subagent's spawn prompt,
// so the agent starts with its routing facts instead of spending its first tool
// calls fetching them.
//
// WHY THIS LIVES HERE AND IS CALLED FROM model-router.js
//
// A PreToolUse `updatedInput` does not merge across hooks. Measured directly: with
// two PreToolUse hooks on the same matcher, both receive the ORIGINAL tool input
// (neither sees the other's edit) and exactly one hook's updatedInput is applied
// — the other's is discarded wholesale. So a second Agent|Task hook emitting
// updatedInput would silently clobber model-router.js's routed `model`, and model
// routing is deny-on-missing-route precisely because an unenforced spawn is not
// acceptable. There is therefore exactly one safe place to rewrite an Agent spawn:
// the hook that already owns that rewrite.
//
// This module is self-contained (node builtins only, no ./common.js) to preserve
// model-router.js's isolation property, and its caller wraps it in try/catch: if
// brief construction throws for any reason, routing proceeds with the prompt
// untouched. A brief bug must never be able to break a spawn.
//
// WHAT GOES IN, AND WHAT DELIBERATELY DOES NOT
//
// INVENTORY.md and repo-profile.json overlap heavily — measured across 8 real
// repo pairs, all `commands.*`, all `moduleMap.*`, `skills[].name/kind`,
// `reviewRules[].id` and most `testTypes` strings appear verbatim in both. Other
// fields are profile-only in every repo (`skills[].path`, `conventions.naming`,
// `conventions.notes`, `testTypes.*.matches`, `testTypes.*.note`, `testFramework`),
// and a third group is repo-dependent — `conventions.immutabilityKeyword` was
// redundant in 6 of 8 repos and unique in the other 2.
//
// That last group is why selection is a RUNTIME containment test against the
// inventory's own text rather than a static field allowlist: the same field is
// duplication in one repo and the only statement of a rule in another.
//
// The brief REPLACES both files rather than supplementing them, so it must carry
// what the agent needs even when the inventory also says it (commands, above all).
// The containment test's job is to avoid stating a fact twice, not to withhold it.
//
// `models.*` is excluded unconditionally. It is routing configuration for the
// hook layer, means nothing to a subagent, and would leak tier names into a
// context where they can only mislead.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_BRIEF_CHARS = 3600;
const MAX_SKILL_ROWS = 16;
const MAX_MODULE_ROWS = 10;

// Which sections each agent gets. An agent that never compiles does not need the
// build command; an agent that never edits code does not need the conventions.
const SECTIONS_BY_AGENT = {
  implement: ["commands", "skills", "conventions", "modules"],
  "write-test": ["commands", "testing", "skills", "conventions", "modules"],
  "code-reviewer": ["commands", "review", "conventions", "skills"],
  "execution-path-analyzer": ["testing", "modules"],
  explore: ["stack", "skills", "modules"],
  plan: ["stack", "commands", "skills", "modules"],
  "generate-spec": ["stack", "modules"],
  "module-documentation": ["skills", "modules"],
  "fact-check": ["stack", "modules"],
  "prompt-generation": ["skills"],
  // hub-wait only relays hub messages; nothing about the repo helps it.
  "hub-wait": [],
};

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// Whitespace-insensitive containment, so a value wrapped across lines or padded
// inside a markdown table cell still counts as already-stated.
function statedIn(haystack, value) {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (text.length < 3) return true; // too short to be distinctive; assume covered
  return haystack.includes(text.replace(/\s+/g, " "));
}

function truncate(value, limit) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// Module-map rows whose glob plausibly covers a path the spawn prompt mentions.
// Without a scope hint the map is not included at all: the full map on a 27-module
// repo is larger than everything else in the brief combined.
function relevantModules(moduleMap, scopeHints) {
  if (!Array.isArray(moduleMap) || !scopeHints.length) return [];
  const hits = [];
  for (const row of moduleMap) {
    if (!row || typeof row.glob !== "string") continue;
    const stem = row.glob.replace(/\*+/g, "").replace(/\/+$/, "");
    if (stem.length < 3) continue;
    if (scopeHints.some((hint) => hint.includes(stem) || stem.includes(hint))) hits.push(row);
  }
  return hits.slice(0, MAX_MODULE_ROWS);
}

// Paths and module-ish tokens named in the spawn prompt, used to narrow the
// module map to the area this spawn is actually about.
function scopeHintsFrom(prompt) {
  const hints = new Set();
  const pathish = prompt.match(/[\w.-]+\/[\w./-]+/g) || [];
  for (const candidate of pathish) {
    const cleaned = candidate.replace(/^\.\//, "");
    if (cleaned.length > 3 && !cleaned.includes("ultracode-")) hints.add(cleaned);
  }
  return [...hints].slice(0, 40);
}

function skillRowsFor(agent, skills, inventoryText) {
  if (!Array.isArray(skills)) return [];
  const wanted = skills.filter((skill) => {
    if (!skill || typeof skill.path !== "string" || !skill.path) return false;
    if (skill.kind === "convention" || skill.kind === "module-hub") return true;
    if (agent === "write-test") return /test|spec/i.test(`${skill.name} ${skill.kind}`);
    if (agent === "code-reviewer") return skill.kind === "convention";
    if (agent === "module-documentation") return skill.kind === "module-hub";
    return true;
  });
  return wanted.slice(0, MAX_SKILL_ROWS).map((skill) => {
    const componentType =
      skill.componentType && !statedIn(inventoryText, skill.componentType)
        ? ` — use for ${truncate(skill.componentType, 48)}`
        : "";
    const name = typeof skill.name === "string" && skill.name ? `\`${skill.name}\` — ` : "";
    return `- ${name}\`${skill.path}\`${componentType}`;
  });
}

// Returns the brief as markdown, or null when there is nothing worth injecting.
function buildBrief({ agent, prompt, repoRoot, runtimeDir }) {
  const profilePath = path.join(repoRoot, runtimeDir, "repo-profile.json");
  const inventoryPath = path.join(repoRoot, runtimeDir, "INVENTORY.md");
  const profile = readJson(profilePath);
  if (!profile) return null;
  const inventoryRaw = readText(inventoryPath) || "";
  const inventory = inventoryRaw.replace(/\s+/g, " ");
  const sections = SECTIONS_BY_AGENT[agent] || ["commands", "skills"];
  if (sections.length === 0) return null;
  const out = [];

  out.push(`## Repo brief — resolved for ultracode:${agent}`);
  out.push(
    "These facts are already resolved from this repo's inventory and machine profile. " +
      "Follow them directly and do NOT open `INVENTORY.md` or `repo-profile.json` to re-read them.",
  );

  if (sections.includes("stack") && profile.stack) {
    const bits = [];
    if (profile.stack.language) bits.push(`language ${profile.stack.language}`);
    if (Array.isArray(profile.stack.frameworks) && profile.stack.frameworks.length) {
      bits.push(`frameworks ${profile.stack.frameworks.join(", ")}`);
    }
    if (profile.stack.buildTool) bits.push(`build tool ${profile.stack.buildTool}`);
    if (profile.testFramework) bits.push(`test framework ${profile.testFramework}`);
    if (bits.length) out.push("", "### Stack", bits.map((bit) => `- ${bit}`).join("\n"));
  }

  if (sections.includes("commands") && profile.commands) {
    const rows = Object.entries(profile.commands)
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([purpose, value]) => `- **${purpose}**: \`${value}\``);
    if (rows.length) {
      out.push(
        "",
        "### Commands — use these exact strings",
        "Substitute `{MODULE}`/`{TEST}`/`{PATH}` placeholders; never invent a different invocation.",
        rows.join("\n"),
      );
    }
  }

  if (sections.includes("testing") && profile.testTypes && typeof profile.testTypes === "object") {
    const rows = [];
    for (const [name, entry] of Object.entries(profile.testTypes)) {
      if (!entry || typeof entry !== "object") continue;
      rows.push(`- **${name}** — \`${entry.commandOne || entry.command || "—"}\``);
      // matches/note are profile-only in every repo measured: they say WHICH
      // files belong to this runner and what it requires to run at all.
      if (Array.isArray(entry.matches) && entry.matches.some((m) => !statedIn(inventory, m))) {
        rows.push(`  - applies to ${truncate(entry.matches.join("; "), 150)}`);
      }
      if (entry.note && !statedIn(inventory, entry.note)) {
        rows.push(`  - ${truncate(entry.note, 190)}`);
      }
      if (entry.reports && !statedIn(inventory, entry.reports)) {
        rows.push(`  - reports at ${truncate(entry.reports, 90)}`);
      }
    }
    if (rows.length) {
      out.push("", "### Test types — pick the runner by what you are testing", rows.join("\n"));
    }
  }

  if (sections.includes("skills")) {
    const rows = skillRowsFor(agent, profile.skills, inventory);
    if (rows.length) {
      out.push(
        "",
        "### Skills — name first, path as fallback",
        "`skills[].name` — `skills[].path` from the machine profile. Load a skill by its name via the " +
          "harness skill tool when its catalog lists that name; if it does not (or answers unknown-skill), " +
          "read the file at the path. Never search for skills or guess paths.",
        rows.join("\n"),
      );
    }
  }

  if (sections.includes("conventions") && profile.conventions) {
    const rows = [];
    if (profile.conventions.naming && !statedIn(inventory, profile.conventions.naming)) {
      rows.push(`- Naming: ${truncate(profile.conventions.naming, 190)}`);
    }
    if (
      profile.conventions.immutabilityKeyword &&
      !statedIn(inventory, profile.conventions.immutabilityKeyword)
    ) {
      rows.push(`- Immutability: ${truncate(profile.conventions.immutabilityKeyword, 90)}`);
    }
    for (const note of profile.conventions.notes || []) {
      if (!statedIn(inventory, note)) rows.push(`- ${truncate(note, 190)}`);
    }
    if (rows.length) {
      out.push("", "### Conventions (not stated in the inventory tables)", rows.join("\n"));
    }
  }

  // The review rule set is the ONE section deliberately exempt from the
  // containment test. For the code-reviewer this catalog is not a routing hint
  // it can look up on demand — it is the agent's entire basis for judgment, and a
  // partial catalog silently narrows what gets reviewed. Since the brief replaces
  // the inventory read, carrying every rule here IS the single statement of it.
  if (sections.includes("review") && Array.isArray(profile.reviewRules)) {
    const rows = profile.reviewRules
      .filter((rule) => rule && rule.id && rule.rule)
      .map(
        (rule) =>
          `- **${rule.id}** (${rule.severity}${rule.autoFixable ? ", auto-fixable" : ""}): ` +
          truncate(rule.rule, 170),
      );
    if (rows.length) {
      out.push(
        "",
        "### Review Rule Set — your complete rule catalog",
        "Apply these IDs and severities. This is the whole set; it is not a summary.",
        rows.join("\n"),
      );
    }
  }

  if (sections.includes("modules")) {
    const rows = relevantModules(profile.moduleMap, scopeHintsFrom(prompt)).map(
      (row) =>
        `- \`${row.glob}\` → ${row.area}` + (row.reference ? ` (reference: ${row.reference})` : ""),
    );
    if (rows.length) {
      out.push("", "### Module map — rows covering the paths named in your task", rows.join("\n"));
    }
  }

  // Nothing but the header means there was nothing to say.
  if (out.length <= 2) return null;

  out.push(
    "",
    `The full inventory is at \`${inventoryPath}\` if you need a table this brief does not carry — ` +
      "reading it is a fallback, not the first step.",
  );

  let brief = out.join("\n");
  if (brief.length > MAX_BRIEF_CHARS) {
    brief = `${brief.slice(0, MAX_BRIEF_CHARS)}\n…(brief truncated; see the inventory for the rest)`;
  }
  return brief;
}

// Returns the augmented prompt, or null to leave the prompt untouched.
function augmentPrompt({ agent, prompt, repoRoot, runtimeDir }) {
  if (!agent || typeof prompt !== "string") return null;
  // Idempotence: a re-spawn (or a harness that re-runs the hook) must not stack
  // briefs on top of each other.
  if (prompt.includes("## Repo brief — resolved for")) return null;
  const brief = buildBrief({ agent, prompt, repoRoot, runtimeDir });
  if (!brief) return null;
  return `${prompt}\n\n---\n\n${brief}\n`;
}

module.exports = { augmentPrompt, buildBrief, statedIn, scopeHintsFrom, SECTIONS_BY_AGENT };
