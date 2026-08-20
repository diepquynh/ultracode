// Port of tests/test_definitions.py to Node's built-in test runner.
// Drives the same harness-neutral generator + hooks pipeline that
// scripts/generate_definitions.py exercised, using only Node stdlib.

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, before, after } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const GENERATOR = path.join(ROOT, "scripts", "generate_definitions.js");
const HOOK = path.join(ROOT, "hooks", "model-router.js");
const INSTALLER = path.join(ROOT, "install.sh");
const UNINSTALLER = path.join(ROOT, "uninstall.sh");

const IGNORED_SOURCE_ENTRIES = [
  ".git",
  ".claude",
  ".codex",
  ".grok",
  ".code-review-graph",
  "dist",
  "tmp",
  "sandbox",
];

const BASELINE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "tests", "claude-baseline.json"), "utf-8"),
);
const TOOL_MAPPING = JSON.parse(
  fs.readFileSync(path.join(ROOT, "definitions", "tool-mapping.json"), "utf-8"),
);
const MODEL_MAPPING = JSON.parse(
  fs.readFileSync(path.join(ROOT, "definitions", "model-mapping.json"), "utf-8"),
);
const HARNESS_LAYOUT = JSON.parse(
  fs.readFileSync(path.join(ROOT, "definitions", "harness-layout.json"), "utf-8"),
);

const LAYOUT_TOKEN_PATTERN = /\{\{[a-z][a-z0-9_]*\}\}/g;

const COMMAND_NAMES = new Set(["init-kit", "orchestrate"]);

let WORKSPACE = null;
let GENERATED_SOURCE_ROOT = null;
let CLAUDE_PLUGIN_ROOT = null;
let CODEX_PLUGIN_ROOT = null;
let GROK_PLUGIN_ROOT = null;
let ANTIGRAVITY_PLUGIN_ROOT = null;
const GENERATOR_STDOUT = {};

// Minimal TOML reader — the generator emits only basic strings and a flat
// top-level key/value surface, so a tiny regex parser is sufficient.
function parseToml(text) {
  const lines = text.split("\n");
  const result = {};
  let buffer = "";
  let currentKey = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (currentKey === null && line.trim().startsWith("#")) continue;
    if (currentKey !== null) {
      buffer += line;
      if (line.includes('"')) {
        result[currentKey] = JSON.parse(buffer);
        buffer = "";
        currentKey = null;
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      const quoteCount = (value.match(/"/g) || []).length;
      if (quoteCount >= 2 && !value.endsWith('\\"')) {
        result[key] = JSON.parse(value);
      } else {
        buffer = value;
        currentKey = key;
      }
      continue;
    }
    result[key] = value;
  }
  return result;
}

function adaptForTarget(text, targetName) {
  const target = HARNESS_LAYOUT.layouts[targetName];
  const replacements = {
    "{{state_dir}}": target.state_dir,
    "{{runtime_dir}}": target.runtime_dir,
    "{{skills_dir}}": target.skills_dir,
    "{{agents_dir}}": target.agents_dir,
    "{{plugin_root}}": `\${${target.plugin_root_env}}`,
    "{{arguments}}":
      targetName === "codex"
        ? "the user's text following the explicit skill invocation"
        : "$ARGUMENTS",
    "{{command_prefix}}": targetName === "codex" ? "$" : "/",
    "{{agent_selector}}": targetName === "codex" ? "agent_type" : "subagent_type",
    "{{session_id_expr}}": target.session_id_expr,
    "{{session_id_source}}": target.session_id_source,
    "{{session_id_names}}": target.session_id_names,
    "{{session_id_agent_names}}": target.session_id_agent_names,
    "{{session_id_inheritance}}": target.session_id_inheritance,
    "{{session_id_unavailable}}": target.session_id_unavailable,
    "{{reload_action}}":
      targetName === "claude"
        ? "running `/reload-plugins` or restarting the session"
        : targetName === "grok"
          ? "pressing `r` in the Plugins tab or starting a new session"
          : targetName === "antigravity"
            ? "restarting the agy session or starting a new session"
            : "starting a new Codex session",
    "{{balanced_model}}": MODEL_MAPPING.tiers.balanced[targetName],
    "{{advanced_model}}": MODEL_MAPPING.tiers.advanced[targetName],
  };
  for (const [id, entry] of Object.entries(TOOL_MAPPING.capabilities)) {
    replacements[`{{tool_${id}}}`] = entry[targetName];
  }
  for (const [token, value] of Object.entries(replacements)) {
    text = text.split(token).join(value);
  }
  return text;
}

function adaptForCodex(text) {
  return adaptForTarget(text, "codex");
}

function runGenerator(target, output, options = {}) {
  const args = ["--target", target, "--output-dir", output];
  if (options.sourceRoot) args.push("--source-root", options.sourceRoot);
  if (options.check) args.push("--check");
  return execFileSync("node", [GENERATOR, ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runGeneratorWithDefaultOutput(target, options = {}) {
  const args = ["--target", target];
  if (options.sourceRoot) args.push("--source-root", options.sourceRoot);
  if (options.check) args.push("--check");
  return execFileSync("node", [GENERATOR, ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function execQuiet(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function copyTreeFiltered(src, dest, ignore) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (ignore.includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTreeFiltered(from, to, ignore);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

before(() => {
  // Build all plugin distributions the way install.sh does: from a clean
  // copy of the sources. The generator's default output path is used on
  // purpose — that `dist/<target>/ultracode` layout is the one install.sh
  // points each harness marketplace at.
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-tests-"));
  GENERATED_SOURCE_ROOT = path.join(WORKSPACE, "checkout");
  copyTreeFiltered(ROOT, GENERATED_SOURCE_ROOT, IGNORED_SOURCE_ENTRIES);
  for (const target of ["claude", "codex", "grok", "antigravity"]) {
    const stdout = runGeneratorWithDefaultOutput(target, {
      sourceRoot: GENERATED_SOURCE_ROOT,
    });
    GENERATOR_STDOUT[target] = stdout;
  }
  CLAUDE_PLUGIN_ROOT = path.join(
    GENERATED_SOURCE_ROOT,
    "dist",
    "claude",
    "ultracode",
  );
  CODEX_PLUGIN_ROOT = path.join(
    GENERATED_SOURCE_ROOT,
    "dist",
    "codex",
    "ultracode",
  );
  GROK_PLUGIN_ROOT = path.join(
    GENERATED_SOURCE_ROOT,
    "dist",
    "grok",
    "ultracode",
  );
  ANTIGRAVITY_PLUGIN_ROOT = path.join(
    GENERATED_SOURCE_ROOT,
    "dist",
    "antigravity",
    "ultracode",
  );
});

after(() => {
  if (WORKSPACE) {
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  }
});

function splitFrontmatter(filePath) {
  const text = fs.readFileSync(filePath, "utf-8");
  if (!text.startsWith("---\n")) {
    throw new Error(`${filePath} has no YAML frontmatter`);
  }
  const marker = text.indexOf("\n---\n", 4);
  if (marker < 0) {
    throw new Error(`${filePath} has unterminated YAML frontmatter`);
  }
  const raw = text.slice(4, marker);
  let body = text.slice(marker + "\n---\n".length);
  if (body.startsWith("\n")) body = body.slice(1);

  const metadata = {};
  let foldedKey = null;
  let foldedLines = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("  ") && foldedKey) {
      foldedLines.push(line.trim());
      continue;
    }
    if (foldedKey) {
      metadata[foldedKey] = foldedLines.join(" ");
      foldedKey = null;
      foldedLines = [];
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon);
    let value = line.slice(colon + 1).trim();
    if (value === ">") {
      foldedKey = key;
    } else if (key === "tools") {
      metadata[key] = value.split(",").map((s) => s.trim());
    } else if (key === "argument-hint" && value.startsWith('"')) {
      metadata[key] = JSON.parse(value);
    } else {
      metadata[key] = value;
    }
  }
  if (foldedKey) {
    metadata[foldedKey] = foldedLines.join(" ");
  }
  return [metadata, body];
}

function fileSnapshot(root) {
  const snapshot = {};
  const stack = [root];
  const collected = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) collected.push(full);
    }
  }
  collected.sort();
  for (const filePath of collected) {
    snapshot[path.relative(root, filePath)] = fs.readFileSync(filePath);
  }
  return snapshot;
}

function snapshotEquals(a, b) {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!a[aKeys[i]].equals(b[bKeys[i]])) return false;
  }
  return true;
}

function sourceDefinitions() {
  const result = [];
  for (const parent of ["agents", "skills", "commands"]) {
    const parentDir = path.join(ROOT, parent);
    if (!fs.existsSync(parentDir)) continue;
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const defPath = path.join(parentDir, entry.name, "definition.json");
      if (!fs.existsSync(defPath)) continue;
      result.push([defPath, JSON.parse(fs.readFileSync(defPath, "utf-8"))]);
    }
  }
  result.sort(([a], [b]) => a.localeCompare(b));
  return result;
}

test("every definition was migrated", () => {
  const definitions = sourceDefinitions();
  assert.equal(definitions.length, 14);
  assert.deepEqual(
    new Set(
      definitions
        .filter(([, d]) => d.kind === "agent")
        .map(([, d]) => d.name),
    ),
    new Set(Object.keys(BASELINE.agents)),
  );
  assert.deepEqual(
    new Set(
      definitions
        .filter(([, d]) => d.kind === "skill")
        .map(([, d]) => d.name),
    ),
    new Set(Object.keys(BASELINE.skills)),
  );
  assert.deepEqual(
    new Set(
      definitions
        .filter(([, d]) => d.kind === "command")
        .map(([, d]) => d.name),
    ),
    COMMAND_NAMES,
  );
  for (const [filePath, data] of definitions) {
    const prompt = path.join(path.dirname(filePath), data.prompt);
    assert.ok(fs.existsSync(prompt), `${prompt} missing`);
    assert.equal(path.dirname(prompt), path.dirname(filePath));
    if (data.kind === "agent") {
      assert.deepEqual(
        Object.keys(data.config.reasoning_effort).sort(),
        ["antigravity", "claude", "codex", "grok"],
        filePath,
      );
    }
  }
});

test("claude generation matches pre-refactor behavior", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-claude-"));
  const stdout = runGenerator("claude", output);
  for (const [kind, relativeParent] of [
    ["agents", "agents"],
    ["skills", "skills"],
  ]) {
    for (const [name, expected] of Object.entries(BASELINE[kind])) {
      const filePath =
        kind === "agents"
          ? path.join(output, "agents", `${name}.md`)
          : path.join(output, "skills", name, "SKILL.md");
      const [metadata, body] = splitFrontmatter(filePath);
      assert.deepEqual(metadata, expected.frontmatter, filePath);
      assert.equal(
        crypto.createHash("sha256").update(body).digest("hex"),
        expected.body_sha256,
        filePath,
      );
    }
  }
  for (const [sourcePath, definition] of sourceDefinitions()) {
    if (definition.kind !== "command") continue;
    const generated = path.join(output, "commands", `${definition.name}.md`);
    const [metadata, body] = splitFrontmatter(generated);
    assert.deepEqual(
      metadata,
      {
        // A command's description carries harness layout tokens too (orchestrate
        // names {{runtime_dir}}/INVENTORY.md), so it goes through the same
        // adaptation the body does.
        description: adaptForTarget(definition.description, "claude"),
        "argument-hint": definition.config.argument_hint,
      },
      generated,
    );
    const sourceBody = fs.readFileSync(
      path.join(path.dirname(sourcePath), definition.prompt),
      "utf-8",
    );
    assert.equal(body, adaptForTarget(sourceBody, "claude"));
  }
  assert.match(stdout, /generated 14 definitions for claude/);
});

test("generation is deterministic for every target", () => {
  for (const target of ["claude", "codex", "grok", "antigravity"]) {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-${target}-a-`));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-${target}-b-`));
    runGenerator(target, first);
    runGenerator(target, second);
    assert.ok(
      snapshotEquals(fileSnapshot(first), fileSnapshot(second)),
      `${target} generation diverged`,
    );
  }
});

test("neutral sources do not hardcode a harness layout", () => {
  const neutralFiles = [
    ...safeGlob("agents/*/definition.json"),
    ...safeGlob("agents/*/prompt.md"),
    ...safeGlob("skills/*/definition.json"),
    ...safeGlob("skills/*/prompt.md"),
    ...safeGlob("commands/*/definition.json"),
    ...safeGlob("commands/*/prompt.md"),
    ...safeGlob("refs/*.md"),
  ];
  assert.ok(neutralFiles.length > 0);
  const concreteTerms = [
    ".claude/",
    ".codex/",
    ".grok/",
    ".agents/",
    "${CLAUDE_PLUGIN_ROOT}",
    "${GROK_PLUGIN_ROOT}",
    "${ANTIGRAVITY_PLUGIN_ROOT}",
    "${AGY_PLUGIN_ROOT}",
    "${PLUGIN_ROOT}",
    "CLAUDE_CODE_SESSION_ID",
    "GROK_SESSION_ID",
    "CODEX_THREAD_ID",
    "ANTIGRAVITY_CONVERSATION_ID",
    "AGY_CONVERSATION_ID",
  ];
  for (const filePath of neutralFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const term of concreteTerms) {
      assert.ok(!content.includes(term), `${filePath} contains ${term}`);
    }
  }
});

function safeGlob(pattern) {
  const [head, ...rest] = pattern.split("/");
  const tail = rest.join("/");
  const dir = path.join(ROOT, head);
  if (!fs.existsSync(dir)) return [];
  const file = tail.match(/^[*][.]([a-z]+)$/);
  if (!file) return [];
  const ext = file[1];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const sub of fs.readdirSync(full)) {
        if (sub.endsWith(`.${ext}`)) results.push(path.join(full, sub));
      }
    } else if (entry.isFile() && entry.name.endsWith(`.${ext}`)) {
      results.push(full);
    }
  }
  return results.sort();
}

test("generated text resolves all layout tokens", () => {
  for (const [target, root] of [
    ["claude", CLAUDE_PLUGIN_ROOT],
    ["codex", CODEX_PLUGIN_ROOT],
    ["grok", GROK_PLUGIN_ROOT],
    ["antigravity", ANTIGRAVITY_PLUGIN_ROOT],
  ]) {
    const stack = [root];
    const textFiles = [];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          if ([".md", ".toml", ".json", ".sh", ".js"].includes(path.extname(full))) {
            textFiles.push(full);
          }
        }
      }
    }
    assert.ok(textFiles.length > 0, `${target} had no text files`);
    for (const filePath of textFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      assert.equal(
        LAYOUT_TOKEN_PATTERN.exec(content),
        null,
        `${filePath} contains unresolved layout tokens`,
      );
    }
  }
});

test("codex agents are valid TOML", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-codex-toml-"));
  runGenerator("codex", output);
  for (const [sourcePath, definition] of sourceDefinitions()) {
    const name = definition.name;
    if (definition.kind === "skill" || definition.kind === "command") {
      const [metadata, body] = splitFrontmatter(
        path.join(output, "skills", name, "SKILL.md"),
      );
      assert.equal(metadata.name, name);
      assert.ok(
        body.endsWith(
          adaptForCodex(
            fs.readFileSync(
              path.join(path.dirname(sourcePath), definition.prompt),
              "utf-8",
            ),
          ),
        ),
      );
      if (definition.kind === "command") {
        const invocationMetadata = fs.readFileSync(
          path.join(output, "skills", name, "agents", "openai.yaml"),
          "utf-8",
        );
        assert.match(invocationMetadata, /interface:\n/);
        assert.match(invocationMetadata, /  display_name: /);
        assert.match(invocationMetadata, /  short_description: /);
        assert.match(
          invocationMetadata,
          /policy:\n  allow_implicit_invocation: false\n/,
        );
      }
      continue;
    }
    const generated = path.join(output, "agents", `${name}.toml`);
    const parsed = parseToml(fs.readFileSync(generated, "utf-8"));
    const expectedKeys = new Set([
      "name",
      "description",
      "model_reasoning_effort",
      "sandbox_mode",
      "developer_instructions",
    ]);
    assert.deepEqual(new Set(Object.keys(parsed)), expectedKeys);
    assert.equal(parsed.name, name);
    assert.equal(parsed.description, adaptForCodex(definition.description));
    assert.ok(
      parsed.developer_instructions.endsWith(
        adaptForCodex(
          fs.readFileSync(
            path.join(path.dirname(sourcePath), definition.prompt),
            "utf-8",
          ),
        ),
      ),
    );
    const expectedSandbox = ["edit", "write"].some((t) =>
      definition.config.tools.includes(t),
    )
      ? "workspace-write"
      : "read-only";
    assert.equal(parsed.sandbox_mode, expectedSandbox);
  }
});

test("model tiers map to every harness", () => {
  assert.deepEqual(MODEL_MAPPING.tiers, {
    fast: { claude: "haiku", codex: "gpt-5.6-luna", grok: "grok-4.6", antigravity: "gemini-3.7-flash-high" },
    balanced: { claude: "sonnet", codex: "gpt-5.6-terra", grok: "grok-4.6", antigravity: "gemini-3.7-flash-high" },
    advanced: { claude: "opus", codex: "gpt-5.6-sol", grok: "grok-4.6", antigravity: "claude-opus-4-6-thinking" },
  });
  for (const [, definition] of sourceDefinitions()) {
    if (definition.kind === "agent") {
      assert.ok(
        Object.prototype.hasOwnProperty.call(
          MODEL_MAPPING.tiers,
          definition.config.model_tier,
        ),
      );
    }
  }
});

test("tool mapping covers declared and referenced tools", () => {
  const capabilities = TOOL_MAPPING.capabilities;
  const declaredClaudeTools = new Set();
  for (const [, definition] of sourceDefinitions()) {
    if (definition.kind !== "agent") continue;
    for (const capabilityId of definition.config.tools) {
      assert.ok(capabilities[capabilityId], `unmapped capability: ${capabilityId}`);
      const entry = capabilities[capabilityId];
      assert.ok(entry.claude);
      assert.ok(entry.codex);
      assert.ok(entry.grok);
      assert.ok(entry.antigravity);
      declaredClaudeTools.add(entry.claude);
    }
  }
  const expectedDeclared = new Set();
  for (const agent of Object.values(BASELINE.agents)) {
    for (const tool of agent.frontmatter.tools) {
      expectedDeclared.add(tool);
    }
  }
  assert.deepEqual(declaredClaudeTools, expectedDeclared);
  // delegate/ask_user/plan are never declared in an agent's config.tools (only the orchestrator
  // skill's prose uses their {{tool_*}} placeholders directly) — assert their claude-native names
  // still match what that prose assumes.
  assert.equal(capabilities.delegate.claude, "Agent");
  assert.equal(capabilities.ask_user.claude, "AskUserQuestion");
  assert.equal(capabilities.plan.claude, "EnterPlanMode");
  assert.equal(capabilities.delegate.antigravity, "invoke_subagent");
  assert.equal(capabilities.ask_user.antigravity, "ask_question");
  assert.equal(capabilities.plan.antigravity, "present the plan");
});

test("{{tool_*}} placeholders resolve to the correct harness-native name", () => {
  for (const [id, entry] of Object.entries(TOOL_MAPPING.capabilities)) {
    const token = `{{tool_${id}}}`;
    assert.equal(adaptForTarget(token, "claude"), entry.claude);
    assert.equal(adaptForTarget(token, "codex"), entry.codex);
    assert.equal(adaptForTarget(token, "grok"), entry.grok);
    assert.equal(adaptForTarget(token, "antigravity"), entry.antigravity);
  }
});

test("codex and grok load skills by reading SKILL.md, not a Skill tool", () => {
  const skill = TOOL_MAPPING.capabilities.skill;
  assert.equal(skill.claude, "Skill");
  assert.equal(skill.codex, "exec_command on the skill's SKILL.md");
  assert.equal(skill.grok, "read_file on the skill's SKILL.md");
  assert.match(skill.codex_strategy, /Codex has no Skill tool/);
  assert.match(skill.grok_strategy, /Grok Build has no Skill tool/);

  const implementGrok = fs.readFileSync(
    path.join(GROK_PLUGIN_ROOT, "agents", "implement.md"),
    "utf-8",
  );
  assert.match(implementGrok, /Grok Build has no Skill tool/);
  assert.match(implementGrok, /read_file on the skill's SKILL.md/);
  assert.match(implementGrok, /\.grok\/skills\/\{name\}\/SKILL\.md/);
  assert.doesNotMatch(implementGrok, /NEVER read a skill's `SKILL\.md`/);
  assert.doesNotMatch(implementGrok, /skill discovery/);
  assert.match(
    implementGrok,
    /^tools: read_file, search_replace, search_replace, run_terminal_command, grep, list_dir$/m,
  );

  const writeTestGrok = fs.readFileSync(
    path.join(GROK_PLUGIN_ROOT, "agents", "write-test.md"),
    "utf-8",
  );
  assert.match(writeTestGrok, /read_file on the skill's SKILL.md/);
  assert.doesNotMatch(writeTestGrok, /never use read_file on a SKILL.md file directly/i);

  const implementCodex = parseToml(
    fs.readFileSync(path.join(CODEX_PLUGIN_ROOT, "agents", "implement.toml"), "utf-8"),
  ).developer_instructions;
  assert.match(implementCodex, /Codex has no Skill tool/);
  assert.match(implementCodex, /exec_command on the skill's SKILL.md/);
  assert.match(implementCodex, /\.agents\/skills\/\{name\}\/SKILL\.md/);
  assert.doesNotMatch(implementCodex, /NEVER read a skill's `SKILL\.md`/);
  assert.doesNotMatch(implementCodex, /skill discovery/);
  assert.match(
    implementCodex,
    /Limit direct tool use in this role to these Codex capabilities: `exec_command`, `apply_patch`/,
  );
});

test("generated output passes check mode", () => {
  for (const [target, root] of [
    ["claude", CLAUDE_PLUGIN_ROOT],
    ["codex", CODEX_PLUGIN_ROOT],
    ["grok", GROK_PLUGIN_ROOT],
    ["antigravity", ANTIGRAVITY_PLUGIN_ROOT],
  ]) {
    runGenerator(target, root, { check: true, sourceRoot: GENERATED_SOURCE_ROOT });
  }
});

test("check mode detects stale output", () => {
  const output = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-stale-")),
    "ultracode",
  );
  runGenerator("claude", output);
  const stale = path.join(output, "skills", "meta-author", "SKILL.md");
  fs.appendFileSync(stale, "drift\n", "utf-8");
  assert.throws(
    () => runGenerator("claude", output, { check: true }),
    /definitions are not current/,
  );
});

test("default output uses nested harness plugin root", () => {
  for (const [target, expectedRoot] of [
    ["claude", CLAUDE_PLUGIN_ROOT],
    ["codex", CODEX_PLUGIN_ROOT],
    ["grok", GROK_PLUGIN_ROOT],
    ["antigravity", ANTIGRAVITY_PLUGIN_ROOT],
  ]) {
    assert.equal(
      expectedRoot,
      path.join(GENERATED_SOURCE_ROOT, "dist", target, "ultracode"),
    );
    assert.ok(GENERATOR_STDOUT[target].includes(String(expectedRoot)));
    assert.ok(
      fs.existsSync(path.join(expectedRoot, "hooks", "hooks.json")),
    );
  }
});

test("distributions are generated not committed", { skip: !fs.existsSync(path.join(ROOT, ".git")) }, () => {
  const tracked = execQuiet("git", ["ls-files", "dist"], { cwd: ROOT });
  assert.equal(tracked.trim(), "");
  const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf-8");
  assert.ok(gitignore.includes("/dist/"));
});

test("installer generates each plugin root from the checkout", () => {
  const script = fs.readFileSync(INSTALLER, "utf-8");
  assert.match(script, /PLUGIN_ROOT="\$INSTALL_DIR\/dist\/\$HARNESS\/ultracode"/);
  assert.match(script, /rm -rf "\$PLUGIN_ROOT"/);
  assert.match(
    script,
    /node "\$GENERATOR" --target "\$HARNESS" --source-root "\$INSTALL_DIR" --output-dir "\$PLUGIN_ROOT"/,
  );
});

test("installer installs the bundled MCP server's dependencies into each plugin root", () => {
  const script = fs.readFileSync(INSTALLER, "utf-8");
  assert.match(script, /command -v npm/);
  assert.match(script, /cd "\$PLUGIN_ROOT" && npm ci --omit=dev --ignore-scripts/);
  // Must run after generation produces $PLUGIN_ROOT's package.json/package-lock.json, and before
  // either harness's plugin-registration step that would try to run the server.
  const generateIndex = script.indexOf("node \"$GENERATOR\"");
  const npmCiIndex = script.indexOf("npm ci --omit=dev");
  const claudeRegisterIndex = script.indexOf('if [ "$HARNESS" = claude ]');
  assert.ok(generateIndex > 0 && npmCiIndex > generateIndex);
  assert.ok(claudeRegisterIndex > 0 && claudeRegisterIndex > npmCiIndex);
});

test("real npm ci against the generated plugin root installs a working ultracode_gate MCP server", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-mcp-install-"));
  runGenerator("claude", output);
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: output,
    encoding: "utf-8",
  });
  assert.ok(fs.statSync(path.join(output, "node_modules", "@modelcontextprotocol", "sdk")).isDirectory());
  assert.ok(fs.statSync(path.join(output, "node_modules", "zod")).isDirectory());
  // A closed stdin (no client attached) makes the stdio transport shut down cleanly and quickly —
  // exit 0 with no stderr means the module graph resolved and the server started without error.
  const result = execFileSync("node", [path.join(output, "mcp", "gate-server.js")], {
    input: "",
    encoding: "utf-8",
  });
  assert.equal(result, "");
});

function pluginRootFor(target) {
  if (target === "claude") return CLAUDE_PLUGIN_ROOT;
  if (target === "codex") return CODEX_PLUGIN_ROOT;
  if (target === "grok") return GROK_PLUGIN_ROOT;
  if (target === "antigravity") return ANTIGRAVITY_PLUGIN_ROOT;
  throw new Error(`unknown target: ${target}`);
}

function expectedModel(target, tier) {
  return MODEL_MAPPING.tiers[tier][target];
}

test("installer dry run covers every harness", () => {
  for (const target of ["claude", "codex", "grok", "antigravity"]) {
    const result = execFileSync(
      "bash",
      [INSTALLER, target, "--dry-run"],
      { cwd: ROOT, encoding: "utf-8" },
    );
    assert.ok(result.includes(`for ${target}`), result);
    assert.ok(result.includes("Would generate dist/<harness>/ultracode"));
    assert.ok(result.includes("local marketplace"));
    assert.ok(!result.includes("Would register the Grok fast-tier model"));
  }
  const all = execFileSync(
    "bash",
    [INSTALLER, "--dry-run"],
    { cwd: ROOT, encoding: "utf-8" },
  );
  assert.ok(all.includes("for claude grok codex antigravity"));
  assert.ok(!all.includes("Would register the Grok fast-tier model"));
});

test("installer reports missing harness before installing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-install-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  for (const tool of ["bash", "node", "npm", "git"]) {
    const toolPath = execQuiet("which", [tool]);
    assert.ok(toolPath, `${tool} not on PATH`);
    fs.symlinkSync(toolPath.trim(), path.join(binDir, tool));
  }
  const env = {
    ...process.env,
    PATH: binDir,
    ULTRACODE_INSTALL_DIR: path.join(tempDir, "ultracode"),
  };
  let stderr = "";
  try {
    execFileSync("bash", [INSTALLER, "claude"], {
      cwd: ROOT,
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail("installer should have failed");
  } catch (err) {
    stderr = err.stderr || "";
    assert.equal(err.status, 1);
  }
  assert.ok(stderr.includes("Missing harness CLI(s): claude"), stderr);
  assert.ok(stderr.includes("npm install -g @anthropic-ai/claude-code"), stderr);
  assert.ok(!fs.existsSync(path.join(tempDir, "ultracode")));
});

test("uninstaller unregisters each harness plugin and marketplace install.sh configured", () => {
  const script = fs.readFileSync(UNINSTALLER, "utf-8");
  assert.match(script, /claude plugin uninstall ultracode@ultracode/);
  assert.match(script, /claude plugin marketplace remove ultracode/);
  assert.match(script, /grok plugin uninstall ultracode --confirm/);
  assert.match(script, /agy plugin uninstall ultracode/);
  assert.match(script, /codex plugin remove ultracode@ultracode-local/);
  assert.match(script, /codex plugin marketplace remove ultracode-local/);
  assert.match(script, /MARKETPLACE_ROOT="\$\{INSTALL_DIR\}-marketplace\/codex"/);
  assert.match(script, /rm -rf "\$MARKETPLACE_ROOT"/);
  assert.match(script, /rm -rf "\$INSTALL_DIR"/);
  const claudeUninstallIndex = script.indexOf("claude plugin uninstall ultracode@ultracode");
  const claudeMarketplaceIndex = script.indexOf("claude plugin marketplace remove ultracode");
  const installDirIndex = script.indexOf("rm -rf \"$INSTALL_DIR\"");
  assert.ok(claudeUninstallIndex > 0 && claudeMarketplaceIndex > claudeUninstallIndex);
  assert.ok(installDirIndex > claudeMarketplaceIndex);
});

test("uninstaller dry run covers every harness", () => {
  for (const target of ["claude", "codex", "grok", "antigravity"]) {
    const result = execFileSync(
      "bash",
      [UNINSTALLER, target, "--dry-run"],
      { cwd: ROOT, encoding: "utf-8" },
    );
    assert.ok(result.includes(`for ${target}`), result);
    assert.ok(result.includes("Would unregister the local marketplace"));
    assert.ok(result.includes("Codex local marketplace checkout"));
    assert.ok(result.includes("when uninstalling every harness"));
  }
  const all = execFileSync(
    "bash",
    [UNINSTALLER, "--dry-run"],
    { cwd: ROOT, encoding: "utf-8" },
  );
  assert.ok(all.includes("for claude grok codex antigravity"));
});

test("uninstaller reports missing harness before uninstalling", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-uninstall-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  const toolPath = execQuiet("which", ["bash"]);
  assert.ok(toolPath, "bash not on PATH");
  fs.symlinkSync(toolPath.trim(), path.join(binDir, "bash"));
  const installDir = path.join(tempDir, "ultracode");
  fs.mkdirSync(installDir);
  const env = {
    ...process.env,
    PATH: binDir,
    ULTRACODE_INSTALL_DIR: installDir,
  };
  let stderr = "";
  try {
    execFileSync("bash", [UNINSTALLER, "claude"], {
      cwd: ROOT,
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail("uninstaller should have failed");
  } catch (err) {
    stderr = err.stderr || "";
    assert.equal(err.status, 1);
  }
  assert.ok(stderr.includes("Missing harness CLI(s): claude"), stderr);
  assert.ok(stderr.includes("npm install -g @anthropic-ai/claude-code"), stderr);
  assert.ok(fs.existsSync(installDir));
});

test("uninstaller refuses an unsafe install dir", () => {
  for (const unsafe of ["/", process.env.HOME]) {
    assert.ok(unsafe, "HOME must be set");
    try {
      execFileSync("bash", [UNINSTALLER, "--dry-run"], {
        cwd: ROOT,
        encoding: "utf-8",
        env: { ...process.env, ULTRACODE_INSTALL_DIR: unsafe },
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.fail(`uninstaller should refuse ULTRACODE_INSTALL_DIR=${unsafe}`);
    } catch (err) {
      assert.equal(err.status, 2);
      assert.ok((err.stderr || "").includes("Refusing unsafe ULTRACODE_INSTALL_DIR"), err.stderr);
    }
  }
});

test("installer reports missing node before installing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-node-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  for (const tool of ["bash", "git"]) {
    const toolPath = execQuiet("which", [tool]);
    assert.ok(toolPath, `${tool} not on PATH`);
    fs.symlinkSync(toolPath.trim(), path.join(binDir, tool));
  }
  const env = {
    ...process.env,
    PATH: binDir,
    ULTRACODE_INSTALL_DIR: path.join(tempDir, "ultracode"),
  };
  let stderr = "";
  try {
    execFileSync("bash", [INSTALLER, "claude"], {
      cwd: ROOT,
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail("installer should have failed");
  } catch (err) {
    stderr = err.stderr || "";
    assert.equal(err.status, 1);
  }
  assert.ok(stderr.includes("Node is required"), stderr);
  assert.ok(stderr.includes("https://nodejs.org/"), stderr);
  assert.ok(!fs.existsSync(path.join(tempDir, "ultracode")));
});

function runHook(hookPath, input, env) {
  return execFileSync(
    "node",
    [hookPath],
    {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function routeProfileTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-router-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const profilePath = path.join(repo, runtimeDir, "repo-profile.json");
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const profile = {
    models: {
      byAgent: { "code-reviewer": "balanced" },
      byPhaseComplexity: {},
    },
  };
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const pluginRoot = pluginRootFor(target);
  const hookInput = {
    cwd: repo,
    tool_input: {
      subagent_type: "ultracode:code-reviewer",
      prompt: `Repo root: ${repo}`,
    },
  };
  const expected = expectedModel(target, "balanced");
  const hookPath = path.join(pluginRoot, "hooks", "model-router.js");
  const run = (input = hookInput) =>
    runHook(hookPath, input, { PLUGIN_ROOT: pluginRoot });

  let output = JSON.parse(run()).hookSpecificOutput;
  assert.equal(output.updatedInput.model, expected);
  if (target === "codex") assert.equal(output.permissionDecision, "allow");

  const matched = JSON.parse(
    run({
      ...hookInput,
      tool_input: { ...hookInput.tool_input, model: expected },
    }),
  ).hookSpecificOutput;
  assert.equal(matched.updatedInput.model, expected);

  const aliased = JSON.parse(
    run({
      ...hookInput,
      tool_input: { ...hookInput.tool_input, model: "balanced" },
    }),
  ).hookSpecificOutput;
  assert.equal(aliased.updatedInput.model, expected);

  const conflicted = JSON.parse(
    run({
      ...hookInput,
      tool_input: { ...hookInput.tool_input, model: "wrong-model" },
    }),
  ).hookSpecificOutput;
  assert.equal(conflicted.permissionDecision, "deny");
  assert.match(conflicted.permissionDecisionReason, /does not match the routed model/);
  assert.match(conflicted.permissionDecisionReason, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  profile.models.byAgent["code-reviewer"] = "inherit";
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const inherited = run({
    ...hookInput,
    tool_input: { ...hookInput.tool_input, model: "wrong-model" },
  });
  assert.equal(inherited, "");

  profile.models.byAgent["code-reviewer"] = "default";
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const defaultOutput = JSON.parse(run()).hookSpecificOutput;
  assert.equal(defaultOutput.updatedInput.model, expected);

  profile.models.byAgent["code-reviewer"] = {
    claude: "custom-claude-model",
    codex: "custom-codex-model",
    grok: "custom-grok-model",
  };
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const targetOutput = JSON.parse(run()).hookSpecificOutput;
  assert.equal(targetOutput.updatedInput.model, `custom-${target}-model`);

  delete profile.models.byAgent["code-reviewer"];
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const denied = JSON.parse(run()).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /no model route/);
}

test("model router rewrites and honors explicit fallbacks", () => {
  routeProfileTest("claude");
  routeProfileTest("codex");
  routeProfileTest("grok");
});

// The brief is injected by model-router.js rather than by its own hook because a
// PreToolUse `updatedInput` does not merge across hooks: measured directly, both
// hooks see the original input and only one hook's updatedInput survives. A
// separate brief hook would clobber the routed model. These tests pin the two
// properties that matter: routing still wins, and a brief failure is never fatal.
function contextBriefTest(target) {
  const pluginRoot = pluginRootFor(target);
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const skillsDir = HARNESS_LAYOUT.layouts[target].skills_dir;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-brief-${target}-`));
  fs.mkdirSync(path.join(repo, runtimeDir), { recursive: true });

  const profile = {
    schemaVersion: 1,
    stack: { language: "java", frameworks: ["spring-boot"], buildTool: "maven-wrapper" },
    commands: { build: "./mvnw -q compile", test: "./mvnw test", lint: null },
    testFramework: "junit5+mockito",
    moduleMap: [
      { glob: "core/**", area: "Core domain", reference: null },
      { glob: "web/**", area: "Web layer", reference: null },
    ],
    skills: [
      { name: "convention", kind: "convention", path: `${skillsDir}/convention/SKILL.md` },
      { name: "entity", kind: "creation", path: `${skillsDir}/entity/SKILL.md`, componentType: "entity" },
    ],
    conventions: { naming: "SuffixedClassNames", immutabilityKeyword: "final", notes: ["always use LogUtils"] },
    reviewRules: [
      { id: "C1", rule: "constructor injection only", severity: "H", autoFixable: false },
      { id: "C2", rule: "one timestamp per method", severity: "M", autoFixable: true },
    ],
    models: { byAgent: { explore: "advanced", "code-reviewer": "balanced" }, byPhaseComplexity: {} },
  };
  fs.writeFileSync(path.join(repo, runtimeDir, "repo-profile.json"), JSON.stringify(profile), "utf-8");
  // The inventory already states the build command and the module map, so the
  // containment test must not restate them; it does NOT state the conventions.
  fs.writeFileSync(
    path.join(repo, runtimeDir, "INVENTORY.md"),
    [
      "# demo — ultracode Inventory",
      "| build | `./mvnw -q compile` |",
      "| `core/**` | Core domain |",
      "| C1 | constructor injection only | H |",
    ].join("\n"),
    "utf-8",
  );

  const route = (toolInput) =>
    runHook(path.join(pluginRoot, "hooks", "model-router.js"), { cwd: repo, tool_input: toolInput }, {
      PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      GROK_PLUGIN_ROOT: pluginRoot,
    });

  const explorePrompt = `Repo root: ${repo}\nExplore core/src/main/java/Foo.java`;
  const parsed = JSON.parse(route({ subagent_type: "ultracode:explore", prompt: explorePrompt }));
  const updated = parsed.hookSpecificOutput.updatedInput;

  // Routing still applies — the whole reason this lives in model-router.
  assert.equal(updated.model, expectedModel(target, "advanced"), `${target}: routed model preserved`);

  const brief = updated.prompt;
  assert.match(brief, /## Repo brief — resolved for ultracode:explore/);
  assert.ok(brief.startsWith(explorePrompt), `${target}: brief appends, never replaces the prompt`);
  // Profile-only facts are carried, by path for skills.
  assert.ok(
    brief.includes(`${skillsDir}/convention/SKILL.md`),
    `${target}: brief carries the convention skill's path`,
  );
  assert.match(brief, /does NOT resolve per-repo skill names/);
  assert.match(brief, /maven-wrapper/);
  // Module map is narrowed to the path the prompt names.
  assert.match(brief, /Core domain/);
  assert.ok(!brief.includes("Web layer"), `${target}: unrelated module rows are excluded`);
  // Routing config is never leaked into a subagent's context.
  assert.ok(!brief.includes("byPhaseComplexity"), `${target}: models block excluded`);
  assert.ok(!brief.includes("balanced"), `${target}: model tiers excluded`);

  // Idempotent: re-spawning with an already-briefed prompt must not stack briefs.
  const second = JSON.parse(route({ subagent_type: "ultracode:explore", prompt: brief }));
  const secondPrompt = second.hookSpecificOutput.updatedInput.prompt;
  assert.equal(
    (secondPrompt.match(/## Repo brief — resolved for/g) || []).length,
    1,
    `${target}: brief is not applied twice`,
  );

  // code-reviewer gets the COMPLETE rule set, including rules the inventory
  // already states — a partial catalog would silently narrow what gets reviewed.
  const reviewer = JSON.parse(
    route({ subagent_type: "ultracode:code-reviewer", prompt: `Repo root: ${repo}` }),
  ).hookSpecificOutput.updatedInput.prompt;
  assert.match(reviewer, /\*\*C1\*\*/);
  assert.match(reviewer, /\*\*C2\*\*/);
  // Conventions are absent from the inventory, so they must appear.
  assert.match(reviewer, /always use LogUtils/);

  // No profile at all: routing behavior is unchanged and no brief is invented.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-brief-bare-${target}-`));
  const bareOut = runHook(
    path.join(pluginRoot, "hooks", "model-router.js"),
    { cwd: bare, tool_input: { subagent_type: "ultracode:explore", prompt: `Repo root: ${bare}` } },
    { PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_ROOT: pluginRoot, GROK_PLUGIN_ROOT: pluginRoot },
  );
  if (bareOut.trim()) {
    const bareInput = JSON.parse(bareOut).hookSpecificOutput.updatedInput;
    assert.ok(!String(bareInput.prompt || "").includes("Repo brief"), `${target}: no brief without a profile`);
  }
}

test("context brief is injected with the routed model and never overrides it", () => {
  contextBriefTest("claude");
  contextBriefTest("codex");
  contextBriefTest("grok");
});

function routeInitializerTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-init-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const profilePath = path.join(repo, runtimeDir, "repo-profile.json");
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const profile = {
    models: { byAgent: { explore: "advanced" }, byPhaseComplexity: {} },
  };
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const pluginRoot = pluginRootFor(target);
  const explicitTierModel = expectedModel(target, "fast");
  const hookInput = {
    cwd: repo,
    tool_input: {
      subagent_type: "ultracode:initializer",
      prompt: `Repo root: ${repo}`,
      model: "chosen-by-init-kit",
    },
  };

  const route = () => {
    const stdout = runHook(
      path.join(pluginRoot, "hooks", "model-router.js"),
      hookInput,
      { PLUGIN_ROOT: pluginRoot },
    );
    return JSON.parse(stdout).hookSpecificOutput;
  };

  const first = route();
  assert.notEqual(first.permissionDecision, "deny");
  assert.equal(first.updatedInput.model, "chosen-by-init-kit");

  profile.models.byAgent.initializer = "fast";
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const overridden = route();
  assert.equal(overridden.permissionDecision, "deny");
  assert.match(overridden.permissionDecisionReason, /does not match the routed model/);
  assert.match(
    overridden.permissionDecisionReason,
    new RegExp(explicitTierModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  hookInput.tool_input = { ...hookInput.tool_input };
  delete hookInput.tool_input.model;
  const rewritten = route();
  assert.notEqual(rewritten.permissionDecision, "deny");
  assert.equal(rewritten.updatedInput.model, explicitTierModel);
}

test("model router keeps the initializer model when reinitializing", () => {
  routeInitializerTest("claude");
  routeInitializerTest("codex");
  routeInitializerTest("grok");
});

function routeFactCheckExemptionTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-fcroute-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const profilePath = path.join(repo, runtimeDir, "repo-profile.json");
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  // A profile that predates the fact-check agent: no "fact-check" key at all.
  fs.writeFileSync(
    profilePath,
    JSON.stringify({ models: { byAgent: { explore: "advanced" }, byPhaseComplexity: {} } }),
    "utf-8",
  );
  const pluginRoot = pluginRootFor(target);
  const hookInput = {
    cwd: repo,
    tool_input: {
      subagent_type: "ultracode:fact-check",
      prompt: `Repo root: ${repo}`,
      model: "chosen-by-caller",
    },
  };
  const stdout = runHook(
    path.join(pluginRoot, "hooks", "model-router.js"),
    hookInput,
    { PLUGIN_ROOT: pluginRoot },
  );
  // Exempt like the initializer: no route present -> keep the caller's model, never deny.
  if (stdout) {
    const output = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(output.permissionDecision, "deny");
    assert.equal(output.updatedInput.model, "chosen-by-caller");
  }
}

test("model router exempts fact-check from requiring an explicit route", () => {
  routeFactCheckExemptionTest("claude");
  routeFactCheckExemptionTest("codex");
  routeFactCheckExemptionTest("grok");
});

test("model router denies a malformed profile", () => {
  for (const content of ["not json", "[]"]) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-bad-profile-"));
    const repo = tempDir;
    const runtimeDir = HARNESS_LAYOUT.layouts.claude.runtime_dir;
    const profilePath = path.join(repo, runtimeDir, "repo-profile.json");
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, content, "utf-8");
    const hookInput = {
      cwd: repo,
      tool_input: {
        subagent_type: "ultracode:explore",
        prompt: `Repo root: ${repo}`,
      },
    };
    const stdout = runHook(
      path.join(CLAUDE_PLUGIN_ROOT, "hooks", "model-router.js"),
      hookInput,
      { PLUGIN_ROOT: CLAUDE_PLUGIN_ROOT },
    );
    const denied = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(denied.permissionDecision, "deny");
    assert.match(denied.permissionDecisionReason, /is invalid/);
  }
});

function reviewCapTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-reviewcap-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const pluginRoot = pluginRootFor(target);
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const prompt = `Repo root: ${repo}.\nSession dir: ${sessionDir}.`;
  const hookInput = {
    cwd: repo,
    session_id: "testsess",
    tool_input: { subagent_type: "ultracode:code-reviewer", prompt },
  };
  const run = () =>
    runHook(path.join(pluginRoot, "hooks", "review-cap.js"), hookInput, {
      PLUGIN_ROOT: pluginRoot,
    });

  assert.equal(run(), ""); // no ledger yet — first pass allowed

  const ledgerPath = path.join(sessionDir, "ultracode-review-ledger.md");
  fs.writeFileSync(
    ledgerPath,
    "## Iteration 1 (context: implementation)\n\n## Iteration 2 (context: implementation)\n",
    "utf-8",
  );
  assert.equal(run(), ""); // 2 prior iterations — still allowed

  fs.appendFileSync(ledgerPath, "\n## Iteration 3 (context: implementation)\n", "utf-8");
  const denied = JSON.parse(run()).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /review loop cap reached \(3\/3\)/);
}

test("review-cap denies a 4th code-review iteration", () => {
  reviewCapTest("claude");
  reviewCapTest("codex");
  reviewCapTest("grok");
});

function sessionGuardTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-sessguard-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const pluginRoot = pluginRootFor(target);
  const expectedDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  const hookPath = path.join(pluginRoot, "hooks", "session-guard.js");
  const run = (prompt) =>
    runHook(
      hookPath,
      { cwd: repo, session_id: "testsess", tool_input: { subagent_type: "ultracode:explore", prompt } },
      { PLUGIN_ROOT: pluginRoot },
    );

  assert.equal(run(`Repo root: ${repo}.\nSession dir: ${expectedDir}.`), "");
  assert.equal(run(`Repo root: ${repo}.\nSession dir: ${path.join(expectedDir, "backend")}.`), "");

  const missing = JSON.parse(run(`Repo root: ${repo}.`)).hookSpecificOutput;
  assert.equal(missing.permissionDecision, "deny");
  assert.match(missing.permissionDecisionReason, /no Session dir:/);

  const wrong = JSON.parse(
    run(`Repo root: ${repo}.\nSession dir: ${path.join(repo, runtimeDir, "session", "ultracode-session-RANDOM")}.`),
  ).hookSpecificOutput;
  assert.equal(wrong.permissionDecision, "deny");
  assert.match(wrong.permissionDecisionReason, new RegExp(expectedDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("session-guard denies a missing or invented Session dir:", () => {
  sessionGuardTest("claude");
  sessionGuardTest("codex");
  sessionGuardTest("grok");
});

function bashGuardTest(target) {
  const pluginRoot = pluginRootFor(target);
  const hookPath = path.join(pluginRoot, "hooks", "bash-guard.js");
  const run = (command, agentType) =>
    runHook(hookPath, {
      tool_input: { command },
      ...(agentType ? { agent_type: agentType } : {}),
    });

  for (const command of ["sleep 5", "true", ":", "wait", "while true; do sleep 1; done"]) {
    const denied = JSON.parse(run(command)).hookSpecificOutput;
    assert.equal(denied.permissionDecision, "deny", command);
    assert.match(denied.permissionDecisionReason, /Hard rule 19/);
  }

  assert.equal(run("npm test"), "");
  assert.equal(run("sleep 5", "ultracode:implement"), "");
}

test("bash-guard denies orchestrator wait/sleep but exempts subagents", () => {
  bashGuardTest("claude");
  bashGuardTest("codex");
  bashGuardTest("grok");
});

function artifactGuardTest(target) {
  const pluginRoot = pluginRootFor(target);
  const hookPath = path.join(pluginRoot, "hooks", "artifact-guard.js");
  const run = (filePath, agentType) =>
    runHook(hookPath, {
      tool_input: { file_path: filePath },
      ...(agentType ? { agent_type: agentType } : {}),
    });

  // Filenames here are the shapes the pipeline actually writes on disk. An
  // earlier `/^phase-\d+.*\.md$/` pattern matched only a bare "phase-N-...md",
  // which the plan agent never produces (it writes "ultracode-phase-N-...md"),
  // so the rule silently enforced nothing for phase files.
  for (const name of [
    "ultracode-spec-2026-01-01-topic.md",
    "ultracode-plan-2026-01-01-topic.md",
    "plan.md",
    "ultracode-phase-2-service-layer.md",
    "ultracode-phase-10-d6-wire-envs-migrate-tests.md",
  ]) {
    const denied = JSON.parse(run(`/repo/.claude/ultracode/session/x/${name}`)).hookSpecificOutput;
    assert.equal(denied.permissionDecision, "deny", name);
    assert.match(denied.permissionDecisionReason, /Rules D3\/D10\/D17/);
  }

  assert.equal(run("/repo/src/App.ts"), "");
  assert.equal(
    run("/repo/.claude/ultracode/session/x/ultracode-spec-2026-01-01-topic.md", "ultracode:generate-spec"),
    "",
  );

  // Ledger ownership (hooks/lib/ledger-policy.js) binds every writer, unlike the
  // spec/plan rule above which exempts the owning subagent.
  const ledgerDenied = (name, agentType) => {
    const raw = run(`/repo/.claude/ultracode/session/x/${name}`, agentType);
    assert.notEqual(raw, "", `${name} as ${agentType || "orchestrator"} should be denied`);
    return JSON.parse(raw).hookSpecificOutput.permissionDecisionReason;
  };
  const ledgerAllowed = (name, agentType) =>
    assert.equal(
      run(`/repo/.claude/ultracode/session/x/${name}`, agentType),
      "",
      `${name} as ${agentType || "orchestrator"} should be allowed`,
    );

  // Hook-owned: no model-issued write is ever legitimate. factcheck.json is the
  // sharp case — mcp/gate-server.js honors an "approved" decision only when this
  // file already carries a fact-check PASS, so a hand-written value forges the gate.
  for (const writer of [undefined, "ultracode:fact-check", "ultracode:implement"]) {
    assert.match(ledgerDenied("factcheck.json", writer), /never written by hand/);
    assert.match(ledgerDenied("progress.json", writer), /never written by hand/);
    assert.match(ledgerDenied("build-streak.json", writer), /never written by hand/);
  }

  // Agent-owned: only the role that did the work may write its ledger.
  assert.match(ledgerDenied("ultracode-review-ledger.md"), /not the orchestrator/);
  ledgerAllowed("ultracode-review-ledger.md", "ultracode:code-reviewer");
  ledgerAllowed("ultracode-review-ledger.md", "ultracode:implement");
  ledgerAllowed("ultracode-review-ledger-phase-12.md", "ultracode:write-test");
  assert.match(ledgerDenied("ultracode-review-ledger.md", "ultracode:explore"), /not ultracode:explore/);

  assert.match(ledgerDenied("ultracode-security-block.json"), /not the orchestrator/);
  ledgerAllowed("ultracode-security-block.json", "ultracode:code-reviewer");
  assert.match(
    ledgerDenied("ultracode-security-block.json", "ultracode:implement"),
    /not ultracode:implement/,
  );

  assert.match(ledgerDenied("ultracode-implement-progress.md"), /not the orchestrator/);
  ledgerAllowed("ultracode-implement-progress.md", "ultracode:implement");
  assert.match(
    ledgerDenied("ultracode-implement-progress.md", "ultracode:write-test"),
    /not ultracode:write-test/,
  );

  // A ledger is protected by name wherever it sits, and ordinary reports are not.
  assert.notEqual(run("/tmp/elsewhere/factcheck.json"), "");
  ledgerAllowed("ultracode-implement-phase-3.md", "ultracode:implement");
}

test("artifact-guard denies orchestrator edits to pipeline artifacts but exempts subagents", () => {
  artifactGuardTest("claude");
  artifactGuardTest("codex");
  artifactGuardTest("grok");
});

// A failing Bash call reaches a PostToolUse hook with its result text prefixed
// "Exit code N" — the harness's own report, and the only exit status available
// (a successful call's tool_response is { stdout, stderr, interrupted, ... } with
// no code at all). build-signal.js keys off that prefix.
const BUILD_FAIL_OUTPUT = [
  "Exit code 1",
  "[ERROR] /r/src/main/java/Foo.java:[11,2] cannot find symbol",
  "[ERROR] Failed to execute goal maven-compiler-plugin:3.14.1:compile (default-compile) on project core: Compilation failure",
].join("\n");

function buildStreakTest(target) {
  const { pluginRoot, runtimeDir, sessionId, repo, sessionDir, env } = scopeGuardFixture(
    target,
    "ultracode-streak",
  );
  fs.writeFileSync(
    path.join(repo, runtimeDir, "repo-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      commands: {
        build: "./mvnw -q -T1C compile",
        test: "./mvnw test -Ptest",
        testOne: "./mvnw test -Ptest -pl {MODULE} -am -Dtest={TEST}",
      },
    }),
    "utf-8",
  );
  const counter = path.join(pluginRoot, "hooks", "build-streak.js");
  const gate = path.join(pluginRoot, "hooks", "build-streak-gate.js");
  const statePath = path.join(sessionDir, "build-streak.json");
  const base = { cwd: repo, session_id: sessionId, sessionId };

  const post = (command, result, agentType = "ultracode:implement", extra = {}) =>
    runHook(
      counter,
      {
        ...base,
        ...(agentType ? { agent_type: agentType } : {}),
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { result, stdout: result, stderr: "", interrupted: false, ...extra },
      },
      env,
    );
  const pre = (command, agentType = "ultracode:implement") =>
    runHook(
      gate,
      {
        ...base,
        ...(agentType ? { agent_type: agentType } : {}),
        tool_name: "Bash",
        tool_input: { command },
      },
      env,
    );
  const streakOf = (agent) =>
    (JSON.parse(fs.readFileSync(statePath, "utf-8")).streaks[agent] || {}).consecutiveFailures || 0;

  // A non-build command is never counted, so no state file is even created.
  assert.equal(post("ls -la src", "Exit code 0\nsrc"), "");
  assert.equal(fs.existsSync(statePath), false, `${target}: ls must not create streak state`);

  // Failures accumulate; the warn threshold speaks up without blocking.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal(pre("./mvnw -q -T1C compile"), "", `${target}: attempt ${attempt} must be allowed`);
    const out = post("./mvnw -q -T1C compile", BUILD_FAIL_OUTPUT);
    assert.equal(streakOf("implement"), attempt, `${target}: streak after ${attempt}`);
    if (attempt < 3) {
      // Below the warn threshold the hook is silent unless this repo has a
      // recorded lesson for the diagnostic — this fixture has none.
      assert.equal(out, "", `${target}: no warning before the third failure`);
    } else {
      const context = JSON.parse(out).hookSpecificOutput.additionalContext;
      assert.match(context, /consecutive failing build\/test commands/);
      assert.match(context, /same diagnostic is repeating/);
      assert.match(context, /STUCK:/);
    }
  }

  // The fifth failure reaches the deny threshold; the sixth build call is refused.
  assert.equal(pre("./mvnw -q -T1C compile"), "");
  post("./mvnw -q -T1C compile", BUILD_FAIL_OUTPUT);
  assert.equal(streakOf("implement"), 5);
  const denied = JSON.parse(pre("./mvnw -q -T1C compile")).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /5 consecutive build\/test failures/);
  assert.match(denied.permissionDecisionReason, /STUCK: /);
  // A test command is the same loop and is refused too, but reading is not.
  assert.match(
    JSON.parse(pre("./mvnw test -Ptest -pl core -am -Dtest=FooTest")).hookSpecificOutput
      .permissionDecision,
    /deny/,
  );
  assert.equal(pre("cat src/main/java/Foo.java"), "");

  // A pass clears the streak, re-opens the gate, and records the recovery for
  // the failure-lesson stage to convert into a durable lesson.
  post("./mvnw -q -T1C compile", "BUILD SUCCESS");
  assert.equal(streakOf("implement"), 0);
  assert.equal(pre("./mvnw -q -T1C compile"), "");
  const recovered = JSON.parse(fs.readFileSync(statePath, "utf-8")).streaks.implement
    .recoveredSignatures;
  assert.equal(recovered.length, 1);
  assert.match(recovered[0].signature, /cannot find symbol/);
  assert.equal(recovered[0].streak, 5);
  assert.equal(recovered[0].lessonRecorded, false);

  // An interrupted call is not evidence either way: it must not count, and must
  // not clear an existing streak.
  post("./mvnw -q -T1C compile", BUILD_FAIL_OUTPUT);
  assert.equal(streakOf("implement"), 1);
  post("./mvnw -q -T1C compile", "", { interrupted: true });
  assert.equal(streakOf("implement"), 1, `${target}: interrupted must not change the streak`);

  // Streaks are per agent, and the orchestrator is exempt entirely — escalation
  // means handing back to the orchestrator, which it cannot do to itself.
  post("./mvnw -q -T1C compile", BUILD_FAIL_OUTPUT, "ultracode:write-test");
  assert.equal(streakOf("write-test"), 1);
  assert.equal(streakOf("implement"), 1);
  assert.equal(post("./mvnw -q -T1C compile", BUILD_FAIL_OUTPUT, null), "");
  const streaks = JSON.parse(fs.readFileSync(statePath, "utf-8")).streaks;
  assert.deepEqual(Object.keys(streaks).sort(), ["implement", "write-test"]);
  assert.equal(pre("./mvnw -q -T1C compile", null), "");
}

test("build-streak counts consecutive failures and the gate forces escalation at five", () => {
  buildStreakTest("claude");
  buildStreakTest("codex");
  buildStreakTest("grok");
});

// The failure→recovery→lesson loop. 42.9% of diagnostic occurrences in the
// recorded corpus were repeats of a signature already seen, and 12% of distinct
// signatures recurred across separate SESSIONS — recurrence a recorded lesson
// could have prevented. The recall side is done by the hook rather than asked of
// the agent, so it costs no tool call and cannot be skipped.
function failureLessonTest(target) {
  const { pluginRoot, runtimeDir, sessionId, repo, sessionDir, env } = scopeGuardFixture(
    target,
    "ultracode-lesson",
  );
  fs.writeFileSync(
    path.join(repo, runtimeDir, "repo-profile.json"),
    JSON.stringify({ commands: { build: "./mvnw -q compile" } }),
    "utf-8",
  );
  const { recordLesson } = require(path.join(pluginRoot, "mcp", "lib", "memory.js"));
  const dbPath = path.join(repo, runtimeDir, "memory", "knowledge.sqlite3");
  recordLesson(dbPath, {
    area: "core",
    lesson:
      "AutoConfigureTestDatabase lives at org.springframework.boot.test.autoconfigure.jdbc, not under boot.data.jpa.*",
    source: "ultracode:implement",
  });

  const failure = [
    "Exit code 1",
    "[ERROR] /r/src/Foo.java:[11,63] package AutoConfigureTestDatabase does not exist",
  ].join("\n");
  const post = (result) =>
    runHook(
      path.join(pluginRoot, "hooks", "build-streak.js"),
      {
        cwd: repo,
        session_id: sessionId,
        sessionId,
        agent_type: "ultracode:implement",
        tool_name: "Bash",
        tool_input: { command: "./mvnw -q compile" },
        tool_response: { result, stdout: result, stderr: "", interrupted: false },
      },
      env,
    );
  const contextOf = (out) => (out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : null);

  // One failure is not yet a pattern; the hook stays quiet.
  assert.equal(contextOf(post(failure)), null, `${target}: silent on the first failure`);
  // The second hands the recorded lesson over unprompted.
  const recalled = contextOf(post(failure));
  assert.match(recalled, /already recorded a lesson/, `${target}: lesson recalled at the second failure`);
  assert.match(recalled, /boot\.test\.autoconfigure\.jdbc/);
  assert.match(recalled, /\[core\]/);

  // A verified pass after a real streak asks for the fix to be recorded, and
  // leaves the pending flag behind so the omission is visible.
  post(failure);
  const recovery = contextOf(post("BUILD SUCCESS"));
  assert.match(recovery, /that passed after 3 consecutive failures/);
  assert.match(recovery, /ultracode_memory/);
  const recovered = JSON.parse(fs.readFileSync(path.join(sessionDir, "build-streak.json"), "utf-8"))
    .streaks.implement.recoveredSignatures;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].lessonRecorded, false);
  assert.match(recovered[0].signature, /AutoConfigureTestDatabase does not exist/);

  // A pass that never had a streak is not a "recovery" and must not manufacture
  // a lesson to record.
  post("BUILD SUCCESS");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(sessionDir, "build-streak.json"), "utf-8")).streaks.implement
      .recoveredSignatures.length,
    1,
    `${target}: a plain success records no lesson`,
  );
}

test("failure lessons are recalled on repeat and requested on verified recovery", () => {
  failureLessonTest("claude");
  failureLessonTest("codex");
  failureLessonTest("grok");
});

// ultracode_report exists because agents naming their own reports produced 27
// distinct filename shapes across 1,864 artifacts, and the next stage then had to
// guess (32 hard read failures on pipeline artifacts in the Grok corpus alone).
// The orchestrator declares the path; the tool writes it.
function reportToolTest(target) {
  const { pluginRoot, runtimeDir, sessionId, repo, sessionDir, env } = scopeGuardFixture(
    target,
    "ultracode-report",
  );
  fs.writeFileSync(
    path.join(repo, runtimeDir, "repo-profile.json"),
    JSON.stringify({ commands: { build: "./mvnw compile" } }),
    "utf-8",
  );
  const { writeReport, pendingLessons, markLessonsRecorded } = require(
    path.join(pluginRoot, "mcp", "lib", "report.js"),
  );
  const reportPath = path.join(sessionDir, "ultracode-implement-phase-3.md");
  const spawnHook = (prompt) =>
    runHook(
      path.join(pluginRoot, "hooks", "spawn-scope.js"),
      { cwd: repo, session_id: sessionId, sessionId, tool_input: { subagent_type: "ultracode:implement", prompt } },
      env,
    );

  // Without a declared path the tool refuses rather than inventing a name.
  const undeclared = writeReport(sessionDir, "ultracode:implement", "# Report");
  assert.equal(undeclared.ok, false);
  assert.match(undeclared.message, /no report path was declared/);

  spawnHook(
    `Repo root: ${repo}\nSession dir: ${sessionDir}\nNo plan: demo.\nReport file: ${reportPath}`,
  );
  const recorded = JSON.parse(
    fs.readFileSync(path.join(sessionDir, "spawn-scope.json"), "utf-8"),
  ).agents.implement;
  assert.equal(recorded.reportFile, reportPath);

  const written = writeReport(sessionDir, "ultracode:implement", "# Change Report\nDid the thing.");
  assert.equal(written.ok, true);
  assert.equal(written.path, reportPath);
  assert.match(fs.readFileSync(reportPath, "utf-8"), /Did the thing/);
  assert.equal(writeReport(sessionDir, "ultracode:implement", "   ").ok, false, `${target}: empty refused`);

  // The declared path is orchestrator-supplied but the tool writes with the MCP
  // server's own privileges, so it is confined to the session dir regardless.
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, "spawn-scope.json"), "utf-8"));
  state.agents.implement.reportFile = path.join(os.tmpdir(), "ultracode-escape.md");
  fs.writeFileSync(path.join(sessionDir, "spawn-scope.json"), JSON.stringify(state), "utf-8");
  const escaped = writeReport(sessionDir, "ultracode:implement", "x");
  assert.equal(escaped.ok, false);
  assert.match(escaped.message, /outside the session dir/);
  state.agents.implement.reportFile = reportPath;
  fs.writeFileSync(path.join(sessionDir, "spawn-scope.json"), JSON.stringify(state), "utf-8");

  // A verified failure→recovery that was never turned into a lesson blocks the
  // report — this is the moment the fix is still in the agent's context.
  const failure = "Exit code 1\n[ERROR] /r/Foo.java:[11,2] cannot find symbol";
  const build = (result) =>
    runHook(
      path.join(pluginRoot, "hooks", "build-streak.js"),
      {
        cwd: repo,
        session_id: sessionId,
        sessionId,
        agent_type: "ultracode:implement",
        tool_name: "Bash",
        tool_input: { command: "./mvnw compile" },
        tool_response: { result, stdout: result, stderr: "", interrupted: false },
      },
      env,
    );
  for (let i = 0; i < 3; i += 1) build(failure);
  build("BUILD SUCCESS");
  assert.equal(pendingLessons(sessionDir, "implement").length, 1);
  const blocked = writeReport(sessionDir, "ultracode:implement", "# Report");
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /ultracode_memory/);
  assert.match(blocked.message, /cannot find symbol/);

  // Recording the lesson clears it. The flag is cleared by a lesson landing in
  // the store, never by an agent asserting it recorded one.
  assert.equal(markLessonsRecorded(sessionDir, "implement"), 1);
  assert.equal(writeReport(sessionDir, "ultracode:implement", "# Report\nfinal").ok, true);

  // An explicitly stated reason overrides, and the override is surfaced rather
  // than silently honored.
  for (let i = 0; i < 3; i += 1) build(failure);
  build("BUILD SUCCESS");
  const forced = writeReport(sessionDir, "ultracode:implement", "# Report", {
    allowUnrecordedLesson: true,
  });
  assert.equal(forced.ok, true);
  assert.match(forced.message, /unrecorded lesson, as stated/);
}

test("ultracode_report writes the declared path and gates on unrecorded lessons", () => {
  reportToolTest("claude");
  reportToolTest("codex");
  reportToolTest("grok");
});

// A Write/Edit inside a subagent's turn carries no spawn prompt, so the phase
// file's declared file set has to be captured at spawn time (spawn-scope.js) and
// read back by the guards. Measured justification: of implement runs whose phase
// file survived on disk, 100% of written paths were derivable from it, while 71%
// were NOT derivable from the spawn prompt alone.
function phaseScopeTest(target) {
  const { pluginRoot, runtimeDir, sessionId, repo, sessionDir, env } = scopeGuardFixture(
    target,
    "ultracode-phasescope",
  );
  fs.writeFileSync(
    path.join(repo, runtimeDir, "repo-profile.json"),
    JSON.stringify({ commands: { build: "./mvnw compile" } }),
    "utf-8",
  );
  const phaseFile = path.join(sessionDir, "ultracode-phase-3-order-service.md");
  fs.writeFileSync(
    phaseFile,
    [
      "# Phase 3 — order service",
      "Modify `core/src/main/java/com/example/order/OrderService.java` to add cancellation.",
      "Create `core/src/main/java/com/example/order/CancelOrderCommand.java`.",
      "Record state in ultracode-implement-progress.md and read INVENTORY.md if needed.",
    ].join("\n\n"),
    "utf-8",
  );
  const base = { cwd: repo, session_id: sessionId, sessionId };
  const hook = (name) => path.join(pluginRoot, "hooks", name);
  const reasonOf = (out) => (out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : null);

  // An implement spawn must declare a plan one way or the other.
  const bare = reasonOf(
    runHook(hook("pipeline-gate.js"), {
      ...base,
      tool_input: {
        subagent_type: "ultracode:implement",
        prompt: `Repo root: ${repo}\nSession dir: ${sessionDir}\nDo the thing.`,
      },
    }, env),
  );
  assert.match(bare, /without a plan/, `${target}: bare implement spawn is refused`);
  assert.match(bare, /No plan:/);
  assert.equal(
    reasonOf(
      runHook(hook("pipeline-gate.js"), {
        ...base,
        tool_input: {
          subagent_type: "ultracode:implement",
          prompt: `Repo root: ${repo}\nSession dir: ${sessionDir}\nNo plan: one-line typo fix.`,
        },
      }, env),
    ),
    null,
    `${target}: an explicit No plan: is accepted`,
  );

  // Recording the scope, then holding the agent to it.
  runHook(hook("spawn-scope.js"), {
    ...base,
    tool_input: {
      subagent_type: "ultracode:implement",
      prompt: `Repo root: ${repo}\nSession dir: ${sessionDir}\nPhase file: ${phaseFile}`,
    },
  }, env);
  const recorded = JSON.parse(
    fs.readFileSync(path.join(sessionDir, "spawn-scope.json"), "utf-8"),
  ).agents.implement;
  assert.equal(recorded.phaseFileFound, true);
  assert.deepEqual(recorded.files.sort(), [
    "core/src/main/java/com/example/order/CancelOrderCommand.java",
    "core/src/main/java/com/example/order/OrderService.java",
  ]);
  // ultracode's own artifacts are governed by ledger-policy, not by this scope.
  assert.ok(!JSON.stringify(recorded).includes("implement-progress"));
  assert.ok(!JSON.stringify(recorded).includes("INVENTORY"));

  const write = (filePath) =>
    reasonOf(
      runHook(hook("scope-guard.js"), {
        ...base,
        agent_type: "ultracode:implement",
        tool_input: { file_path: filePath },
      }, env),
    );
  assert.equal(write(path.join(repo, "core/src/main/java/com/example/order/OrderService.java")), null);
  // A sibling in a declared directory is allowed: implementing a named service
  // legitimately adds types no plan enumerates line by line.
  assert.equal(write(path.join(repo, "core/src/main/java/com/example/order/OrderStatus.java")), null);
  assert.match(
    write(path.join(repo, "billing/src/main/java/com/example/billing/Invoice.java")),
    /outside the file set this phase declares/,
    `${target}: an unrelated module is refused`,
  );
  // Its own session report stays writable.
  assert.equal(write(path.join(sessionDir, "ultracode-implement-phase-3.md")), null);

  // Shell writes are confined identically, so Bash is not an escape hatch.
  const bash = (command) =>
    reasonOf(
      runHook(hook("bash-scope-guard.js"), {
        ...base,
        agent_type: "ultracode:implement",
        tool_input: { command },
      }, env),
    );
  assert.equal(bash(`echo x > ${repo}/core/src/main/java/com/example/order/Foo.java`), null);
  assert.match(bash(`echo x > ${repo}/billing/src/Evil.java`), /outside the file set/);

  // No phase file = nothing to scope to, so behavior stays as it was. A guard
  // that denied here would break every legitimate inline task.
  fs.rmSync(path.join(sessionDir, "spawn-scope.json"));
  runHook(hook("spawn-scope.js"), {
    ...base,
    tool_input: {
      subagent_type: "ultracode:implement",
      prompt: `Repo root: ${repo}\nSession dir: ${sessionDir}\nNo plan: tiny fix.`,
    },
  }, env);
  assert.equal(write(path.join(repo, "billing/src/main/java/com/example/billing/Invoice.java")), null);

  // And Constraint 6 still outranks all of it.
  assert.match(
    write(path.join(repo, "core/src/test/java/com/example/order/OrderServiceTest.java")),
    /test file/,
    `${target}: implement still cannot write tests`,
  );
}

test("phase-scoped allowlist confines implement to the files its phase declares", () => {
  phaseScopeTest("claude");
  phaseScopeTest("codex");
  phaseScopeTest("grok");
});

function scopeGuardFixture(target, prefix) {
  const pluginRoot = pluginRootFor(target);
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const skillsDir = HARNESS_LAYOUT.layouts[target].skills_dir;
  const sessionId = "testsess";
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${target}-`));
  const sessionDir = path.join(repo, runtimeDir, "session", `ultracode-session-${sessionId}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const env = { PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_ROOT: pluginRoot, GROK_PLUGIN_ROOT: pluginRoot };
  return { pluginRoot, runtimeDir, skillsDir, sessionId, repo, sessionDir, env };
}

function scopeGuardTest(target) {
  const { pluginRoot, skillsDir, runtimeDir, sessionId, repo, sessionDir, env } = scopeGuardFixture(
    target,
    "ultracode-scope",
  );
  const hookPath = path.join(pluginRoot, "hooks", "scope-guard.js");

  const run = (filePath, agentType) =>
    runHook(
      hookPath,
      {
        cwd: repo,
        session_id: sessionId,
        tool_input: { file_path: filePath },
        ...(agentType ? { agent_type: agentType } : {}),
      },
      env,
    );
  const allow = (filePath, agentType) => assert.equal(run(filePath, agentType), "", `${agentType}: ${filePath}`);
  const deny = (filePath, agentType, pattern) => {
    const result = JSON.parse(run(filePath, agentType)).hookSpecificOutput;
    assert.equal(result.permissionDecision, "deny", `${agentType}: ${filePath}`);
    assert.match(result.permissionDecisionReason, pattern);
  };

  // The orchestrator's own Write/Edit calls (no agent_type) are never checked by this hook.
  allow("/etc/passwd");
  allow(path.join(repo, "..", "outside.txt"));

  // Universal: every subagent is confined to the repo root.
  deny("/etc/passwd", "ultracode:prompt-generation", /outside the repo root/);
  deny(path.join(repo, "..", "outside.txt"), "ultracode:write-test", /outside the repo root/);

  // Session-only agents never touch project source — only their own session dir.
  for (const agent of [
    "code-reviewer",
    "plan",
    "execution-path-analyzer",
    "explore",
    "fact-check",
    "generate-spec",
  ]) {
    allow(path.join(sessionDir, "report.md"), `ultracode:${agent}`);
    deny(path.join(repo, "src", "App.ts"), `ultracode:${agent}`, /never modifies project source/);
  }

  // initializer: session dir, skills dir, runtime dir — nothing else.
  allow(path.join(repo, skillsDir, "convention", "SKILL.md"), "ultracode:initializer");
  allow(path.join(repo, runtimeDir, "INVENTORY.md"), "ultracode:initializer");
  deny(path.join(repo, "src", "App.ts"), "ultracode:initializer", /allowed scope/);

  // module-documentation: session dir plus module-hub/references only — not the rest of skills_dir.
  allow(path.join(repo, skillsDir, "module-hub", "references", "auth.md"), "ultracode:module-documentation");
  deny(path.join(repo, skillsDir, "convention", "SKILL.md"), "ultracode:module-documentation", /allowed scope/);
  deny(path.join(repo, "src", "App.ts"), "ultracode:module-documentation", /allowed scope/);

  // implement: anywhere in the repo root, except a path that looks like a test (Constraint 6).
  allow(path.join(repo, "src", "App.ts"), "ultracode:implement");
  deny(path.join(repo, "src", "App.test.ts"), "ultracode:implement", /Constraint 6/);

  // write-test and prompt-generation keep full repo-root scope, test-shaped paths included.
  allow(path.join(repo, "src", "App.test.ts"), "ultracode:write-test");
  allow(path.join(repo, "src", "prompts", "system.md"), "ultracode:prompt-generation");
}

test("scope-guard confines each subagent to its documented write scope", () => {
  scopeGuardTest("claude");
  scopeGuardTest("codex");
  scopeGuardTest("grok");
});

function bashScopeGuardTest(target) {
  const { pluginRoot, sessionId, repo, sessionDir, env } = scopeGuardFixture(target, "ultracode-bashscope");
  const hookPath = path.join(pluginRoot, "hooks", "bash-scope-guard.js");

  const run = (command, agentType) =>
    runHook(
      hookPath,
      {
        cwd: repo,
        session_id: sessionId,
        tool_input: { command },
        ...(agentType ? { agent_type: agentType } : {}),
      },
      env,
    );

  // Ordinary read commands never trip the guard.
  assert.equal(run("git status", "ultracode:code-reviewer"), "");
  assert.equal(run("npm test", "ultracode:implement"), "");

  // A session-only agent writing its own report inside its session dir is fine...
  assert.equal(
    run(`cat <<'EOF' > ${path.join(sessionDir, "ledger.md")}\nhi\nEOF`, "ultracode:code-reviewer"),
    "",
  );
  // ...but writing project source through Bash instead of Write/Edit is still denied.
  let denied = JSON.parse(
    run(`echo bad > ${path.join(repo, "src", "App.ts")}`, "ultracode:code-reviewer"),
  ).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /never modifies project source/);

  // implement cannot write a test file through a Bash heredoc either.
  denied = JSON.parse(
    run(`cat <<'EOF' > ${path.join(repo, "src", "App.test.ts")}\nhi\nEOF`, "ultracode:implement"),
  ).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /Constraint 6/);

  // Any subagent deleting outside the repo root is denied.
  denied = JSON.parse(
    run(`rm -rf ${path.join(repo, "..", "sibling")}`, "ultracode:write-test"),
  ).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /outside the repo root/);

  // The orchestrator's own Bash calls (no agent_type) are never checked by this hook.
  assert.equal(run("rm -rf /"), "");
}

test("bash-scope-guard confines each subagent's shell writes to its documented scope", () => {
  bashScopeGuardTest("claude");
  bashScopeGuardTest("codex");
  bashScopeGuardTest("grok");
});

function pipelineGateTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-gate-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const pluginRoot = pluginRootFor(target);
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const hookPath = path.join(pluginRoot, "hooks", "pipeline-gate.js");
  const run = (agent, extraPromptLines = "") =>
    runHook(
      hookPath,
      {
        cwd: repo,
        session_id: "testsess",
        tool_input: {
          subagent_type: `ultracode:${agent}`,
          prompt: `Repo root: ${repo}.\nSession dir: ${sessionDir}.${extraPromptLines}`,
        },
      },
      { PLUGIN_ROOT: pluginRoot },
    );

  const planDenied = JSON.parse(run("plan")).hookSpecificOutput;
  assert.equal(planDenied.permissionDecision, "deny");
  assert.match(planDenied.permissionDecisionReason, /spec has not been recorded as approved/);

  fs.writeFileSync(
    path.join(sessionDir, "gates.json"),
    JSON.stringify({ spec: { decision: "approved" } }),
    "utf-8",
  );
  assert.equal(run("plan"), "");

  // An inline no-plan implement spawn is still exempt from the PLAN gate, but it
  // must now say it is one. Omitting Phase file: used to be a silent exemption,
  // and 96% of recorded implement spawns took it — so a bare spawn is refused and
  // an explicit "No plan:" is what carries the exemption.
  const noDeclaration = JSON.parse(run("implement")).hookSpecificOutput;
  assert.equal(noDeclaration.permissionDecision, "deny");
  assert.match(noDeclaration.permissionDecisionReason, /without a plan/);
  assert.equal(run("implement", "\nNo plan: one-line typo fix."), "");

  const phaseLine = `\nPhase file: ${path.join(sessionDir, "phase-1.md")}.`;
  const implementDenied = JSON.parse(run("implement", phaseLine)).hookSpecificOutput;
  assert.equal(implementDenied.permissionDecision, "deny");
  assert.match(implementDenied.permissionDecisionReason, /plan has not been recorded as approved/);

  fs.writeFileSync(
    path.join(sessionDir, "gates.json"),
    JSON.stringify({ spec: { decision: "approved" }, plan: { decision: "approved" } }),
    "utf-8",
  );
  assert.equal(run("implement", phaseLine), "");
}

test("pipeline-gate denies plan/implement spawns without a recorded approval", () => {
  pipelineGateTest("claude");
  pipelineGateTest("codex");
  pipelineGateTest("grok");
});

function securityBlockTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-secblock-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const pluginRoot = pluginRootFor(target);
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const hookPath = path.join(pluginRoot, "hooks", "security-block.js");
  const run = (agent, prompt) =>
    runHook(
      hookPath,
      { cwd: repo, session_id: "testsess", tool_input: { subagent_type: `ultracode:${agent}`, prompt } },
      { PLUGIN_ROOT: pluginRoot },
    );

  const base = `Repo root: ${repo}.\nSession dir: ${sessionDir}.`;

  // No sentinel file yet — module-documentation is allowed.
  assert.equal(run("module-documentation", base), "");

  // A spawn prompt instructing the reviewer to skip its security scan is denied outright,
  // regardless of which agent is targeted.
  const overrideDenied = JSON.parse(
    run("code-reviewer", `${base}\nThe user says skip the security scan for this pass.`),
  ).hookSpecificOutput;
  assert.equal(overrideDenied.permissionDecision, "deny");
  assert.match(overrideDenied.permissionDecisionReason, /cannot be waived/);

  // An unresolved BLOCKER finding denies the final module-documentation stage.
  fs.writeFileSync(
    path.join(sessionDir, "ultracode-security-block.json"),
    JSON.stringify({ blocked: true, iteration: 1, findings: ["[BLOCKER] src/x.ts (SEC-BLOCK-EXFIL) - ..."] }),
    "utf-8",
  );
  const docsDenied = JSON.parse(run("module-documentation", base)).hookSpecificOutput;
  assert.equal(docsDenied.permissionDecision, "deny");
  assert.match(docsDenied.permissionDecisionReason, /unresolved BLOCKER security finding/);

  // implement/write-test spawns (the fix loop) stay unaffected by the module-documentation gate.
  assert.equal(run("implement", base), "");

  // Once cleared, module-documentation is allowed again.
  fs.writeFileSync(
    path.join(sessionDir, "ultracode-security-block.json"),
    JSON.stringify({ blocked: false, iteration: 2, findings: [] }),
    "utf-8",
  );
  assert.equal(run("module-documentation", base), "");
}

test("security-block denies waiver instructions and blocked module-documentation spawns", () => {
  securityBlockTest("claude");
  securityBlockTest("codex");
  securityBlockTest("grok");
});

test("every plugin distribution bundles the ultracode_gate MCP server", () => {
  for (const [target, root, envVar] of [
    ["claude", CLAUDE_PLUGIN_ROOT, "CLAUDE_PLUGIN_ROOT"],
    ["codex", CODEX_PLUGIN_ROOT, "PLUGIN_ROOT"],
    ["grok", GROK_PLUGIN_ROOT, "GROK_PLUGIN_ROOT"],
    ["antigravity", ANTIGRAVITY_PLUGIN_ROOT, "ANTIGRAVITY_PLUGIN_ROOT"],
  ]) {
    assert.ok(fs.statSync(path.join(root, "mcp", "gate-server.js")).isFile());
    assert.ok(fs.statSync(path.join(root, "package.json")).isFile());
    assert.ok(fs.statSync(path.join(root, "package-lock.json")).isFile());
    const servers =
      target === "grok"
        ? JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf-8")).mcpServers
        : target === "antigravity"
          ? JSON.parse(fs.readFileSync(path.join(root, "mcp_config.json"), "utf-8")).mcpServers
          : JSON.parse(
              fs.readFileSync(
                path.join(
                  root,
                  target === "claude" ? ".claude-plugin" : ".codex-plugin",
                  "plugin.json",
                ),
                "utf-8",
              ),
            ).mcpServers;
    assert.deepEqual(servers, {
      "ultracode-gate": {
        command: "node",
        args: [`\${${envVar}}/mcp/gate-server.js`],
      },
    });
  }
});

function factcheckRecordTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-fcrecord-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const pluginRoot = pluginRootFor(target);
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const prompt = `Repo root: ${repo}.\nSession dir: ${sessionDir}.`;
  const record = (verdict, findings = []) =>
    runHook(
      path.join(pluginRoot, "hooks", "factcheck-record.js"),
      {
        cwd: repo,
        session_id: "testsess",
        tool_input: { subagent_type: "ultracode:fact-check", prompt },
        tool_response: JSON.stringify({ verdict, target: "spec", findings }),
      },
      { PLUGIN_ROOT: pluginRoot },
    );

  record("FAIL", [{ severity: "HIGH", location: "x", claim: "y", issue: "z" }]);
  record("PASS");

  const factcheck = JSON.parse(fs.readFileSync(path.join(sessionDir, "factcheck.json"), "utf-8"));
  assert.equal(factcheck.spec.verdict, "PASS");
  assert.equal(factcheck.spec.rounds, 2);
  assert.deepEqual(factcheck.spec.findings, []);

  // A non-fact-check spawn must not be recorded.
  runHook(
    path.join(pluginRoot, "hooks", "factcheck-record.js"),
    {
      cwd: repo,
      session_id: "testsess",
      tool_input: { subagent_type: "ultracode:implement", prompt },
      tool_response: JSON.stringify({ verdict: "PASS", target: "plan" }),
    },
    { PLUGIN_ROOT: pluginRoot },
  );
  const unchanged = JSON.parse(fs.readFileSync(path.join(sessionDir, "factcheck.json"), "utf-8"));
  assert.ok(!unchanged.plan);
}

test("factcheck-record captures fact-check verdicts and increments rounds", () => {
  factcheckRecordTest("claude");
  factcheckRecordTest("codex");
  factcheckRecordTest("grok");
});

function progressTrackerTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-progress-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const pluginRoot = pluginRootFor(target);
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const prompt = `Repo root: ${repo}.\nSession dir: ${sessionDir}.\nPhase file: ${path.join(sessionDir, "phase-2.md")}.`;

  runHook(
    path.join(pluginRoot, "hooks", "spawn-log.js"),
    {
      cwd: repo,
      session_id: "testsess",
      tool_input: { subagent_type: "ultracode:implement", prompt },
      tool_response: "STUCK: cannot resolve merge conflict",
    },
    { PLUGIN_ROOT: pluginRoot },
  );

  const progress = JSON.parse(fs.readFileSync(path.join(sessionDir, "progress.json"), "utf-8"));
  assert.equal(progress.schemaVersion, 1);
  assert.equal(progress.records.length, 1);
  assert.equal(progress.records[0].agent, "implement");
  assert.equal(progress.records[0].phase, "phase-2");
  assert.equal(progress.records[0].status, "stuck");

  const resumeOutput = runHook(path.join(pluginRoot, "hooks", "session-resume.js"), {
    cwd: repo,
    session_id: "testsess",
  });
  assert.match(resumeOutput, /implement phase-2 \[stuck\]/);
}

test("spawn-log records structured progress.json read back by session-resume", () => {
  progressTrackerTest("claude");
  progressTrackerTest("codex");
  progressTrackerTest("grok");
});

function tempMemoryDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-memory-"));
  return path.join(dir, "knowledge.sqlite3");
}

test("mcp/lib/memory dedupes by (area, lesson), keeps the newest source, and never caps entries", () => {
  const { recordLesson } = require(path.join(ROOT, "mcp", "lib", "memory.js"));
  const dbPath = tempMemoryDbPath();

  assert.equal(recordLesson(dbPath, { area: "auth", lesson: "L1", source: "a" }), 1);
  assert.equal(recordLesson(dbPath, { area: "build", lesson: "L2", source: "a" }), 2);
  // Re-recording the same (area, lesson) updates the row in place rather than growing the store.
  assert.equal(recordLesson(dbPath, { area: "auth", lesson: "L1", source: "b" }), 2);

  const seenAny = require(path.join(ROOT, "mcp", "lib", "memory.js")).recallLessons(dbPath, { limit: 50 });
  const auth = seenAny.find((l) => l.area === "auth" && l.lesson === "L1");
  assert.equal(auth.source, "b");

  // No cap: recording well past the old 80-entry limit keeps every distinct lesson.
  let total = 2;
  for (let i = 0; i < 90; i++) {
    total = recordLesson(dbPath, { area: "a", lesson: `lesson-${i}`, source: "s" });
  }
  assert.equal(total, 92);
});

test("mcp/lib/memory recall scopes by area (with sub-scopes) and ranks by text relevance", () => {
  const { recordLesson, recallLessons } = require(path.join(ROOT, "mcp", "lib", "memory.js"));
  const dbPath = tempMemoryDbPath();

  recordLesson(dbPath, {
    area: "auth",
    lesson: "Token expiry causes flaky login integration tests",
    source: "implement",
  });
  recordLesson(dbPath, {
    area: "billing-service::InvoiceCalculator",
    lesson: "Null total when currency conversion rate missing",
    source: "implement",
  });
  recordLesson(dbPath, {
    area: "build",
    lesson: "Maven module order matters for parallel builds",
    source: "implement",
  });

  const byQuery = recallLessons(dbPath, { query: "flaky login test" });
  assert.equal(byQuery.length, 1);
  assert.equal(byQuery[0].area, "auth");

  // Scoping by the parent area matches its "area::..." sub-scope too.
  const byArea = recallLessons(dbPath, { area: "billing-service" });
  assert.equal(byArea.length, 1);
  assert.equal(byArea[0].area, "billing-service::InvoiceCalculator");

  const noMatch = recallLessons(dbPath, { query: "zzz nonexistent qqq" });
  assert.deepEqual(noMatch, []);

  const noDb = recallLessons(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-memory-")), "missing.sqlite3"));
  assert.deepEqual(noDb, []);
});

test("mcp/lib/memory deleteLesson removes only the exact (area, lesson) match", () => {
  const { recordLesson, recallLessons, deleteLesson } = require(path.join(ROOT, "mcp", "lib", "memory.js"));
  const dbPath = tempMemoryDbPath();

  recordLesson(dbPath, { area: "auth", lesson: "Stale lesson", source: "a" });
  recordLesson(dbPath, { area: "auth", lesson: "Keep this one", source: "a" });

  // Missing store: no-op, not an error.
  const missingDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-memory-")), "missing.sqlite3");
  assert.deepEqual(deleteLesson(missingDb, { area: "auth", lesson: "Stale lesson" }), { deleted: false, total: 0 });

  // Non-matching lesson text: no-op, existing entries untouched.
  assert.deepEqual(deleteLesson(dbPath, { area: "auth", lesson: "Never recorded" }), { deleted: false, total: 2 });

  assert.deepEqual(deleteLesson(dbPath, { area: "auth", lesson: "Stale lesson" }), { deleted: true, total: 1 });

  const remaining = recallLessons(dbPath, { limit: 50 });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].lesson, "Keep this one");
});

test("mcp/lib/gate refuses approval without a fact-check PASS and allows it once recorded", () => {
  const { recordGateDecision } = require(path.join(ROOT, "mcp", "lib", "gate.js"));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-gate-lib-"));

  const denied = recordGateDecision(tempDir, "spec", "approved");
  assert.equal(denied.ok, false);
  assert.match(denied.message, /has not returned a PASS/);

  const rejected = recordGateDecision(tempDir, "plan", "rejected", "needs rework");
  assert.equal(rejected.ok, true);

  fs.writeFileSync(path.join(tempDir, "factcheck.json"), JSON.stringify({ spec: { verdict: "PASS" } }));
  const approved = recordGateDecision(tempDir, "spec", "approved");
  assert.equal(approved.ok, true);

  const gates = JSON.parse(fs.readFileSync(path.join(tempDir, "gates.json"), "utf-8"));
  assert.equal(gates.spec.decision, "approved");
  assert.equal(gates.plan.decision, "rejected");
  assert.equal(gates.plan.notes, "needs rework");
});

test("every plugin distribution includes target hooks", () => {
  for (const [target, root] of [
    ["claude", CLAUDE_PLUGIN_ROOT],
    ["codex", CODEX_PLUGIN_ROOT],
    ["grok", GROK_PLUGIN_ROOT],
    ["antigravity", ANTIGRAVITY_PLUGIN_ROOT],
  ]) {
    const hookDir = path.join(root, "hooks");
    const files = fs
      .readdirSync(hookDir)
      .filter((name) => fs.statSync(path.join(hookDir, name)).isFile())
      .sort();
    assert.deepEqual(files, [
      "artifact-guard.js",
      "bash-guard.js",
      "bash-scope-guard.js",
      "build-streak-gate.js",
      "build-streak.js",
      "factcheck-record.js",
      "hooks.json",
      "model-router.js",
      "model-routing.json",
      "pipeline-gate.js",
      "review-cap.js",
      "scope-guard.js",
      "security-block.js",
      "session-guard.js",
      "session-resume.js",
      "skill-init-guard.js",
      "spawn-log.js",
      "spawn-scope.js",
    ]);
    for (const lib of [
      "common.js",
      "session.js",
      "scope-policy.js",
      "ledger-policy.js",
      "build-signal.js",
      "context-brief.js",
      "shell-paths.js",
    ]) {
      assert.ok(fs.statSync(path.join(hookDir, "lib", lib)).isFile(), `${target}: lib/${lib}`);
    }
    const config = JSON.parse(
      fs.readFileSync(path.join(hookDir, "hooks.json"), "utf-8"),
    );
    if (target === "antigravity") {
      assert.ok(config.ultracode.PreToolUse);
      assert.ok(config.ultracode.PostToolUse);
      assert.ok(config.ultracode.PreInvocation);
      const compactCommand = config.ultracode.PreInvocation[0].command;
      assert.match(compactCommand, /session-resume\.js/);
    } else {
      assert.ok(config.hooks.PreToolUse);
      assert.ok(config.hooks.PostToolUse);
      assert.equal(config.hooks.SessionStart.length, 1);
      assert.equal(config.hooks.SessionStart[0].matcher, "compact");
      const compactCommand = config.hooks.SessionStart[0].hooks[0].command;
      assert.match(compactCommand, /session-resume\.js/);
    }
    const routing = JSON.parse(
      fs.readFileSync(path.join(hookDir, "model-routing.json"), "utf-8"),
    );
    assert.equal(routing.target, target);
    assert.equal(
      routing.runtime_dir,
      HARNESS_LAYOUT.layouts[target].runtime_dir,
    );
    assert.deepEqual(
      new Set(Object.keys(routing.tiers)),
      new Set(Object.keys(MODEL_MAPPING.tiers)),
    );
  }
});

test("codex output uses codex runtime layout", () => {
  const collected = [];
  const stack = [CODEX_PLUGIN_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const rel = path.relative(CODEX_PLUGIN_ROOT, full);
        if (
          (entry.name.endsWith(".toml") && rel.startsWith("agents" + path.sep)) ||
          (entry.name === "SKILL.md" && rel.includes(`${path.sep}skills${path.sep}`)) ||
          (entry.name.endsWith(".md") && rel.startsWith("refs" + path.sep))
        ) {
          collected.push(full);
        }
      }
    }
  }
  assert.ok(collected.length > 0);
  for (const filePath of collected) {
    const content = fs.readFileSync(filePath, "utf-8");
    assert.ok(!content.includes(".claude/"), filePath);
    assert.ok(!content.includes("CLAUDE_CODE_SESSION_ID"), filePath);
    assert.ok(!content.includes("GROK_SESSION_ID"), filePath);
  }
  const orchestrate = fs.readFileSync(
    path.join(CODEX_PLUGIN_ROOT, "skills", "orchestrate", "SKILL.md"),
    "utf-8",
  );
  assert.match(orchestrate, /\.codex\/ultracode\/repo-profile\.json/);
  const inventoryReference = fs.readFileSync(
    path.join(CODEX_PLUGIN_ROOT, "refs", "inventory-and-profile.md"),
    "utf-8",
  );
  assert.match(inventoryReference, /\.agents\/skills/);
  const initKitCommand = fs.readFileSync(
    path.join(CODEX_PLUGIN_ROOT, "skills", "init-kit", "SKILL.md"),
    "utf-8",
  );
  assert.match(initKitCommand, /\$\{CODEX_THREAD_ID:-no-session-id\}/);
  assert.match(initKitCommand, /# \$init-kit/);
  assert.ok(!initKitCommand.includes("$ARGUMENTS"));
  assert.ok(!initKitCommand.includes("subagent_type"));
});

test("codex plugin metadata matches plugin identity", () => {
  const sourceMetadata = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "definitions", "plugin-metadata.json"),
      "utf-8",
    ),
  );
  const codexManifest = JSON.parse(
    fs.readFileSync(
      path.join(CODEX_PLUGIN_ROOT, ".codex-plugin", "plugin.json"),
      "utf-8",
    ),
  );
  const claudeManifest = JSON.parse(
    fs.readFileSync(
      path.join(CLAUDE_PLUGIN_ROOT, ".claude-plugin", "plugin.json"),
      "utf-8",
    ),
  );
  assert.equal(codexManifest.name, sourceMetadata.name);
  assert.equal(path.basename(CODEX_PLUGIN_ROOT), sourceMetadata.name);
  assert.equal(path.basename(CLAUDE_PLUGIN_ROOT), sourceMetadata.name);
  for (const field of ["name", "version", "description", "license"]) {
    assert.equal(codexManifest[field], claudeManifest[field]);
    assert.equal(codexManifest[field], sourceMetadata[field]);
  }
  assert.deepEqual(codexManifest.keywords, claudeManifest.keywords);
  assert.deepEqual(codexManifest.keywords, sourceMetadata.keywords);
  assert.deepEqual(codexManifest.author, claudeManifest.author);
  assert.deepEqual(codexManifest.author, sourceMetadata.author);
  assert.equal(codexManifest.skills, "./skills/");
  assert.equal(codexManifest.interface.displayName, "Ultracode");
});

test("source tree has no generated definition leftovers", () => {
  assert.deepEqual(
    fs.readdirSync(path.join(ROOT, "agents")).filter((n) => n.endsWith(".md")),
    [],
  );
  const skillsRoot = path.join(ROOT, "skills");
  const skillDirs = fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(skillsRoot, e.name, "SKILL.md"));
  for (const skillMd of skillDirs) {
    assert.ok(!fs.existsSync(skillMd), `${skillMd} should not exist`);
  }
  assert.deepEqual(
    fs.readdirSync(path.join(ROOT, "commands")).filter((n) => n.endsWith(".md")),
    [],
  );
  assert.ok(!fs.existsSync(path.join(ROOT, ".claude-plugin")));
  assert.ok(!fs.existsSync(path.join(ROOT, ".grok-plugin")));
});

test("grok generation uses Claude-shaped files and grok layout", () => {
  assert.ok(fs.existsSync(path.join(GROK_PLUGIN_ROOT, ".grok-plugin", "plugin.json")));
  assert.ok(fs.existsSync(path.join(GROK_PLUGIN_ROOT, ".grok-plugin", "marketplace.json")));
  assert.ok(!fs.existsSync(path.join(GROK_PLUGIN_ROOT, ".claude-plugin")));
  assert.ok(!fs.existsSync(path.join(GROK_PLUGIN_ROOT, ".codex-plugin")));
  assert.ok(fs.existsSync(path.join(GROK_PLUGIN_ROOT, ".mcp.json")));
  assert.ok(fs.existsSync(path.join(GROK_PLUGIN_ROOT, "commands", "init-kit.md")));
  assert.ok(fs.existsSync(path.join(GROK_PLUGIN_ROOT, "agents", "explore.md")));
  assert.ok(!fs.existsSync(path.join(GROK_PLUGIN_ROOT, "agents", "explore.toml")));

  const plugin = JSON.parse(
    fs.readFileSync(path.join(GROK_PLUGIN_ROOT, ".grok-plugin", "plugin.json"), "utf-8"),
  );
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(GROK_PLUGIN_ROOT, ".grok-plugin", "marketplace.json"), "utf-8"),
  );
  const sourceMetadata = JSON.parse(
    fs.readFileSync(path.join(ROOT, "definitions", "plugin-metadata.json"), "utf-8"),
  );
  assert.equal(plugin.name, sourceMetadata.name);
  assert.equal(plugin.version, sourceMetadata.version);
  assert.equal(marketplace.plugins[0].source.type, "local");
  assert.equal(marketplace.plugins[0].category, sourceMetadata.grok.category);

  const explore = fs.readFileSync(path.join(GROK_PLUGIN_ROOT, "agents", "explore.md"), "utf-8");
  assert.match(explore, /^---\nname: explore\n/);
  assert.match(explore, /prompt_mode: full/);
  assert.match(explore, /permission_mode: default/);
  assert.match(explore, /^effort: high$/m);
  assert.doesNotMatch(explore, /^model:/m);
  const grokEffortByName = Object.fromEntries(
    sourceDefinitions()
      .filter(([, definition]) => definition.kind === "agent")
      .map(([, definition]) => [
        definition.name,
        definition.config.reasoning_effort.grok ??
          definition.config.reasoning_effort.claude,
      ]),
  );
  for (const name of fs.readdirSync(path.join(GROK_PLUGIN_ROOT, "agents"))) {
    if (!name.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(GROK_PLUGIN_ROOT, "agents", name), "utf-8");
    const agentName = name.slice(0, -".md".length);
    assert.doesNotMatch(text, /^model:/m, name);
    assert.match(text, new RegExp(`^effort: ${grokEffortByName[agentName]}$`, "m"), name);
  }
  assert.match(explore, /tools: read_file, search_replace, run_terminal_command, grep, list_dir, web_search, web_fetch/);
  assert.match(explore, /\.grok\/ultracode/);
  assert.ok(!explore.includes(".claude/"));
  assert.ok(!explore.includes("CLAUDE_PLUGIN_ROOT"));

  const orchestrate = fs.readFileSync(
    path.join(GROK_PLUGIN_ROOT, "commands", "orchestrate.md"),
    "utf-8",
  );
  assert.match(orchestrate, /spawn_subagent/);
  assert.match(orchestrate, /subagent_type/);
  assert.match(orchestrate, /# Grok Notes/);
  assert.match(orchestrate, /There is no structured question tool/);
  assert.match(orchestrate, /Grok Build has no Skill tool/);

  const initKit = fs.readFileSync(path.join(GROK_PLUGIN_ROOT, "commands", "init-kit.md"), "utf-8");
  assert.match(initKit, /# \/init-kit/);
  assert.match(initKit, /\$ARGUMENTS/);
  assert.match(initKit, /pressing `r` in the Plugins tab/);
  assert.match(initKit, /\$\{GROK_SESSION_ID:-\$\{CLAUDE_CODE_SESSION_ID:-no-session-id\}\}/);

  const hooks = JSON.parse(fs.readFileSync(path.join(GROK_PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8"));
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /GROK_PLUGIN_ROOT/);
  assert.match(hooks.hooks.PreToolUse[0].matcher, /spawn_subagent/);
  assert.ok(hooks.hooks.PreCompact);
});

test("grok hooks accept camelCase payloads", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-grok-camel-"));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts.grok.runtime_dir;
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const prompt = `Repo root: ${repo}.\nSession dir: ${sessionDir}.`;
  const allowed = runHook(
    path.join(GROK_PLUGIN_ROOT, "hooks", "session-guard.js"),
    {
      cwd: repo,
      sessionId: "testsess",
      toolInput: { subagentType: "ultracode:explore", prompt },
    },
    { GROK_PLUGIN_ROOT: GROK_PLUGIN_ROOT },
  );
  assert.equal(allowed, "");

  const denied = JSON.parse(
    runHook(
      path.join(GROK_PLUGIN_ROOT, "hooks", "session-guard.js"),
      {
        cwd: repo,
        sessionId: "testsess",
        toolInput: { subagentType: "ultracode:explore", prompt: `Repo root: ${repo}.` },
      },
      { GROK_PLUGIN_ROOT: GROK_PLUGIN_ROOT },
    ),
  );
  // A PreToolUse deny lives only in hookSpecificOutput.permissionDecision — the
  // legacy top-level `decision` field accepts "approve"/"block" only, so emitting
  // "deny" there fails the harness schema check and silently drops the whole
  // payload (hooks/lib/common.js, denyPreToolUse).
  assert.equal(denied.decision, undefined);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");

  const bashDenied = JSON.parse(
    runHook(
      path.join(GROK_PLUGIN_ROOT, "hooks", "bash-guard.js"),
      { toolInput: { command: "sleep 5" } },
      { GROK_PLUGIN_ROOT: GROK_PLUGIN_ROOT },
    ),
  );
  assert.equal(bashDenied.decision, undefined);
  assert.equal(bashDenied.hookSpecificOutput.permissionDecision, "deny");
});

test("antigravity generation uses antigravity plugin layout and validation", () => {
  assert.ok(fs.existsSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "plugin.json")));
  assert.ok(fs.existsSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "mcp_config.json")));
  assert.ok(fs.existsSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "hooks.json")));
  assert.ok(fs.existsSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "rules", "AGENTS.md")));
  assert.ok(fs.existsSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "skills", "init-kit", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "skills", "orchestrate", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "agents", "explore.md")));

  const plugin = JSON.parse(
    fs.readFileSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "plugin.json"), "utf-8"),
  );
  assert.equal(plugin.name, "ultracode");
  assert.equal(plugin.displayName, "Ultracode");
  assert.equal(plugin.category, "Productivity");

  const mcpConfig = JSON.parse(
    fs.readFileSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "mcp_config.json"), "utf-8"),
  );
  assert.ok(mcpConfig.mcpServers["ultracode-gate"]);

  const explore = fs.readFileSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "agents", "explore.md"), "utf-8");
  assert.match(explore, /^---\nname: explore\n/);
  assert.match(explore, /^model: claude-opus-4-6-thinking$/m);
  assert.match(explore, /^effort: high$/m);
  assert.match(explore, /tools: view_file, write_to_file, run_command, grep_search, find_by_name, search_web, read_url_content/);

  const orchestrate = fs.readFileSync(
    path.join(ANTIGRAVITY_PLUGIN_ROOT, "skills", "orchestrate", "SKILL.md"),
    "utf-8",
  );
  assert.match(orchestrate, /invoke_subagent/);
  assert.match(orchestrate, /# Antigravity Notes/);
  assert.match(orchestrate, /Antigravity has no separate Skill tool/);
});

test("antigravity hooks accept structured payloads", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-agy-test-"));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts.antigravity.runtime_dir;
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const prompt = `Repo root: ${repo}.\nSession dir: ${sessionDir}.`;

  const allowed = runHook(
    path.join(ANTIGRAVITY_PLUGIN_ROOT, "hooks", "session-guard.js"),
    {
      cwd: repo,
      conversationId: "testsess",
      toolCall: {
        args: {
          Subagents: [{ TypeName: "ultracode:explore", Prompt: prompt }],
        },
      },
    },
    { ANTIGRAVITY_PLUGIN_ROOT: ANTIGRAVITY_PLUGIN_ROOT },
  );
  assert.equal(allowed, "");

  const denied = JSON.parse(
    runHook(
      path.join(ANTIGRAVITY_PLUGIN_ROOT, "hooks", "session-guard.js"),
      {
        cwd: repo,
        conversationId: "testsess",
        toolCall: {
          args: {
            Subagents: [{ TypeName: "ultracode:explore", Prompt: `Repo root: ${repo}.` }],
          },
        },
      },
      { ANTIGRAVITY_PLUGIN_ROOT: ANTIGRAVITY_PLUGIN_ROOT },
    ),
  );
  assert.equal(denied.decision, "deny");
  assert.equal(denied.hookSpecificOutput, undefined);
  assert.ok(denied.reason);

  const bashDenied = JSON.parse(
    runHook(
      path.join(ANTIGRAVITY_PLUGIN_ROOT, "hooks", "bash-guard.js"),
      {
        toolCall: {
          args: { CommandLine: "sleep 5" },
        },
      },
      { ANTIGRAVITY_PLUGIN_ROOT: ANTIGRAVITY_PLUGIN_ROOT },
    ),
  );
  assert.equal(bashDenied.decision, "deny");
  assert.equal(bashDenied.hookSpecificOutput, undefined);
  assert.ok(bashDenied.reason);
});
