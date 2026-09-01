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
  ".ultracode",
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
const SUBAGENT_PARAMETER_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(ROOT, "definitions", "subagent-parameters.schema.json"), "utf-8"),
);
const SUBAGENT_PARAMETERS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "hooks", "subagent-parameters.json"), "utf-8"),
);

const LAYOUT_TOKEN_PATTERN = /\{\{[a-z][a-z0-9_]*\}\}/g;

const COMMAND_NAMES = new Set(["hub-listen", "init-kit", "orchestrate", "yolo"]);

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
  // Mirror the generator's harness-conditional blocks: {{#codex}}…{{/codex}}
  // (or a comma list like {{#codex,grok}}) survives only in the named
  // harnesses' copies and is dropped from every other.
  text = text.replace(
    /[ \t]*\{\{#((?:claude|codex|grok|antigravity)(?:,(?:claude|codex|grok|antigravity))*)\}\}\n?([\s\S]*?)[ \t]*\{\{\/\1\}\}\n?/g,
    (whole, names, body) => (names.split(",").includes(targetName) ? body : ""),
  );
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
    "{{harness_name}}": targetName,
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
  let adapted = adaptForTarget(text, "codex");
  for (const name of Object.keys(BASELINE.agents)) {
    adapted = adapted.split(`ultracode:${name}`).join(`ultracode_${name.replace(/-/g, "_")}`);
  }
  return adapted;
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
  assert.equal(definitions.length, 16);
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

test("subagent parameter contracts cover every agent and reference defined fields", () => {
  assert.equal(SUBAGENT_PARAMETER_SCHEMA.properties.schemaVersion.const, 1);
  assert.equal(SUBAGENT_PARAMETERS.schemaVersion, 1);
  const agentNames = sourceDefinitions()
    .filter(([, definition]) => definition.kind === "agent")
    .map(([, definition]) => definition.name)
    .sort();
  assert.deepEqual(Object.keys(SUBAGENT_PARAMETERS.agents).sort(), agentNames);
  const parameterNames = new Set(Object.keys(SUBAGENT_PARAMETERS.parameters));
  for (const [agent, contract] of Object.entries(SUBAGENT_PARAMETERS.agents)) {
    for (const name of contract.required || []) {
      assert.ok(parameterNames.has(name), `${agent}: undefined required parameter ${name}`);
    }
    for (const group of contract.oneOf || []) {
      assert.ok(group.length >= 2, `${agent}: oneOf group is not an alternative`);
      for (const name of group) assert.ok(parameterNames.has(name), `${agent}: undefined alternative ${name}`);
    }
    for (const [mode, names] of Object.entries(contract.modes || {})) {
      for (const name of names) assert.ok(parameterNames.has(name), `${agent}/${mode}: undefined parameter ${name}`);
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
  assert.match(stdout, /generated 16 definitions for claude/);
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
    // agent_type charset forbids ':', so codex roles carry the namespace as a prefix.
    assert.equal(parsed.name, `ultracode_${name.replace(/-/g, "_")}`);
    // No model here, on purpose: a role-file model unconditionally overrides
    // the spawn-time model argument, which is where the model-router injects
    // the repo-profile route. Baking one would freeze the role's model and
    // disable dynamic routing.
    assert.equal(parsed.model, undefined);
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
    fast: { claude: "haiku", codex: "gpt-5.6-luna", grok: "grok-4.5", antigravity: "flash" },
    balanced: { claude: "sonnet", codex: "gpt-5.6-terra", grok: "grok-4.5", antigravity: "flash" },
    advanced: { claude: "opus", codex: "gpt-5.6-sol", grok: "grok-4.5", antigravity: "flash" },
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
  assert.match(skill.codex_strategy, /Codex has no tool for local skills/);
  assert.match(skill.grok_strategy, /default toolset has no skill tool/);

  const implementGrok = fs.readFileSync(
    path.join(GROK_PLUGIN_ROOT, "agents", "implement.md"),
    "utf-8",
  );
  assert.match(implementGrok, /SUBAGENTS receive no catalog/);
  assert.match(implementGrok, /read_file on the skill's SKILL.md/);
  assert.match(implementGrok, /\.grok\/skills\/\{name\}\/SKILL\.md/);
  assert.doesNotMatch(implementGrok, /NEVER read a skill's `SKILL\.md`/);
  assert.match(implementGrok, /Load a per-repo skill by NAME/);
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
  assert.match(implementCodex, /Codex has no tool for local skills/);
  assert.match(implementCodex, /exec_command on the skill's SKILL.md/);
  assert.match(implementCodex, /\.agents\/skills\/\{name\}\/SKILL\.md/);
  assert.doesNotMatch(implementCodex, /NEVER read a skill's `SKILL\.md`/);
  assert.match(implementCodex, /Load a per-repo skill by NAME/);
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

test("orchestrate resolves {{harness_name}} to each target's own concrete name", () => {
  // Harness routes in repo-profile.json are compared against "this session's
  // harness"; the generated prompt must carry the concrete name (never a
  // relative term) so every harness reading the same profile resolves a route
  // identically.
  const artifacts = {
    claude: path.join(CLAUDE_PLUGIN_ROOT, "commands", "orchestrate.md"),
    codex: path.join(CODEX_PLUGIN_ROOT, "skills", "orchestrate", "SKILL.md"),
    grok: path.join(GROK_PLUGIN_ROOT, "commands", "orchestrate.md"),
    antigravity: path.join(ANTIGRAVITY_PLUGIN_ROOT, "skills", "orchestrate", "SKILL.md"),
  };
  for (const [target, artifact] of Object.entries(artifacts)) {
    const text = fs.readFileSync(artifact, "utf-8");
    assert.ok(
      text.includes(`This session's harness is \`${target}\``),
      `${target}: orchestrate must state its own harness name`,
    );
    assert.ok(!text.includes("{{harness_name}}"), `${target}: token must be resolved`);
  }
});

test("installer ensures the machine-level hub after dependencies, before registration", () => {
  const script = fs.readFileSync(INSTALLER, "utf-8");
  assert.match(script, /node "\$PLUGIN_ROOT\/mcp\/hub-ctl\.js" ensure --restart-if-older/);
  const npmCiIndex = script.indexOf("npm ci --omit=dev");
  const hubEnsureIndex = script.indexOf("hub-ctl.js\" ensure");
  const claudeRegisterIndex = script.indexOf('if [ "$HARNESS" = claude ]');
  assert.ok(hubEnsureIndex > npmCiIndex, "hub ensure needs the installed node_modules");
  assert.ok(claudeRegisterIndex > hubEnsureIndex);
  // AGY's external MCP registration must point at the shim, not the bare stdio server.
  assert.match(script, /agy mcp add ultracode-gate node "\$PLUGIN_ROOT\/mcp\/hub-shim\.js"/);
  // Codex does not expand ${PLUGIN_ROOT} in plugin-manifest mcpServers (0.151.0),
  // so the installer must register the shim explicitly there too.
  assert.match(script, /codex mcp add ultracode-gate -- node "\$PLUGIN_ROOT\/mcp\/hub-shim\.js"/);
  // Codex reads agent_types only from config.toml [agents.*]; the installer
  // registers the plugin's roles and the uninstaller removes them.
  assert.match(script, /register_codex_agents\.js" --plugin-root "\$PLUGIN_ROOT"/);
  // Codex plugin-cache refreshes have been measured dropping directories
  // silently (zero hooks fire); the installer must verify the cache after add.
  assert.match(script, /CODEX_CACHE_ROOT.*Installed plugin root/);
  assert.match(script, /\$CODEX_CACHE_ROOT\/hooks\/hooks\.json/);
  // Uninstall stops the daemon but keeps ~/.ultracode (token survives reinstalls).
  const uninstall = fs.readFileSync(UNINSTALLER, "utf-8");
  assert.match(uninstall, /hub-ctl\.js/);
  assert.match(uninstall, /Left ~\/\.ultracode/);
  // ...and the uninstaller removes codex's external registrations.
  assert.match(uninstall, /codex mcp remove ultracode-gate/);
  assert.match(uninstall, /register_codex_agents\.js" --remove/);
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
  // The registered entry point is the hub shim; with the hub disabled it must
  // boot offline (core tools only) and shut down just as cleanly.
  const shimResult = execFileSync("node", [path.join(output, "mcp", "hub-shim.js")], {
    input: "",
    encoding: "utf-8",
    env: { ...process.env, ULTRACODE_HUB_DISABLE: "1" },
  });
  assert.equal(shimResult, "");
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

// Grok refits a >256-char deny reason to its clip_reason cap (head + final
// sentence; hooks/lib/grok-hooks.js), so a pattern that lives mid-message must
// assert a fragment that actually survives there — those are literally the
// only bytes the model ever sees on grok.
function pickPattern(target, full, grokVisible) {
  return target === "grok" ? grokVisible : full;
}

function denyReason(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.reason === "string" && payload.reason) return payload.reason;
  const output = payload.hookSpecificOutput;
  if (output && typeof output.permissionDecisionReason === "string") {
    return output.permissionDecisionReason;
  }
  return "";
}

function assertDenied(payload, pattern, label = "expected denial") {
  const reason = denyReason(payload);
  assert.ok(reason, label);
  if (payload.decision === "deny") {
    assert.match(reason, pattern, label);
    return;
  }
  assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", label);
  assert.match(reason, pattern, label);
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

  const routed = JSON.parse(run());
  const output = routed.hookSpecificOutput;
  assert.equal(output.updatedInput.model, expected);
  // Grok schema-validates a rewrite and BLOCKS the call on any unusable one,
  // so nothing may ride outside hookSpecificOutput (a stray top-level
  // `overwrite` was only ever warned-and-ignored there).
  assert.equal(routed.overwrite, undefined);
  if (target === "codex" || target === "grok") {
    assert.equal(output.permissionDecision, "allow");
  }
  if (target === "codex") {
    // Codex defaults an absent fork_turns to "all"; the router pins "none".
    assert.equal(output.updatedInput.fork_turns, "none");
  }
  if (target === "grok") {
    // No fork_turns concept on grok — the rewrite must stay schema-clean.
    assert.equal(output.updatedInput.fork_turns, undefined);
  }
  if (target === "claude") {
    assert.equal(routed.decision, undefined);
  }

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
  );
  if (target === "grok") {
    assert.equal(conflicted.decision, "deny");
    assert.match(conflicted.reason, /does not match the routed model/);
    assert.match(conflicted.reason, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } else {
    assert.equal(conflicted.hookSpecificOutput.permissionDecision, "deny");
    assert.match(conflicted.hookSpecificOutput.permissionDecisionReason, /does not match the routed model/);
    assert.match(
      conflicted.hookSpecificOutput.permissionDecisionReason,
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  profile.models.byAgent["code-reviewer"] = "inherit";
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const inherited = run({
    ...hookInput,
    tool_input: { ...hookInput.tool_input, model: "wrong-model" },
  });
  if (target === "codex") {
    // "inherit" leaves the model alone, but the fork_turns pin (absent
    // defaults to "all" on codex) applies regardless of the route.
    const untouched = JSON.parse(inherited).hookSpecificOutput.updatedInput;
    assert.equal(untouched.model, "wrong-model");
    assert.equal(untouched.fork_turns, "none");
  } else {
    assert.equal(inherited, "");
  }

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
  const denied = JSON.parse(run());
  if (target === "grok") {
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /no model route/);
  } else {
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /no model route/);
  }
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
  // Profile-only facts are carried: skills by name AND path.
  assert.ok(
    brief.includes(`\`convention\` — \`${skillsDir}/convention/SKILL.md\``),
    `${target}: brief carries the convention skill's name and path`,
  );
  assert.match(brief, /name first, path as fallback/);
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
    return JSON.parse(stdout);
  };

  const first = route();
  assert.equal(first.overwrite, undefined, "rewrites live in hookSpecificOutput only");
  assert.notEqual(first.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(first.hookSpecificOutput.updatedInput.model, "chosen-by-init-kit");

  profile.models.byAgent.initializer = "fast";
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const overridden = route();
  if (target === "grok") {
    assert.equal(overridden.decision, "deny");
    assert.match(overridden.reason, /does not match the routed model/);
    assert.match(
      overridden.reason,
      new RegExp(explicitTierModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } else {
    assert.equal(overridden.hookSpecificOutput.permissionDecision, "deny");
    assert.match(overridden.hookSpecificOutput.permissionDecisionReason, /does not match the routed model/);
    assert.match(
      overridden.hookSpecificOutput.permissionDecisionReason,
      new RegExp(explicitTierModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  hookInput.tool_input = { ...hookInput.tool_input };
  delete hookInput.tool_input.model;
  const rewritten = route();
  assert.equal(rewritten.overwrite, undefined, "rewrites live in hookSpecificOutput only");
  assert.notEqual(rewritten.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(rewritten.hookSpecificOutput.updatedInput.model, explicitTierModel);
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

// The cap is a budget, not a safety rule, so the capped spawn is handed to the
// user rather than refused: an ask wherever the harness has one. Grok's is
// source-verified (xai-grok-hooks runner/mod.rs accepts "ask"); its reason is
// refit to the 256-char clip_reason cap by lib/grok-hooks.js first.
function assertCapAsked(payload, pattern, target) {
  const label = `${target}: capped review spawn goes to the user`;
  if (target === "antigravity") {
    // force_ask, not ask: plain "ask" honors AGY's always-allow cache, so a user
    // who once chose always-allow for spawns would never see the question.
    assert.equal(payload.decision, "force_ask", label);
    assert.equal(payload.hookSpecificOutput, undefined, "AGY must receive no unknown fields");
    assert.match(payload.reason, pattern, label);
    return;
  }
  assert.equal(payload.hookSpecificOutput.permissionDecision, "ask", label);
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, pattern, label);
  assert.notEqual(payload.hookSpecificOutput.permissionDecision, "deny", label);
  if (target === "grok") {
    assert.ok(
      payload.hookSpecificOutput.permissionDecisionReason.length <= 256,
      `${label} (reason must fit grok's 256-char clip)`,
    );
  }
}

function reviewCapTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-reviewcap-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const pluginRoot = pluginRootFor(target);
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const spawnPrompt = (phase) =>
    `Repo root: ${repo}.\nSession dir: ${sessionDir}.\nPhase: ${phase}.`;
  const payloadFor = (phase) =>
    target === "antigravity"
      ? {
          cwd: repo,
          conversationId: "testsess",
          toolCall: {
            name: "invoke_subagent",
            args: {
              Subagents: [
                {
                  Role: "Code Reviewer",
                  TypeName: "ultracode-code-reviewer",
                  Prompt: spawnPrompt(phase),
                },
              ],
            },
          },
        }
      : {
          cwd: repo,
          session_id: "testsess",
          tool_input: {
            subagent_type: "ultracode:code-reviewer",
            prompt: spawnPrompt(phase),
          },
        };
  const env =
    target === "antigravity"
      ? { PLUGIN_ROOT: pluginRoot, ANTIGRAVITY_PLUGIN_ROOT: pluginRoot }
      : { PLUGIN_ROOT: pluginRoot };
  const run = (phase) =>
    runHook(path.join(pluginRoot, "hooks", "review-cap.js"), payloadFor(phase), env);

  assert.equal(run("1"), ""); // no ledger yet — first pass allowed

  const ledgerPath = path.join(sessionDir, "ultracode-review-ledger-phase-1.md");
  fs.writeFileSync(
    ledgerPath,
    "## Iteration 1 (context: implementation)\n\n## Iteration 2 (context: implementation)\n",
    "utf-8",
  );
  assert.equal(run("1"), ""); // 2 prior iterations — still allowed

  fs.appendFileSync(ledgerPath, "\n## Iteration 3 (context: implementation)\n", "utf-8");
  assertCapAsked(JSON.parse(run("1")), /review loop cap reached \(3\/3\) for phase 1 /, target);

  // A different loop keeps its own count: phase 1 being exhausted must not cap
  // phase 2's first review, nor phase 1's closing test review.
  assert.equal(run("2"), "");
  assert.equal(run("1-tests"), "");
  assert.equal(run("none"), "");

  // ...and each of those caps on its own ledger.
  const testLedger = path.join(sessionDir, "ultracode-review-ledger-phase-1-tests.md");
  fs.writeFileSync(testLedger, "## Iteration 1\n## Iteration 2\n## Iteration 3\n", "utf-8");
  assertCapAsked(
    JSON.parse(run("1-tests")),
    /review loop cap reached \(3\/3\) for phase 1-tests /,
    target,
  );
  assert.equal(run("2"), ""); // phase 2 still untouched by either exhausted loop

  // YOLO mode: nobody is present to answer an ask, so the loop runs on a larger
  // budget (10), and at exhaustion the spawn is DENIED with the orchestrator
  // told to resolve the impasse itself — each denial then authorizes exactly
  // one verification pass, so the loop can converge but never spin blind.
  const hubHome = path.join(tempDir, "machine-state");
  process.env.ULTRACODE_HUB_HOME = hubHome;
  try {
    const { writeYoloEntry } = require(path.join(ROOT, "hooks", "lib", "yolo-state.js"));
    writeYoloEntry({
      session_dir: sessionDir,
      primary_repo_root: repo,
      enabled: true,
      updated_by: "test",
    });
  } finally {
    delete process.env.ULTRACODE_HUB_HOME;
  }
  const runYolo = (phase) =>
    runHook(path.join(pluginRoot, "hooks", "review-cap.js"), payloadFor(phase), {
      ...env,
      ULTRACODE_HUB_HOME: hubHome,
    });
  // 3 iterations sit under the YOLO budget: the pass the ask would have gated
  // now just runs.
  assert.equal(runYolo("1"), "");
  fs.writeFileSync(
    ledgerPath,
    Array.from({ length: 10 }, (_, i) => `## Iteration ${i + 1}`).join("\n") + "\n",
    "utf-8",
  );
  assertDenied(
    JSON.parse(runYolo("1")),
    /YOLO review budget exhausted \(10\/10\) for phase 1 /,
    `${target}: exhausted YOLO loop escalates to the orchestrator`,
  );
  const escalations = JSON.parse(
    fs.readFileSync(path.join(sessionDir, "ultracode-yolo-review-escalations.json"), "utf-8"),
  );
  assert.equal(escalations["ultracode-review-ledger-phase-1.md"], 10);
  // The denial authorized one verification pass at the same iteration count...
  assert.equal(runYolo("1"), "");
  // ...and the pass after it (the ledger grew) is denied again.
  fs.appendFileSync(ledgerPath, "## Iteration 11\n", "utf-8");
  assertDenied(
    JSON.parse(runYolo("1")),
    /YOLO review budget exhausted \(11\/10\) for phase 1 /,
    `${target}: every extra YOLO pass costs a resolution round`,
  );
  // Other loops keep their own budget, and the interactive ask returns the
  // moment YOLO is off (env without the hub home reads no YOLO state).
  assert.equal(runYolo("2"), "");
  assertCapAsked(JSON.parse(run("1-tests")), /review loop cap reached \(3\/3\) /, target);
}

test("review-cap puts a 4th code-review iteration to the user", () => {
  reviewCapTest("claude");
  reviewCapTest("codex");
  reviewCapTest("grok");
  reviewCapTest("antigravity");
});

function sessionGuardTest(target) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-sessguard-${target}-`));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts[target].runtime_dir;
  const pluginRoot = pluginRootFor(target);
  const expectedDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  const hookPath = path.join(pluginRoot, "hooks", "session-guard.js");
  const run = (prompt, includePrimary = true) =>
    runHook(
      hookPath,
      {
        cwd: repo,
        session_id: "testsess",
        tool_input: {
          subagent_type: "ultracode:explore",
          prompt: includePrimary ? `Primary repo root: ${repo}.\n${prompt}` : prompt,
        },
      },
      { PLUGIN_ROOT: pluginRoot },
    );

  assert.equal(run(`Repo root: ${repo}.\nSession dir: ${expectedDir}.\nRepo key: backend.\nTask: inspect repository.`), "");
  assert.equal(
    run(`Repo root: ${repo}.\nSession dir: ${path.join(expectedDir, "backend")}.\nRepo key: backend.\nTask: inspect repository.`),
    "",
  );

  assertDenied(
    JSON.parse(
      run(
        `Repo root: ${repo}.\nSession dir: ${expectedDir}.\nRepo key: backend.\nTask: inspect repository.`,
        false,
      ),
    ),
    /no Primary repo root:/,
  );

  assertDenied(JSON.parse(run(`Repo root: ${repo}.`)), /no Session dir:/);

  assertDenied(
    JSON.parse(
      run(
        `Repo root: ${repo}.\nSession dir: ${path.join(repo, runtimeDir, "session", "ultracode-session-RANDOM")}.` +
          "\nRepo key: backend.\nTask: inspect repository.",
      ),
    ),
    // The "Use <expected dir>" guidance is mid-message and does not survive
    // grok's 256-char refit; the claim itself does.
    pickPattern(
      target,
      new RegExp(expectedDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      /not under the primary repository session/,
    ),
  );

  // The repo key is half the address of every recorded fact-check verdict, so a
  // spawn without one is refused rather than left to record state the gate tool
  // cannot find. A key that disagrees with the session dir's own subdirectory is
  // the same defect wearing a valid-looking key.
  assertDenied(JSON.parse(run(`Repo root: ${repo}.\nSession dir: ${expectedDir}.`)), /no Repo key:/);

  assertDenied(
    JSON.parse(run(`Repo root: ${repo}.\nSession dir: ${expectedDir}.\nRepo key: Back End!.`)),
    /is not a repo key/,
  );

  assertDenied(
    JSON.parse(
      run(
        `Repo root: ${repo}.\nSession dir: ${path.join(expectedDir, "web")}.\nRepo key: backend.\nTask: inspect repository.`,
      ),
    ),
    /does not match Session dir/,
  )

  const workRepo = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-workrepo-${target}-`));
  assert.equal(
    run(`Repo root: ${workRepo}.\nSession dir: ${path.join(expectedDir, "backend")}.\nRepo key: backend.\nTask: inspect work repo.`),
    "",
  );
  runHook(
    path.join(pluginRoot, "hooks", "spawn-scope.js"),
    {
      cwd: repo,
      session_id: "testsess",
      tool_input: {
        subagent_type: "ultracode:implement",
        prompt:
          `Repo root: ${workRepo}.\nSession dir: ${path.join(expectedDir, "backend")}.\nRepo key: backend.` +
          `\nNo plan: cross-repo fix.\nReport file: ${path.join(expectedDir, "backend", "report.md")}.`,
      },
    },
    { PLUGIN_ROOT: pluginRoot },
  );
  const sharedScope = JSON.parse(fs.readFileSync(path.join(expectedDir, "spawn-scope.json"), "utf-8"));
  assert.equal(sharedScope.scopes.implement.backend.repoRoot, workRepo);
  assert.equal(
    fs.existsSync(path.join(workRepo, runtimeDir, "session", "ultracode-session-testsess", "spawn-scope.json")),
    false,
  );
  assertDenied(
    JSON.parse(
      run(
        `Repo root: ${workRepo}.\nSession dir: ${path.join(workRepo, runtimeDir, "session", "ultracode-session-testsess", "backend")}.` +
          "\nRepo key: backend.\nTask: inspect work repo.",
      ),
    ),
    pickPattern(target, /primary repository session root/, /is not under the primary repository/),
  );
}

test("session-guard enforces primary repo, session dir, repo key, and agent parameters", () => {
  sessionGuardTest("claude");
  sessionGuardTest("codex");
  sessionGuardTest("grok");
});

// Phase: addresses the review ledger review-cap.js counts, so an absent or
// malformed value is refused rather than silently pooling two loops into one
// ledger and capping the second before it runs.
test("session-guard requires a well-formed Phase: on every code-reviewer spawn", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-reviewphase-"));
  const pluginRoot = pluginRootFor("claude");
  const runtimeDir = HARNESS_LAYOUT.layouts.claude.runtime_dir;
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess", "backend");
  const run = (phaseLine) =>
    runHook(
      path.join(pluginRoot, "hooks", "session-guard.js"),
      {
        cwd: repo,
        session_id: "testsess",
        tool_input: {
          subagent_type: "ultracode:code-reviewer",
          prompt:
            `Primary repo root: ${repo}.\nRepo root: ${repo}.\nSession dir: ${sessionDir}.\n` +
            `Repo key: backend.\nChanged files: src/app.ts.\nChange rationale: phase intent.${phaseLine}`,
        },
      },
      { PLUGIN_ROOT: pluginRoot },
    );

  for (const phase of ["1", "12", "2-tests", "none"]) {
    assert.equal(run(`\nPhase: ${phase}.`), "", `Phase: ${phase} should be accepted`);
  }
  assertDenied(JSON.parse(run("")), /no Phase:/);
  assertDenied(JSON.parse(run("\nPhase: second.")), /must be a phase number/);
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
    assertDenied(JSON.parse(run(command)), /Hard rule 19/, command);
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
    assertDenied(JSON.parse(run(`/repo/.ultracode/session/x/${name}`)), /Rules D3\/D10\/D17/, name);
  }

  assert.equal(run("/repo/src/App.ts"), "");
  assert.equal(
    run("/repo/.ultracode/session/x/ultracode-spec-2026-01-01-topic.md", "ultracode:generate-spec"),
    "",
  );

  // Ledger ownership (hooks/lib/ledger-policy.js) binds every writer, unlike the
  // spec/plan rule above which exempts the owning subagent.
  const ledgerDenied = (name, agentType) => {
    const raw = run(`/repo/.ultracode/session/x/${name}`, agentType);
    assert.notEqual(raw, "", `${name} as ${agentType || "orchestrator"} should be denied`);
    return denyReason(JSON.parse(raw));
  };
  const ledgerAllowed = (name, agentType) =>
    assert.equal(
      run(`/repo/.ultracode/session/x/${name}`, agentType),
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

// The commands in DENIED_* below are the shapes recorded in a real Antigravity
// session where the orchestrator, blocked from writing factcheck.json with the
// write tool, ran ultracode's own code instead: `node <plugin>/mcp/gate-server.js`,
// then `node -e "require('<plugin>/mcp/lib/gate.js').recordGateDecision(...)"`,
// then `node -e "require('<plugin>/hooks/lib/common.js').writeJsonAtomic(
// '<session>/factcheck.json', …)"` — approving its own spec with a fact-check
// PASS no agent ever returned. None of them names a protected path in an
// argument position, which is why every path-based guard passed them through.
function pluginGuardTest(target) {
  const pluginRoot = pluginRootFor(target);
  const hookPath = path.join(pluginRoot, "hooks", "plugin-guard.js");
  const antigravity = target === "antigravity";
  const env = { [HARNESS_LAYOUT.layouts[target].plugin_root_env]: pluginRoot };
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-plugguard-${target}-`));
  const session = path.join(
    repo,
    HARNESS_LAYOUT.layouts[target].runtime_dir,
    "session",
    "ultracode-session-testsess",
  );

  const command = (text, cwd = repo) =>
    runHook(
      hookPath,
      antigravity
        ? { cwd, toolCall: { args: { CommandLine: text, Cwd: cwd } } }
        : { cwd, tool_input: { command: text, cwd } },
      env,
    );
  const write = (filePath) =>
    runHook(
      hookPath,
      antigravity
        ? { cwd: repo, toolCall: { args: { TargetFile: filePath } } }
        : { cwd: repo, tool_input: { file_path: filePath } },
      env,
    );
  const reasonOf = (raw, label) => {
    assert.notEqual(raw, "", `${target}: ${label} must be denied`);
    const reason = denyReason(JSON.parse(raw));
    assert.ok(reason, `${target}: ${label} must expose a denial reason`);
    return reason;
  };

  // Running or loading ultracode's own code, in every spelling the recorded
  // session used plus the obvious variations on it.
  for (const text of [
    `node ${pluginRoot}/mcp/gate-server.js`,
    `node -e "require('${pluginRoot}/mcp/lib/gate.js').recordGateDecision('${session}','spec','approved')"`,
    `node -e "require('${pluginRoot}/hooks/lib/common.js').writeJsonAtomic('x.json',{})"`,
    `bash -c "node ${pluginRoot}/hooks/factcheck-record.js < /tmp/payload.json"`,
    `cat /tmp/payload.json | node ${pluginRoot}/hooks/factcheck-record.js`,
    `cd ${pluginRoot} && node ./hooks/factcheck-record.js`,
    // Disarming a guard is the same class of move as impersonating one.
    `sed -i 's/deny/allow/' ${pluginRoot}/hooks/pipeline-gate.js`,
    `rm ${pluginRoot}/hooks/plugin-guard.js`,
    `chmod -x ${pluginRoot}/hooks/bash-scope-guard.js`,
    `echo '{}' > ${pluginRoot}/hooks/model-routing.json`,
  ]) {
    assert.match(
      reasonOf(command(text), text),
      pickPattern(
        target,
        /ultracode's own plugin code|plugin tree/,
        /ultracode's own plugin code|plugin tree|writes, moves, or deletes/,
      ),
    );
  }

  // Reading the plugin stays allowed: a denial is only useful if the caller can
  // go look up the rule that produced it.
  for (const text of [
    `cat ${pluginRoot}/hooks/pipeline-gate.js`,
    `grep -n "deny" ${pluginRoot}/hooks/pipeline-gate.js`,
    `head -40 ${pluginRoot}/mcp/lib/gate.js`,
    `sed -n '1,20p' ${pluginRoot}/hooks/lib/ledger-policy.js`,
  ]) {
    assert.equal(command(text), "", `${target}: ${text} must stay allowed`);
  }

  // An interpreter fed inline code is the other half of the bypass: shell-paths.js
  // sees `> file`, never `fs.writeFileSync` inside a JS string.
  assert.match(
    reasonOf(command(`node -e "require('fs').writeFileSync('${session}/factcheck.json','{}')"`), "eval ledger write"),
    pickPattern(target, /forge a pipeline decision/, /forge a pipeline decision|one legitimate author/),
  );
  assert.match(
    reasonOf(command(`python3 -c "open('${session}/gates.json','w').write('{}')"`), "python ledger write"),
    pickPattern(target, /forge a pipeline decision/, /forge a pipeline decision|one legitimate author/),
  );
  assert.match(
    reasonOf(command(`python3 - <<'PY'\nopen('out.json','w').write('{}')\nPY`), "heredoc write"),
    /opaque|writes to the filesystem/,
  );
  assert.match(
    reasonOf(command(`node -e "require('child_process').execSync('ls')"`), "eval spawn"),
    /spawns another process/,
  );

  // Inline code that only reads or prints is ordinary tooling, not a channel.
  for (const text of [
    'node -e "console.log(process.version)"',
    'node -p "require(\'./package.json\').version"',
    'python3 -c "print(open(\'README.md\').read())"',
    "npm test",
    "./mvnw -q compile",
    "git status",
    "node hooks/bash-guard.js", // ultracode's own source checkout: no plugin markers
  ]) {
    assert.equal(command(text), "", `${target}: ${text} must stay allowed`);
  }

  // The write-tool half of the same rule.
  assert.match(
    reasonOf(write(path.join(pluginRoot, "hooks", "pipeline-gate.js")), "plugin write"),
    pickPattern(target, /read-only/, /read-only|inside ultracode's inst/),
  );
  assert.equal(write(path.join(repo, "src", "App.ts")), "");
  assert.equal(write(path.join(session, "ultracode-implement-phase-1.md")), "");
}

test("plugin-guard denies running, loading, or patching ultracode's own code", () => {
  pluginGuardTest("claude");
  pluginGuardTest("codex");
  pluginGuardTest("grok");
  pluginGuardTest("antigravity");
});

// Antigravity spawns carry a free-text `Role` the model writes itself next to the
// canonical `TypeName`. Resolving from `Role` yields "fact-checker" /
// "implementation-planner" — names no hook knows — so pipeline-gate skips its gate,
// factcheck-record bails, and model-router finds no route: every per-agent guard
// turns itself off, and the model can trigger that by renaming its own spawn.
function agentResolutionTest(target) {
  const pluginRoot = pluginRootFor(target);
  const { agentFromToolInput } = require(path.join(pluginRoot, "hooks", "lib", "common.js"));
  const shapes = [
    [{ Subagents: [{ Role: "Fact Checker", TypeName: "ultracode-fact-check" }] }, "fact-check"],
    [{ Subagents: [{ Role: "Implementation Planner", TypeName: "ultracode-plan" }] }, "plan"],
    [{ Subagents: [{ Role: "Codebase Researcher", TypeName: "ultracode:explore" }] }, "explore"],
    [{ Subagents: [{ Role: "Specification Engineer", TypeName: "ultracode-generate-spec" }] }, "generate-spec"],
    // Canonical name in whichever field carries it, including only-Role spawns.
    [{ Subagents: [{ Role: "ultracode-fact-check" }] }, "fact-check"],
    [{ Subagents: [{ TypeName: "ultracode-plan" }] }, "plan"],
    [{ subagent_type: "ultracode:implement" }, "implement"],
    [{ agent_type: "ultracode-code-reviewer" }, "code-reviewer"],
    [{ agent_type: "fact_check" }, "fact-check"],
    [{ agent_name: "fact_check" }, "fact-check"],
    // AGY's own built-in kinds are never ultracode agents.
    [{ Subagents: [{ Role: "self", TypeName: "self" }] }, ""],
    // A genuinely non-ultracode subagent still resolves to something loggable,
    // canonical field first.
    [{ Subagents: [{ Role: "Some Helper", TypeName: "team-linter" }] }, "team-linter"],
  ];
  for (const [toolInput, expected] of shapes) {
    assert.equal(
      agentFromToolInput(toolInput),
      expected,
      `${target}: ${JSON.stringify(toolInput)}`,
    );
  }
}

test("agent resolution prefers the shipped agent name over a free-text Role", () => {
  agentResolutionTest("claude");
  agentResolutionTest("codex");
  agentResolutionTest("grok");
  agentResolutionTest("antigravity");
});

test("a Role-labelled AGY plan spawn is still gated and still routed", () => {
  const pluginRoot = ANTIGRAVITY_PLUGIN_ROOT;
  const runtimeDir = HARNESS_LAYOUT.layouts.antigravity.runtime_dir;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-agy-role-"));
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(repo, runtimeDir, "repo-profile.json"),
    JSON.stringify({ models: { byAgent: { plan: "balanced" }, byPhaseComplexity: {} } }),
    "utf-8",
  );
  const env = { ANTIGRAVITY_PLUGIN_ROOT: pluginRoot };
  const payload = {
    cwd: repo,
    conversationId: "testsess",
    toolCall: {
      name: "invoke_subagent",
      args: {
        Subagents: [
          {
            Role: "Implementation Planner",
            TypeName: "ultracode-plan",
            Model: "inherit",
            Prompt: `Repo root: ${repo}\nSession dir: ${sessionDir}\n`,
          },
        ],
      },
    },
  };

  const gate = JSON.parse(
    runHook(path.join(pluginRoot, "hooks", "pipeline-gate.js"), payload, env),
  );
  assert.equal(gate.decision, "deny");
  assert.match(gate.reason, /refusing to spawn ultracode:plan/);

  // The router must route it too — a Role-derived name matched no `defaults` key,
  // so the spawn used to run on whatever model the parent happened to have.
  const routed = JSON.parse(
    runHook(path.join(pluginRoot, "hooks", "model-router.js"), payload, env),
  );
  assert.equal(routed.decision, "allow");
  assert.equal(
    routed.overwrite.Subagents[0].Model,
    MODEL_MAPPING.tiers.balanced.antigravity,
  );
});

// Built from the real transcript AGY wrote during conversation
// 48e8b97b-fe9a-4690-9754-fb06458e3c49: an invoke_subagent call, the
// "Created the following subagents" result that names the subagent's
// conversationId, and the SYSTEM_MESSAGE step whose sender is that same id.
function agyTranscript(sessionDir, repo, { sender, verdict, target, step, agent, repoKey = "backend" }) {
  return [
    {
      step_index: step - 3,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      tool_calls: [
        {
          name: "invoke_subagent",
          args: {
            Subagents: [
              {
                Model: "inherit",
                Role: "Fact Checker",
                TypeName: agent,
                Prompt:
                  `Repo root: ${repo}\nSession dir: ${sessionDir}\n` +
                  (repoKey ? `Repo key: ${repoKey}\n` : "") +
                  `Target type: ${target}\n`,
              },
            ],
          },
        },
      ],
    },
    {
      step_index: step - 2,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: `Created the following subagents:\n{\n  "conversationId": "${sender}",\n  "workspaceUris": ["file://${repo}"]\n}\nThe subagents will send you a message when they have completed their task.`,
    },
    {
      step_index: step,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      content:
        "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n" +
        `[Message] timestamp=2026-08-20T18:31:28Z sender=${sender} priority=MESSAGE_PRIORITY_HIGH ` +
        `content={"verdict": "${verdict}", "target": "${target}", "findings": []}\n</SYSTEM_MESSAGE>`,
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}

test("agy-message-record recovers a fact-check verdict AGY never puts in a tool result", () => {
  const pluginRoot = ANTIGRAVITY_PLUGIN_ROOT;
  const runtimeDir = HARNESS_LAYOUT.layouts.antigravity.runtime_dir;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-agy-verdict-"));
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess", "backend");
  fs.mkdirSync(sessionDir, { recursive: true });
  const transcriptPath = path.join(repo, "transcript_full.jsonl");
  const hookPath = path.join(pluginRoot, "hooks", "agy-message-record.js");
  const factcheckPath = path.join(sessionDir, "factcheck.json");
  const env = { ANTIGRAVITY_PLUGIN_ROOT: pluginRoot };
  const run = () =>
    runHook(
      hookPath,
      {
        conversationId: "testsess",
        workspacePaths: [repo],
        transcriptPath,
        invocationNum: 1,
      },
      env,
    );
  const write = (options) =>
    fs.writeFileSync(transcriptPath, agyTranscript(sessionDir, repo, options), "utf-8");

  // Happy path: the verdict lands in the file the gate reads, and the hook says so.
  write({ sender: "ee2e6159-d766-4f04-8d7f-2825eada35fb", verdict: "PASS", target: "spec", step: 120, agent: "ultracode-fact-check" });
  const injected = JSON.parse(run());
  assert.match(injected.injectSteps[0].ephemeralMessage, /recorded ultracode:fact-check's verdict/);
  const recorded = JSON.parse(fs.readFileSync(factcheckPath, "utf-8"));
  assert.equal(recorded.spec.verdict, "PASS");
  assert.equal(recorded.spec.rounds, 1);
  assert.equal(recorded.spec.sourceStep, 120);

  // Firing on every invocation must not re-record or inflate rounds.
  assert.deepEqual(JSON.parse(run()), {});
  assert.equal(JSON.parse(fs.readFileSync(factcheckPath, "utf-8")).spec.rounds, 1);

  // A later verdict for the same target supersedes it and counts a round.
  write({ sender: "aa11bb22-cc33-dd44-ee55-ff6677889900", verdict: "FAIL", target: "spec", step: 190, agent: "ultracode-fact-check" });
  run();
  const second = JSON.parse(fs.readFileSync(factcheckPath, "utf-8"));
  assert.equal(second.spec.verdict, "FAIL");
  assert.equal(second.spec.rounds, 2);

  // Unhappy paths, each of which must record NOTHING.
  const cases = {
    "a message whose sender matches no spawn": (text) =>
      text.replace(/sender=[0-9a-f-]+/, "sender=99999999-9999-9999-9999-999999999999"),
    "a verdict attributed to a different agent": (text) =>
      text.replace(/ultracode-fact-check/, "ultracode-explore"),
    "a spawn with no reported conversationId": (text) =>
      text.replace(/Created the following subagents[\s\S]*?workspaceUris[^}]*}/, "Created nothing"),
    "an unparseable verdict payload": (text) => text.replace(/content=\{[^}]*\}/, "content=see above"),
    // The transcript is JSONL, so the message's inner JSON arrives escaped —
    // these mutations have to match `\"target\": \"spec\"` as written on disk.
    "a verdict for an unknown target": (text) =>
      text.replace(/\\"target\\": \\"spec\\"/, '\\"target\\": \\"vibes\\"'),
    "a verdict that is neither PASS nor FAIL": (text) =>
      text.replace(/\\"verdict\\": \\"PASS\\"/, '\\"verdict\\": \\"probably fine\\"'),
  };
  for (const [label, mutate] of Object.entries(cases)) {
    fs.rmSync(factcheckPath, { force: true });
    write({ sender: "ee2e6159-d766-4f04-8d7f-2825eada35fb", verdict: "PASS", target: "spec", step: 220, agent: "ultracode-fact-check" });
    fs.writeFileSync(transcriptPath, mutate(fs.readFileSync(transcriptPath, "utf-8")), "utf-8");
    assert.deepEqual(JSON.parse(run()), {}, label);
    assert.equal(fs.existsSync(factcheckPath), false, label);
  }

  // A spawn with no Repo key: records nothing — there is no path ultracode_gate
  // would resolve to either — and says so. AGY has no PreToolUse denial to catch
  // this at spawn time, so the injected message is the only warning there is.
  fs.rmSync(factcheckPath, { force: true });
  write({
    sender: "ee2e6159-d766-4f04-8d7f-2825eada35fb",
    verdict: "PASS",
    target: "spec",
    step: 260,
    agent: "ultracode-fact-check",
    repoKey: "",
  });
  const keyless = JSON.parse(run());
  assert.match(keyless.injectSteps[0].ephemeralMessage, /was NOT recorded/);
  assert.equal(fs.existsSync(factcheckPath), false);

  // The same hook also runs on PostToolUse, which accepts a bare {} only: AGY
  // rejects a response carrying injectSteps there as an unknown field and throws
  // the whole thing away.
  fs.rmSync(factcheckPath, { force: true });
  write({ sender: "ee2e6159-d766-4f04-8d7f-2825eada35fb", verdict: "PASS", target: "spec", step: 300, agent: "ultracode-fact-check" });
  const postTool = JSON.parse(
    runHook(
      hookPath,
      { conversationId: "testsess", workspacePaths: [repo], transcriptPath, stepIdx: 12 },
      env,
    ),
  );
  assert.deepEqual(postTool, {}, "PostToolUse output must carry no extra fields");
  assert.equal(JSON.parse(fs.readFileSync(factcheckPath, "utf-8")).spec.verdict, "PASS");

  // A missing or unreadable transcript is not an error, it is just no evidence.
  assert.deepEqual(
    JSON.parse(
      runHook(hookPath, { conversationId: "testsess", transcriptPath: "/nope/none.jsonl" }, env),
    ),
    {},
  );
  assert.deepEqual(JSON.parse(runHook(hookPath, { conversationId: "testsess" }, env)), {});
});

test("deny payload shape follows the generated target, not the ambient environment", () => {
  // AGY validates hook output against a proto and rejects unknown fields, so a
  // Claude-shaped denial is not merely ignored there — protojson throws
  // "unknown field hookSpecificOutput" and the guard fails open. This was
  // observed live: `agy` launched from inside a Claude Code turn inherits
  // CLAUDE_CODE_SESSION_ID, which flipped the old env sniffing to "not AGY" and
  // silently discarded every denial in that session.
  const nested = {
    CLAUDE_CODE_SESSION_ID: "outer-session",
    CLAUDE_PLUGIN_ROOT: CLAUDE_PLUGIN_ROOT,
    GROK_SESSION_ID: "outer-grok",
  };
  const denyOf = (target, env) =>
    JSON.parse(
      runHook(
        path.join(pluginRootFor(target), "hooks", "bash-guard.js"),
        { tool_input: { command: "sleep 5" } },
        env,
      ),
    );

  const agy = denyOf("antigravity", { ...nested, ANTIGRAVITY_PLUGIN_ROOT: ANTIGRAVITY_PLUGIN_ROOT });
  assert.equal(agy.decision, "deny");
  assert.equal(agy.hookSpecificOutput, undefined, "AGY must receive no unknown fields");
  assert.match(agy.reason, /Hard rule 19/);

  for (const target of ["claude", "codex", "grok"]) {
    const other = denyOf(target, {
      ANTIGRAVITY_PLUGIN_ROOT: ANTIGRAVITY_PLUGIN_ROOT,
      AGY_PLUGIN_ROOT: ANTIGRAVITY_PLUGIN_ROOT,
    });
    if (target === "grok") {
      assert.equal(other.decision, "deny", "grok: top-level decision even under AGY variables");
      assert.match(other.reason, /Hard rule 19/);
    } else {
      assert.equal(
        other.hookSpecificOutput.permissionDecision,
        "deny",
        `${target}: keeps its own shape even under AGY variables`,
      );
    }
  }
});

test("a placeholder like <ID> in command text is not read as a redirect", () => {
  const { extractWriteTargets } = require(
    path.join(CLAUDE_PLUGIN_ROOT, "hooks", "lib", "shell-paths.js"),
  );
  // Prose inside a command — a spawn prompt, an echoed instruction — routinely
  // contains <NAME>. Reading `...session-<ID>/factcheck.json` as a redirect
  // denied a command that wrote nothing at all.
  assert.deepEqual(
    extractWriteTargets("echo 'Session dir: /repo/.ultracode/session/ultracode-session-<ID>/factcheck.json'"),
    [],
  );
  assert.deepEqual(extractWriteTargets("agy -p 'replace <ID> then read /tmp/out.json'"), []);
  // Real redirects still register, including right after a closed placeholder.
  assert.deepEqual(extractWriteTargets("echo x > /repo/notes.json"), ["/repo/notes.json"]);
  assert.deepEqual(extractWriteTargets("echo '<ID>' > /repo/notes.json"), ["/repo/notes.json"]);
  assert.deepEqual(extractWriteTargets("cmd 2> /repo/err.log"), ["/repo/err.log"]);
});

test("a heredoc body handed to a data sink is content, not commands", () => {
  const { extractWriteTargets } = require(
    path.join(CLAUDE_PLUGIN_ROOT, "hooks", "lib", "shell-paths.js"),
  );
  // The recorded plan-agent denial: the phase file's markdown body contained
  // `<!-- AWS START --> ... <!-- AWS END -->`, which read as a redirect into
  // "..." while the real (dynamic) redirect target was skipped — so the only
  // extracted target was prose, and a legitimate session write was refused.
  assert.deepEqual(
    extractWriteTargets(
      'S=/repo/.ultracode/session/s1\ncat > "$S/plan-phase-1.md" <<\'EOF\'\n' +
        "the `<!-- AWS START --> ... <!-- AWS END -->` dependency group\nrm /etc/passwd\nEOF",
    ),
    [],
  );
  // A literal command-line redirect target stays visible; the body does not.
  assert.deepEqual(
    extractWriteTargets("cat > /sess/plan.md <<'EOF'\nprose --> ... arrows\nrm /repo/x\nEOF"),
    ["/sess/plan.md"],
  );
  // Commands after the terminator are scanned again, and `<<-` strips tabs.
  assert.deepEqual(
    extractWriteTargets("cat > /a.md <<'EOF'\nbody\nEOF\necho x > /b.md"),
    ["/a.md", "/b.md"],
  );
  assert.deepEqual(
    extractWriteTargets("cat > /a.md <<-EOF\n\tbody > ...\n\tEOF\nrm /c.md"),
    ["/a.md", "/c.md"],
  );
  // A body fed to a shell or interpreter EXECUTES, so those lines stay visible —
  // directly or downstream of a pipe.
  assert.deepEqual(extractWriteTargets("bash <<'EOF'\nrm /repo/src/App.ts\nEOF"), [
    "/repo/src/App.ts",
  ]);
  assert.deepEqual(extractWriteTargets("cat <<'EOF' | bash\necho x > /repo/hacked.ts\nEOF"), [
    "/repo/hacked.ts",
  ]);
  // A here-string is not a heredoc; following lines are still commands.
  assert.deepEqual(extractWriteTargets("grep x <<< 'EOF'\nrm /d.md"), ["/d.md"]);
  // Dot-only tokens are prose (`--> ...`), never a write target.
  assert.deepEqual(extractWriteTargets("echo 'a --> ... done'"), []);
});

// spawn-log.js opens a progress.json record when a spawn returns, which on AGY is
// before the agent has said anything — so every AGY spawn was logged as
// `status: "ok"` with an empty summary, including agents that handed back STUCK.
// hooks/session-resume.js reads that log after a compaction, so the one artifact
// meant to survive a compaction was the one that knew the least.
test("agy-message-record completes progress.json from the subagent's message", () => {
  const pluginRoot = ANTIGRAVITY_PLUGIN_ROOT;
  const runtimeDir = HARNESS_LAYOUT.layouts.antigravity.runtime_dir;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-agy-progress-"));
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const transcriptPath = path.join(repo, "transcript_full.jsonl");
  const progressPath = path.join(sessionDir, "progress.json");
  const env = { ANTIGRAVITY_PLUGIN_ROOT: pluginRoot };
  const hookPath = path.join(pluginRoot, "hooks", "agy-message-record.js");

  const transcript = (agent, sender, step, message) =>
    [
      {
        step_index: step - 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              Subagents: [
                {
                  Role: "Implementer",
                  TypeName: agent,
                  Prompt: `Repo root: ${repo}\nSession dir: ${sessionDir}\n`,
                },
              ],
            },
          },
        ],
      },
      {
        step_index: step - 1,
        source: "MODEL",
        type: "GENERIC",
        content: `Created the following subagents:\n{ "conversationId": "${sender}" }`,
      },
      {
        step_index: step,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-08-20T20:00:00Z sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${message}\n</SYSTEM_MESSAGE>`,
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
  const run = () =>
    runHook(
      hookPath,
      { conversationId: "testsess", workspacePaths: [repo], transcriptPath, invocationNum: 2 },
      env,
    );

  // The record spawn-log.js opened, exactly as it writes it on AGY today.
  fs.writeFileSync(
    progressPath,
    JSON.stringify({
      schemaVersion: 1,
      records: [{ ts: "2026-08-20T20:00:00.000Z", agent: "implement", phase: "phase-3", status: "ok", summary: "" }],
    }),
    "utf-8",
  );
  fs.writeFileSync(
    transcriptPath,
    transcript("ultracode-implement", "11111111-1111-1111-1111-111111111111", 20, "Implemented phase 3: added the tracker service.\nAll steps verified."),
    "utf-8",
  );
  run();
  let records = JSON.parse(fs.readFileSync(progressPath, "utf-8")).records;
  assert.equal(records.length, 1, "the waiting record is completed, not duplicated");
  assert.equal(records[0].summary, "Implemented phase 3: added the tracker service.");
  assert.equal(records[0].status, "ok");
  assert.equal(records[0].phase, "phase-3", "the record spawn-log wrote keeps its phase");
  assert.equal(records[0].messageStep, 20);

  // Re-firing on every invocation and every tool call must not duplicate or churn.
  run();
  assert.deepEqual(JSON.parse(fs.readFileSync(progressPath, "utf-8")).records, records);

  // A STUCK return is recorded as an escalation and surfaced to the orchestrator.
  fs.writeFileSync(
    progressPath,
    JSON.stringify({
      schemaVersion: 1,
      records: [{ ts: "2026-08-20T20:05:00.000Z", agent: "implement", phase: null, status: "ok", summary: "" }],
    }),
    "utf-8",
  );
  fs.writeFileSync(
    transcriptPath,
    transcript("ultracode-implement", "22222222-2222-2222-2222-222222222222", 40, "STUCK: the build fails on a dependency I cannot resolve from this phase."),
    "utf-8",
  );
  const stuck = JSON.parse(run());
  records = JSON.parse(fs.readFileSync(progressPath, "utf-8")).records;
  assert.equal(records[0].status, "stuck");
  assert.match(records[0].summary, /^STUCK: the build fails/);
  assert.ok(
    stuck.injectSteps.some((step) => /returned STUCK/.test(step.ephemeralMessage)),
    "an escalation must be said out loud, not just filed",
  );

  // A message with no record waiting is appended rather than dropped.
  fs.rmSync(progressPath);
  fs.writeFileSync(
    transcriptPath,
    transcript("ultracode-explore", "33333333-3333-3333-3333-333333333333", 60, "Wrote research.md and criteria.md."),
    "utf-8",
  );
  run();
  records = JSON.parse(fs.readFileSync(progressPath, "utf-8")).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].agent, "explore");
  assert.equal(records[0].summary, "Wrote research.md and criteria.md.");
});

// AGY names the shell command `CommandLine`, so hooks reading only `command` did
// nothing there: the whole build-streak feature — the failure counter, the lesson
// recall, and the gate that forces escalation at five — was inert on that harness.
// And its PostToolUse payload has no result at all: failure shows up as
// `error: "exit status 1"`, with the output only in the transcript.
test("build-streak counts AGY failures from CommandLine, error, and the transcript", () => {
  const pluginRoot = ANTIGRAVITY_PLUGIN_ROOT;
  const runtimeDir = HARNESS_LAYOUT.layouts.antigravity.runtime_dir;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-agy-streak-"));
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(repo, runtimeDir, "repo-profile.json"),
    JSON.stringify({ schemaVersion: 1, commands: { build: "./mvnw -q compile" } }),
    "utf-8",
  );
  const transcriptPath = path.join(repo, "transcript_full.jsonl");
  const statePath = path.join(sessionDir, "build-streak.json");
  const env = { ANTIGRAVITY_PLUGIN_ROOT: pluginRoot };
  const counter = path.join(pluginRoot, "hooks", "build-streak.js");
  const gate = path.join(pluginRoot, "hooks", "build-streak-gate.js");

  let step = 0;
  const post = (output, error) => {
    step += 2;
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ step_index: step, source: "MODEL", type: "GENERIC", content: output }) + "\n",
      "utf-8",
    );
    return runHook(
      counter,
      {
        cwd: repo,
        conversationId: "testsess",
        agent_type: "ultracode-implement",
        transcriptPath,
        stepIdx: step,
        ...(error ? { error } : {}),
        toolCall: { name: "run_command", args: { CommandLine: "./mvnw -q compile", Cwd: repo } },
      },
      env,
    );
  };
  const streak = () => JSON.parse(fs.readFileSync(statePath, "utf-8")).streaks.implement;

  const failure =
    "The command exited with code 1.\nOutput:\n[ERROR] /r/src/main/java/Foo.java:[11,2] cannot find symbol";
  post(failure, "exit status 1");
  assert.equal(streak().consecutiveFailures, 1, "a failure counts on AGY at all");
  assert.match(streak().lastSignature, /cannot find symbol/, "the diagnostic comes from the transcript");
  post(failure, "exit status 1");
  const warned = post(failure, "exit status 1");
  assert.equal(streak().consecutiveFailures, 3);

  // AGY's PostToolUse output accepts `{}` only, so the nudge is filed for the
  // gate to deliver instead of being dropped on the floor.
  assert.deepEqual(JSON.parse(warned || "{}"), {}, "AGY PostToolUse takes no extra fields");
  const warningPath = path.join(sessionDir, "build-streak-warning.json");
  const warning = JSON.parse(fs.readFileSync(warningPath, "utf-8"));
  assert.match(warning.warning, /3 consecutive failing build\/test commands/);
  assert.equal(warning.streak, 3);

  // A pass clears the streak, read from AGY's own wording with no error field.
  post("The command exited with code 0.\nOutput:\nBUILD SUCCESS", null);
  assert.equal(streak().consecutiveFailures, 0);

  // Five failures and the gate refuses the next build command — on AGY, in AGY's
  // payload shape and with AGY's deny shape.
  for (let i = 0; i < 5; i += 1) post(failure, "exit status 1");
  assert.equal(streak().consecutiveFailures, 5);
  const denied = JSON.parse(
    runHook(
      gate,
      {
        cwd: repo,
        conversationId: "testsess",
        agent_type: "ultracode-implement",
        toolCall: { name: "run_command", args: { CommandLine: "./mvnw -q compile", Cwd: repo } },
      },
      env,
    ),
  );
  assert.equal(denied.decision, "deny");
  assert.equal(denied.hookSpecificOutput, undefined);
  assert.match(denied.reason, /STUCK:/);
  // The nudge AGY could not deliver at three failures rides along with the block.
  assert.match(denied.reason, /consecutive failing build\/test commands/);
});

// Measured live: an AGY subagent's own hooks DO fire, but its payload carries no
// `agent_type` and its conversation id is not the pipeline's session id — so every
// per-agent hook was inert inside a subagent. The router stamps the identity into
// the spawn prompt, which AGY preserves as the subagent conversation's first step.
test("AGY spawns are stamped with the agent identity its own hooks read back", () => {
  const pluginRoot = ANTIGRAVITY_PLUGIN_ROOT;
  const runtimeDir = HARNESS_LAYOUT.layouts.antigravity.runtime_dir;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-agy-stamp-"));
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(repo, runtimeDir, "repo-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      commands: { build: "./mvnw -q compile" },
      models: { byAgent: {}, byPhaseComplexity: { implement: { low: "balanced" } } },
    }),
    "utf-8",
  );
  const env = { ANTIGRAVITY_PLUGIN_ROOT: pluginRoot };
  const prompt = `Repo root: ${repo}\nSession dir: ${sessionDir}\nNo plan: identity test.\n`;

  const routed = JSON.parse(
    runHook(
      path.join(pluginRoot, "hooks", "model-router.js"),
      {
        cwd: repo,
        conversationId: "testsess",
        toolCall: {
          name: "invoke_subagent",
          args: {
            Subagents: [
              { Role: "Implementer", TypeName: "ultracode-implement", Model: "inherit", Prompt: prompt },
            ],
          },
        },
      },
      env,
    ),
  );
  const stamped = routed.overwrite.Subagents[0].Prompt;
  assert.match(stamped, /^Ultracode agent: implement$/m);
  assert.ok(stamped.startsWith(prompt.trimEnd()) || stamped.includes("No plan: identity test."));

  // A subagent conversation's own transcript begins with that prompt, which is all
  // its hooks get: no agent_type, and a conversation id that is not the session id.
  const transcriptPath = path.join(repo, "subagent-transcript.jsonl");
  const write = (output) =>
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          content: `<USER_REQUEST>\n${stamped}</USER_REQUEST>`,
        }),
        JSON.stringify({ step_index: 3, source: "MODEL", type: "GENERIC", content: output }),
      ].join("\n"),
      "utf-8",
    );
  const post = () =>
    runHook(
      path.join(pluginRoot, "hooks", "build-streak.js"),
      {
        conversationId: "a-subagent-conversation-id",
        workspacePaths: [repo],
        transcriptPath,
        stepIdx: 3,
        error: "", // AGY leaves this empty even for a nonzero exit
        toolCall: { name: "run_command", args: { CommandLine: "./mvnw -q compile", Cwd: repo } },
      },
      env,
    );

  // AGY reports the exit status only in the transcript text, and only there.
  write("The command exited with code 127.\nOutput:\nbash: line 1: ./mvnw: No such file or directory");
  post();
  const streakPath = path.join(sessionDir, "build-streak.json");
  assert.ok(fs.existsSync(streakPath), "the streak is recorded in the session dir the spawn declared");
  assert.equal(JSON.parse(fs.readFileSync(streakPath, "utf-8")).streaks.implement.consecutiveFailures, 1);

  // An unstamped prompt (a spawn the router never saw) stays inert rather than
  // guessing an agent.
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: prompt }),
      JSON.stringify({ step_index: 3, source: "MODEL", type: "GENERIC", content: "The command exited with code 1." }),
    ].join("\n"),
    "utf-8",
  );
  fs.rmSync(streakPath);
  post();
  assert.equal(fs.existsSync(streakPath), false, "no identity means no attribution");
});

test("gates.json and the memory store are tool-owned ledgers", () => {
  const { checkLedger, ledgerNamePattern } = require(
    path.join(CLAUDE_PLUGIN_ROOT, "hooks", "lib", "ledger-policy.js"),
  );
  // Before this, gates.json — the file hooks/pipeline-gate.js reads to decide
  // whether ultracode:plan may be spawned — was protected by nothing: only
  // mcp/lib/gate.js ever wrote it, so a plain `>` redirect could approve a spec
  // that no fact-check had passed.
  for (const writer of ["", "fact-check", "implement", "code-reviewer"]) {
    const gates = checkLedger(writer, "/repo/.ultracode/session/x/gates.json");
    assert.equal(gates.allowed, false, writer || "orchestrator");
    assert.match(gates.reason, /ultracode_gate MCP tool/);
    assert.equal(
      checkLedger(writer, "/repo/.ultracode/memory/knowledge.sqlite3").allowed,
      false,
      writer || "orchestrator",
    );
  }
  assert.equal(checkLedger("", "/repo/.ultracode/session/x/report.md").allowed, true);

  // The free-text pattern plugin-policy.js scans inline code with must cover
  // every class, and must not match an ordinary artifact name.
  for (const name of [
    "factcheck.json",
    "gates.json",
    "build-streak.json",
    "spawn-scope.json",
    "progress.json",
    "knowledge.sqlite3",
    "ultracode-review-ledger.md",
    "ultracode-security-block.json",
  ]) {
    assert.match(name, ledgerNamePattern(), name);
  }
  assert.doesNotMatch("ultracode-spec-2026-01-01-topic.md", ledgerNamePattern());
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
  const denied = JSON.parse(pre("./mvnw -q -T1C compile"));
  assertDenied(denied, /5 consecutive build\/test failures/);
  assert.match(denyReason(denied), /STUCK: /);
  // A test command is the same loop and is refused too, but reading is not.
  assertDenied(
    JSON.parse(pre("./mvnw test -Ptest -pl core -am -Dtest=FooTest")),
    /consecutive build\/test failures|STUCK:/,
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
    `Repo root: ${repo}\nSession dir: ${sessionDir}\nRepo key: backend\nNo plan: demo.\nReport file: ${reportPath}`,
  );
  const recorded = JSON.parse(
    fs.readFileSync(path.join(sessionDir, "spawn-scope.json"), "utf-8"),
  ).scopes.implement.backend;
  assert.equal(recorded.reportFile, reportPath);

  const written = writeReport(sessionDir, "ultracode:implement", "# Change Report\nDid the thing.");
  assert.equal(written.ok, true);
  assert.equal(written.path, reportPath);
  assert.match(fs.readFileSync(reportPath, "utf-8"), /Did the thing/);
  assert.equal(writeReport(sessionDir, "ultracode:implement", "   ").ok, false, `${target}: empty refused`);

  // The declared path is orchestrator-supplied but the tool writes with the MCP
  // server's own privileges, so it is confined to the session dir regardless.
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, "spawn-scope.json"), "utf-8"));
  state.scopes.implement.backend.reportFile = path.join(os.tmpdir(), "ultracode-escape.md");
  fs.writeFileSync(path.join(sessionDir, "spawn-scope.json"), JSON.stringify(state), "utf-8");
  const escaped = writeReport(sessionDir, "ultracode:implement", "x");
  assert.equal(escaped.ok, false);
  assert.match(escaped.message, /outside the session dir/);
  state.scopes.implement.backend.reportFile = reportPath;
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

// A report is often the largest payload a spawn emits, and one stalled write call
// used to strand the whole spawn behind ultracode_report. So the constraint is the
// declared path, not the tool that writes it: any mechanism may produce the report
// as long as it lands exactly where the orchestrator said, with the same lesson
// gate the tool applies. An invented sibling name stays refused — that is the
// failure the declared path exists to prevent.
function handWrittenReportTest(target) {
  const { pluginRoot, runtimeDir, sessionId, repo, sessionDir, env } = scopeGuardFixture(
    target,
    "ultracode-handreport",
  );
  fs.writeFileSync(
    path.join(repo, runtimeDir, "repo-profile.json"),
    JSON.stringify({ commands: { build: "./mvnw compile" } }),
    "utf-8",
  );
  const agy = target === "antigravity";
  const reportPath = path.join(sessionDir, "ultracode-implement-phase-3.md");
  const base = agy
    ? { cwd: repo, conversationId: sessionId }
    : { cwd: repo, session_id: sessionId, sessionId };
  const hook = (name) => path.join(pluginRoot, "hooks", name);
  const reasonOf = (out) => (out.trim() ? denyReason(JSON.parse(out)) : null);
  const agent = (name) => (agy ? name.replace("ultracode:", "ultracode-") : name);

  // Each harness names the same three things differently: the spawn envelope, the
  // write target, and the shell command. Every rule below is asserted through the
  // shape its own harness actually sends.
  const spawnPayload = (prompt) =>
    agy
      ? {
          ...base,
          toolCall: {
            name: "invoke_subagent",
            args: { Subagents: [{ TypeName: "ultracode-implement", Prompt: prompt }] },
          },
        }
      : { ...base, tool_input: { subagent_type: "ultracode:implement", prompt } };
  const writePayload = (filePath, actor) =>
    agy
      ? { ...base, agent_type: actor, toolCall: { name: "write_to_file", args: { TargetFile: filePath } } }
      : { ...base, agent_type: actor, tool_input: { file_path: filePath } };
  const bashPayload = (command, actor) =>
    agy
      ? {
          ...base,
          agent_type: actor,
          toolCall: { name: "run_command", args: { CommandLine: command, Cwd: repo } },
        }
      : { ...base, agent_type: actor, tool_input: { command } };

  runHook(
    hook("spawn-scope.js"),
    spawnPayload(
      `Repo root: ${repo}\nSession dir: ${sessionDir}\nRepo key: backend\nNo plan: demo.\n` +
        `Report file: ${reportPath}`,
    ),
    env,
  );

  const write = (filePath, actor = "ultracode:implement") =>
    reasonOf(runHook(hook("scope-guard.js"), writePayload(filePath, agent(actor)), env));
  const bash = (command, actor = "ultracode:implement") =>
    reasonOf(runHook(hook("bash-scope-guard.js"), bashPayload(command, agent(actor)), env));

  // The declared path is writable by whichever mechanism the agent reaches for.
  assert.equal(write(reportPath), null, `${target}: write tool may author the declared report`);
  assert.equal(
    bash(`cat > "${reportPath}" <<'REPORT_EOF'\n# Implementation Report\nDid the thing.\nREPORT_EOF`),
    null,
    `${target}: a heredoc may author the declared report`,
  );
  assert.equal(
    bash(`echo "## More" >> ${reportPath}`),
    null,
    `${target}: a long report may be appended in parts`,
  );

  // A name the agent invented is not, whichever mechanism writes it.
  const invented = path.join(sessionDir, "ultracode-implement-credentials-uri.md");
  const declaredPat = pickPattern(target, /declared for this spawn/, /declared report path/);
  assert.match(write(invented), declaredPat, `${target}: invented name refused (write)`);
  assert.match(bash(`echo x > ${invented}`), declaredPat, `${target}: invented name refused (shell)`);
  // Nor is the right basename in the wrong repo-key subdirectory: the next stage
  // reads the declared path, directory included.
  assert.match(
    write(path.join(sessionDir, "frontend", "ultracode-implement-phase-3.md")),
    declaredPat,
    `${target}: the declared directory is part of the path`,
  );

  // Its own ledgers keep their own ownership rules, and non-artifact scratch is
  // untouched by this policy.
  assert.equal(write(path.join(sessionDir, "ultracode-implement-progress.md")), null);
  assert.equal(write(path.join(sessionDir, "notes.txt")), null);
  // Another agent's ledger is still ledger-policy's call, not this one's.
  assert.match(
    bash(`echo x > ${path.join(sessionDir, "ultracode-security-block.json")}`),
    pickPattern(target, /owned by ultracode:code-reviewer/, /Re-spawn the owning agent/),
    `${target}: ledger ownership still outranks the report path`,
  );

  // A second repo key's spawn in the same session declares its own report path.
  // Both are accepted: a leaf tool call whose `Repo key:` did not survive the
  // payload must not have its own report read as another repo's invented name.
  const frontendReport = path.join(sessionDir, "frontend", "ultracode-implement-phase-4.md");
  runHook(
    hook("spawn-scope.js"),
    spawnPayload(
      `Repo root: ${repo}\nSession dir: ${path.join(sessionDir, "frontend")}\nRepo key: frontend\n` +
        `No plan: demo.\nReport file: ${frontendReport}`,
    ),
    env,
  );
  assert.equal(write(frontendReport), null, `${target}: a sibling repo key's declared report is accepted`);
  assert.equal(write(reportPath), null, `${target}: and so is this spawn's own`);

  // The lesson gate applies to a hand-written report exactly as it does to the tool.
  // AGY's PostToolUse payload carries no tool result at all, so its build outcome
  // is read from `error` plus the transcript — the streak has to be driven in that
  // shape for the gate to be exercised there rather than assumed.
  const transcriptPath = path.join(repo, "transcript_full.jsonl");
  let step = 0;
  const build = (output, failed) => {
    if (!agy) {
      return runHook(hook("build-streak.js"), {
        ...base,
        agent_type: "ultracode:implement",
        tool_name: "Bash",
        tool_input: { command: "./mvnw compile" },
        tool_response: { result: output, stdout: output, stderr: "", interrupted: false },
      }, env);
    }
    step += 2;
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ step_index: step, source: "MODEL", type: "GENERIC", content: output })}\n`,
      "utf-8",
    );
    return runHook(hook("build-streak.js"), {
      ...base,
      agent_type: "ultracode-implement",
      transcriptPath,
      stepIdx: step,
      ...(failed ? { error: "exit status 1" } : {}),
      toolCall: { name: "run_command", args: { CommandLine: "./mvnw compile", Cwd: repo } },
    }, env);
  };
  const failure = agy
    ? "The command exited with code 1.\nOutput:\n[ERROR] /r/Foo.java:[11,2] cannot find symbol"
    : "Exit code 1\n[ERROR] /r/Foo.java:[11,2] cannot find symbol";
  for (let i = 0; i < 3; i += 1) build(failure, true);
  build(agy ? "The command exited with code 0.\nOutput:\nBUILD SUCCESS" : "BUILD SUCCESS", false);
  const gated = write(reportPath);
  assert.match(gated, /cannot find symbol/, `${target}: unrecorded recovery blocks a hand-written report`);
  assert.match(gated, /ultracode_memory/);
  assert.match(gated, /unrecorded_lesson_reason/, `${target}: the override channel is named`);
  assert.match(bash(`cat > "${reportPath}" <<'EOF'\nx\nEOF`), /cannot find symbol/);

  const { markLessonsRecorded } = require(path.join(pluginRoot, "hooks", "lib", "report-policy.js"));
  assert.equal(markLessonsRecorded(sessionDir, "implement"), 1);
  assert.equal(write(reportPath), null, `${target}: recording the lesson unblocks the hand-written report`);

  // An agent whose report path the orchestrator never declared is unaffected: its
  // prompt tells it to ask for one, and denying here would strand it over the
  // orchestrator's omission.
  fs.rmSync(path.join(sessionDir, "spawn-scope.json"));
  runHook(
    hook("spawn-scope.js"),
    spawnPayload(`Repo root: ${repo}\nSession dir: ${sessionDir}\nRepo key: backend\nNo plan: tiny fix.`),
    env,
  );
  assert.equal(write(invented), null, `${target}: no declared path, no constraint to enforce`);
  // And an agent that names its own artifacts (explore) is never held to one.
  assert.equal(
    write(path.join(sessionDir, "ultracode-research-20260826-auth.md"), "ultracode:explore"),
    null,
  );
}

// One test per harness rather than one loop over four: each is independently
// selectable with --test-name-pattern, so the four can be run as four processes
// in parallel, and a failure names the harness in the test title.
for (const harness of ["claude", "codex", "grok", "antigravity"]) {
  test(`a report may be written by any tool, but only at the declared path (${harness})`, () => {
    handWrittenReportTest(harness);
  });
}

// A Write/Edit inside a subagent's turn carries no spawn prompt, so work-repo
// identity and the phase path hint are captured at spawn time (spawn-scope.js).
// The path list is recorded for observability; it is not a write allowlist —
// skill-required companions the plan omitted must remain writable under the
// work repo. Hard boundaries stay: session reports, work-repo root, test paths.
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
  const reasonOf = (out) => (out.trim() ? denyReason(JSON.parse(out)) : null);

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

  // Recording the phase path hint; writes are not confined to that set.
  runHook(hook("spawn-scope.js"), {
    ...base,
    tool_input: {
      subagent_type: "ultracode:implement",
      prompt: `Repo root: ${repo}\nSession dir: ${sessionDir}\nRepo key: backend\nPhase file: ${phaseFile}`,
    },
  }, env);
  const recorded = JSON.parse(
    fs.readFileSync(path.join(sessionDir, "spawn-scope.json"), "utf-8"),
  ).scopes.implement.backend;
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
  // A sibling the plan omitted stays writable — skill-driven companions are in scope.
  assert.equal(write(path.join(repo, "core/src/main/java/com/example/order/OrderStatus.java")), null);
  // Another module under the same work repo is also writable; the phase list is a hint.
  assert.equal(
    write(path.join(repo, "billing/src/main/java/com/example/billing/Invoice.java")),
    null,
    `${target}: phase path list does not block other work-repo paths`,
  );
  // Its own session report stays writable.
  assert.equal(write(path.join(sessionDir, "ultracode-implement-phase-3.md")), null);

  // Shell writes follow the same root rules, not the phase path list.
  const bash = (command) =>
    reasonOf(
      runHook(hook("bash-scope-guard.js"), {
        ...base,
        agent_type: "ultracode:implement",
        tool_input: { command },
      }, env),
    );
  assert.equal(bash(`echo x > ${repo}/core/src/main/java/com/example/order/Foo.java`), null);
  assert.equal(bash(`echo x > ${repo}/billing/src/Evil.java`), null);

  // No phase file = nothing to record as a hint; work-repo writes still succeed.
  fs.rmSync(path.join(sessionDir, "spawn-scope.json"));
  runHook(hook("spawn-scope.js"), {
    ...base,
    tool_input: {
      subagent_type: "ultracode:implement",
      prompt: `Repo root: ${repo}\nSession dir: ${sessionDir}\nRepo key: backend\nNo plan: tiny fix.`,
    },
  }, env);
  assert.equal(write(path.join(repo, "billing/src/main/java/com/example/billing/Invoice.java")), null);

  // And Constraint 6 still outranks all of it.
  assert.match(
    write(path.join(repo, "core/src/test/java/com/example/order/OrderServiceTest.java")),
    pickPattern(target, /test file/, /refusing to let ultracode:implement write/),
    `${target}: implement still cannot write tests`,
  );
}

test("spawn-scope records phase path hints without confining work-repo writes", () => {
  phaseScopeTest("claude");
  phaseScopeTest("codex");
  phaseScopeTest("grok");
});

// Cross-repo implement safeguards two roots: reports under the primary session
// dir, code under the work-repo checkout named by Repo root: / spawn-scope.
function crossRepoScopeTest(target) {
  const { pluginRoot, runtimeDir, sessionId, repo: primary, sessionDir, env } = scopeGuardFixture(
    target,
    "ultracode-crossrepo",
  );
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `ultracode-crossrepo-work-${target}-`));
  fs.mkdirSync(path.join(work, "src", "pallet_ai_lambda", "registry"), { recursive: true });
  fs.mkdirSync(path.join(work, runtimeDir), { recursive: true });
  fs.mkdirSync(path.join(primary, "src"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "backend"), { recursive: true });
  fs.writeFileSync(
    path.join(primary, runtimeDir, "repo-profile.json"),
    JSON.stringify({ commands: { build: "./mvnw compile" } }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(work, runtimeDir, "repo-profile.json"),
    JSON.stringify({ commands: { build: "uv sync" } }),
    "utf-8",
  );

  const phaseFile = path.join(sessionDir, "ultracode-phase-6-livestream-moderation-prompt.md");
  fs.writeFileSync(
    phaseFile,
    [
      "# Phase 6 — livestream moderation prompt",
      "Modify `src/pallet_ai_lambda/registry/prompt_const.py`.",
      "Modify `src/pallet_ai_lambda/registry/user_prompts.py`.",
    ].join("\n\n"),
    "utf-8",
  );
  const workSessionDir = path.join(sessionDir, "ai-lambda");
  fs.mkdirSync(workSessionDir, { recursive: true });

  const base = { cwd: primary, session_id: sessionId, sessionId };
  const hook = (name) => path.join(pluginRoot, "hooks", name);
  const reasonOf = (out) => (out.trim() ? denyReason(JSON.parse(out)) : null);

  // Record BOTH a primary-repo phase and the secondary-repo phase so a blank
  // actor.repoKey used to latch onto the wrong declared file set.
  const backendPhase = path.join(sessionDir, "ultracode-phase-1-backend.md");
  fs.writeFileSync(
    backendPhase,
    "# Phase 1\n\nModify `src/App.java`.\n",
    "utf-8",
  );
  runHook(
    hook("spawn-scope.js"),
    {
      ...base,
      tool_input: {
        subagent_type: "ultracode:implement",
        prompt: `Primary repo root: ${primary}\nRepo root: ${primary}\nSession dir: ${sessionDir}/backend\nRepo key: backend\nPhase file: ${backendPhase}`,
      },
    },
    env,
  );
  runHook(
    hook("spawn-scope.js"),
    {
      ...base,
      tool_input: {
        subagent_type: "ultracode:implement",
        prompt: `Primary repo root: ${primary}\nRepo root: ${work}\nSession dir: ${workSessionDir}\nRepo key: ai-lambda\nPhase file: ${phaseFile}`,
      },
    },
    env,
  );

  const write = (filePath, extra = {}) =>
    reasonOf(
      runHook(
        hook("scope-guard.js"),
        {
          ...base,
          agent_type: "ultracode:implement",
          tool_input: { file_path: filePath },
          ...extra,
        },
        env,
      ),
    );
  const bash = (command, extra = {}) =>
    reasonOf(
      runHook(
        hook("bash-scope-guard.js"),
        {
          ...base,
          agent_type: "ultracode:implement",
          tool_input: { command },
          ...extra,
        },
        env,
      ),
    );

  // Absolute work-repo path: pick the ai-lambda spawn-scope by target, even when
  // the harness payload only knows the primary cwd/agent_type.
  assert.equal(write(path.join(work, "src/pallet_ai_lambda/registry/prompt_const.py")), null);
  assert.equal(write(path.join(workSessionDir, "ultracode-implement-phase-6.md")), null);
  // Phase path list is a hint — undeclared paths under the work repo stay writable.
  assert.equal(write(path.join(work, "src", "other.py")), null);
  assert.equal(bash(`echo x > ${path.join(work, "src/pallet_ai_lambda/registry/user_prompts.py")}`), null);
  // A primary absolute path with no actor repoKey still binds to the primary
  // spawn-scope record that owns that checkout; phase hints do not deny it.
  assert.equal(bash(`echo x > ${path.join(primary, "src", "Evil.java")}`), null);

  // Claude leaf transcripts carry Repo root / Session dir / Repo key on the first
  // user turn; currentActor must prefer those over the primary cwd so a secondary
  // spawn cannot fall through into the primary work-repo root.
  const transcriptPath = path.join(sessionDir, "agent-ai-lambda.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Primary repo root: ${primary}\n` +
              `Repo root: ${work}\n` +
              `Session dir: ${workSessionDir}\n` +
              `Repo key: ai-lambda\n` +
              "Implement phase 6.\n",
          },
        ],
      },
    })}\n`,
    "utf-8",
  );
  assert.equal(
    write(path.join(work, "src/pallet_ai_lambda/registry/prompt_const.py"), {
      transcript_path: transcriptPath,
    }),
    null,
  );
  assert.equal(
    write(path.join(workSessionDir, "ultracode-implement-progress.md"), {
      transcript_path: transcriptPath,
    }),
    null,
  );
  assert.match(
    write(path.join(primary, "src", "App.java"), { transcript_path: transcriptPath }),
    /outside the repo root/,
  );
  assert.match(
    bash(`echo x > ${path.join(primary, "src", "App.java")}`, { transcript_path: transcriptPath }),
    /outside the repo root/,
  );
}

test("scope-guard allows primary session reports and secondary work-repo code", () => {
  crossRepoScopeTest("claude");
  crossRepoScopeTest("codex");
  crossRepoScopeTest("grok");
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
    assertDenied(JSON.parse(run(filePath, agentType)), pattern, `${agentType}: ${filePath}`);
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
    deny(
      path.join(repo, "src", "App.ts"),
      `ultracode:${agent}`,
      pickPattern(target, /never modifies project source/, /outside its session directory/),
    );
  }

  // initializer: session dir, skills dir, runtime dir — nothing else.
  allow(path.join(repo, skillsDir, "convention", "SKILL.md"), "ultracode:initializer");
  allow(path.join(repo, runtimeDir, "INVENTORY.md"), "ultracode:initializer");
  deny(path.join(repo, "src", "App.ts"), "ultracode:initializer", /allowed scope/);

  // module-documentation: session dir plus module-hub/references only — not the rest of skills_dir.
  allow(path.join(repo, skillsDir, "module-hub", "references", "auth.md"), "ultracode:module-documentation");
  deny(
    path.join(repo, skillsDir, "convention", "SKILL.md"),
    "ultracode:module-documentation",
    pickPattern(target, /allowed scope/, /outside its allowed/),
  );
  deny(path.join(repo, "src", "App.ts"), "ultracode:module-documentation", /allowed scope/);

  // implement: anywhere in the repo root, except a path that looks like a test (Constraint 6).
  allow(path.join(repo, "src", "App.ts"), "ultracode:implement");
  deny(
    path.join(repo, "src", "App.test.ts"),
    "ultracode:implement",
    pickPattern(target, /Constraint 6/, /a test file\/directory path/),
  );

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
  // ...even when the heredoc body contains markdown prose that parses like a
  // redirect (`--> ...`) or names shell commands — the body is file content.
  assert.equal(
    run(
      `cat > ${path.join(sessionDir, "plan-phase-1.md")} <<'EOF'\n` +
        "the `<!-- AWS START --> ... <!-- AWS END -->` group\nrm -rf /somewhere\nEOF",
      "ultracode:plan",
    ),
    "",
    `${target}: heredoc body prose is not read as a write target`,
  );
  // OS-temp scratch outside every governed root is fine for session-only agents...
  assert.equal(
    run("sort spec.md > /tmp/ultracode-test-got.txt", "ultracode:generate-spec"),
    "",
    `${target}: session-only agents may write temp scratch`,
  );
  // ...but repo-writing agents keep strict confinement, temp included.
  assertDenied(
    JSON.parse(run("echo x > /tmp/ultracode-test-scratch.log", "ultracode:implement")),
    /outside the repo root/,
  );
  // ...but writing project source through Bash instead of Write/Edit is still denied.
  assertDenied(
    JSON.parse(run(`echo bad > ${path.join(repo, "src", "App.ts")}`, "ultracode:code-reviewer")),
    /never modifies project source/,
  );

  // implement cannot write a test file through a Bash heredoc either.
  assertDenied(
    JSON.parse(
      run(`cat <<'EOF' > ${path.join(repo, "src", "App.test.ts")}\nhi\nEOF`, "ultracode:implement"),
    ),
    /Constraint 6/,
  );

  // Any subagent deleting outside the repo root is denied.
  assertDenied(
    JSON.parse(run(`rm -rf ${path.join(repo, "..", "sibling")}`, "ultracode:write-test")),
    /outside the repo root/,
  );

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
  const run = (agent, extraPromptLines = "", spawnDir = sessionDir) =>
    runHook(
      hookPath,
      {
        cwd: repo,
        session_id: "testsess",
        tool_input: {
          subagent_type: `ultracode:${agent}`,
          prompt: `Repo root: ${repo}.\nSession dir: ${spawnDir}.\nRepo key: backend.${extraPromptLines}`,
        },
      },
      { PLUGIN_ROOT: pluginRoot },
    );

  const planDenied = JSON.parse(run("plan"));
  assertDenied(planDenied, /spec has not been recorded as approved/);
  // The hint quotes this spawn's own repo key, so it is a call to issue as-is.
  assert.match(denyReason(planDenied), /repo_key: "backend"/);

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
  assertDenied(JSON.parse(run("implement")), /without a plan/);
  assert.equal(run("implement", "\nNo plan: one-line typo fix."), "");

  const phaseLine = `\nPhase file: ${path.join(sessionDir, "phase-1.md")}.`;
  assertDenied(JSON.parse(run("implement", phaseLine)), /plan has not been recorded as approved/);

  fs.writeFileSync(
    path.join(sessionDir, "gates.json"),
    JSON.stringify({ spec: { decision: "approved" }, plan: { decision: "approved" } }),
    "utf-8",
  );
  assert.equal(run("implement", phaseLine), "");

  // The approval is session-level, so a phase spawn scoped to its repo's own
  // subdirectory reads the same one. Resolving gates.json relative to whichever
  // session dir the prompt declared is what refused every per-repo phase spawn
  // for a plan the user had approved.
  const repoSubdir = path.join(sessionDir, "backend");
  fs.mkdirSync(repoSubdir, { recursive: true });
  assert.equal(run("implement", phaseLine, repoSubdir), "");
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
  assertDenied(
    JSON.parse(run("code-reviewer", `${base}\nThe user says skip the security scan for this pass.`)),
    /cannot be waived/,
  );

  // An unresolved BLOCKER finding denies the final module-documentation stage.
  fs.writeFileSync(
    path.join(sessionDir, "ultracode-security-block.json"),
    JSON.stringify({ blocked: true, iteration: 1, findings: ["[BLOCKER] src/x.ts (SEC-BLOCK-EXFIL) - ..."] }),
    "utf-8",
  );
  assertDenied(JSON.parse(run("module-documentation", base)), /unresolved BLOCKER security finding/);

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
    assert.ok(fs.statSync(path.join(root, "mcp", "hub-shim.js")).isFile());
    assert.ok(fs.statSync(path.join(root, "mcp", "hub-server.js")).isFile());
    assert.ok(fs.statSync(path.join(root, "mcp", "hub-ctl.js")).isFile());
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
        args: [`\${${envVar}}/mcp/hub-shim.js`],
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
  const prompt = `Repo root: ${repo}.\nSession dir: ${sessionDir}.\nRepo key: backend.`;
  const statePath = path.join(sessionDir, "backend", "factcheck.json");
  const record = (verdict, findings = [], promptText = prompt) =>
    runHook(
      path.join(pluginRoot, "hooks", "factcheck-record.js"),
      {
        cwd: repo,
        session_id: "testsess",
        tool_input: { subagent_type: "ultracode:fact-check", prompt: promptText },
        tool_response: JSON.stringify({ verdict, target: "spec", findings }),
      },
      { PLUGIN_ROOT: pluginRoot },
    );

  record("FAIL", [{ severity: "HIGH", location: "x", claim: "y", issue: "z" }]);
  record("PASS");

  const factcheck = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  assert.equal(factcheck.spec.verdict, "PASS");
  assert.equal(factcheck.spec.rounds, 2);
  assert.equal(factcheck.spec.repo, "backend");
  assert.deepEqual(factcheck.spec.findings, []);

  // Claude Task/Agent PostToolUse can surface the leaf return as a content-block
  // array rather than a bare string; extract that the same way as a string body.
  runHook(
    path.join(pluginRoot, "hooks", "factcheck-record.js"),
    {
      cwd: repo,
      session_id: "testsess",
      tool_input: { subagent_type: "ultracode:fact-check", prompt },
      tool_response: {
        content: [
          { type: "text", text: JSON.stringify({ verdict: "PASS", target: "spec", findings: [] }) },
          { type: "text", text: "agentId: abc (use SendMessage ...)" },
        ],
      },
    },
    { PLUGIN_ROOT: pluginRoot },
  );
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf-8")).spec.rounds, 3);

  // The verdict is addressed by (session dir, repo key), so a spawn scoped to the
  // repo subdir records into the same file the ultracode_gate call reads when it
  // passes the session root plus that key — the mismatch that used to strand a
  // real PASS where the gate never looked.
  record("PASS", [], `Repo root: ${repo}.\nSession dir: ${path.join(sessionDir, "backend")}.\nRepo key: backend.\nTask: inspect repository.`);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf-8")).spec.rounds, 4);

  // No repo key: nothing is recorded anywhere, and the orchestrator is told so
  // rather than left to discover it at a gate that reports "none recorded".
  const keyless = runHook(
    path.join(pluginRoot, "hooks", "factcheck-record.js"),
    {
      cwd: repo,
      session_id: "testsess",
      tool_input: {
        subagent_type: "ultracode:fact-check",
        prompt: `Repo root: ${repo}.\nSession dir: ${sessionDir}.`,
      },
      tool_response: JSON.stringify({ verdict: "PASS", target: "plan" }),
    },
    { PLUGIN_ROOT: pluginRoot },
  );
  assert.match(JSON.parse(keyless).hookSpecificOutput.additionalContext, /no valid `Repo key:` line/);
  assert.equal(fs.existsSync(path.join(sessionDir, "factcheck.json")), false);
  assert.ok(!JSON.parse(fs.readFileSync(statePath, "utf-8")).plan);

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
  const unchanged = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  assert.ok(!unchanged.plan);
}

test("factcheck-record captures fact-check verdicts under the spawn's repo key", () => {
  factcheckRecordTest("claude");
  factcheckRecordTest("codex");
  factcheckRecordTest("grok");
});

test("factcheck-record records Claude SubagentStop verdicts from last_assistant_message", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-fcrecord-subagent-stop-"));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts.claude.runtime_dir;
  const pluginRoot = pluginRootFor("claude");
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const prompt =
    `Primary repo root: ${repo}\n` +
    `Repo root: ${repo}\n` +
    `Session dir: ${path.join(sessionDir, "backend")}\n` +
    "Repo key: backend\n" +
    "Target type: spec";
  const agentTranscript = path.join(tempDir, "agent-factcheck.jsonl");
  fs.writeFileSync(
    agentTranscript,
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
    })}\n`,
    "utf-8",
  );
  const statePath = path.join(sessionDir, "backend", "factcheck.json");

  // Async Agent PostToolUse only sees the launch ack — must not invent a verdict.
  runHook(
    path.join(pluginRoot, "hooks", "factcheck-record.js"),
    {
      cwd: repo,
      session_id: "testsess",
      hook_event_name: "PostToolUse",
      tool_input: { subagent_type: "ultracode:fact-check", prompt },
      tool_response: {
        content: [
          {
            type: "text",
            text: "Async agent launched successfully. agentId: deadbeef (internal ID)",
          },
        ],
      },
    },
    { PLUGIN_ROOT: pluginRoot },
  );
  assert.equal(fs.existsSync(statePath), false);

  runHook(
    path.join(pluginRoot, "hooks", "factcheck-record.js"),
    {
      cwd: repo,
      session_id: "testsess",
      hook_event_name: "SubagentStop",
      agent_id: "deadbeef",
      agent_type: "ultracode:fact-check",
      agent_transcript_path: agentTranscript,
      last_assistant_message: JSON.stringify({
        verdict: "PASS",
        target: "spec",
        repo: "backend",
        findings: [],
      }),
    },
    { PLUGIN_ROOT: pluginRoot },
  );

  const factcheck = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  assert.equal(factcheck.spec.verdict, "PASS");
  assert.equal(factcheck.spec.rounds, 1);
  assert.equal(factcheck.spec.repo, "backend");
  assert.equal(factcheck.spec.source, "subagent-stop");
  assert.equal(factcheck.spec.agentId, "deadbeef");

  const hooks = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf-8"),
  );
  const subagentStop = hooks.hooks.SubagentStop || [];
  assert.ok(
    subagentStop.some(
      (entry) =>
        entry.matcher === "^ultracode:fact-check$" &&
        (entry.hooks || []).some((hook) => /factcheck-record\.js/.test(hook.command)),
    ),
    "Claude hooks.json must register factcheck-record on SubagentStop",
  );
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

  // A code-reviewer spawn names its loop with `Phase:` rather than a phase file,
  // so the record comes from that value — including the test loop, which has no
  // phase-{N} path anywhere in its prompt to read.
  runHook(
    path.join(pluginRoot, "hooks", "spawn-log.js"),
    {
      cwd: repo,
      session_id: "testsess",
      tool_input: {
        subagent_type: "ultracode:code-reviewer",
        prompt: `Repo root: ${repo}.\nSession dir: ${sessionDir}.\nPhase: 2-tests.`,
      },
      tool_response: "Code review passed",
    },
    { PLUGIN_ROOT: pluginRoot },
  );
  const withReview = JSON.parse(fs.readFileSync(path.join(sessionDir, "progress.json"), "utf-8"));
  assert.equal(withReview.records[1].agent, "code-reviewer");
  assert.equal(withReview.records[1].phase, "phase-2-tests");

  // Each review loop's ledger is reported on its own line, against its own cap.
  fs.writeFileSync(
    path.join(sessionDir, "ultracode-review-ledger-phase-2.md"),
    "## Iteration 1\n## Iteration 2\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(sessionDir, "ultracode-review-ledger-phase-2-tests.md"),
    "## Iteration 1\n",
    "utf-8",
  );

  // Grok has no Observe stdout channel, so its checkpoint is delivered as
  // PreToolUse additionalContext after a PreCompact marker (lib/grok-hooks.js
  // fact 3); everywhere else it is the hook's plain stdout.
  let resumeOutput;
  if (target === "grok") {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-progress-home-"));
    const env = { PLUGIN_ROOT: pluginRoot, ULTRACODE_HUB_HOME: home };
    runHook(
      path.join(pluginRoot, "hooks", "session-resume.js"),
      { cwd: repo, session_id: "testsess", hook_event_name: "pre_compact", source: "auto" },
      env,
    );
    const injected = JSON.parse(
      runHook(
        path.join(pluginRoot, "hooks", "session-resume.js"),
        {
          cwd: repo,
          session_id: "testsess",
          hook_event_name: "pre_tool_use",
          toolName: "read_file",
          toolInput: { file_path: "README.md" },
        },
        env,
      ),
    );
    assert.equal(injected.hookSpecificOutput.permissionDecision, "allow");
    resumeOutput = injected.hookSpecificOutput.additionalContext;
  } else {
    resumeOutput = runHook(path.join(pluginRoot, "hooks", "session-resume.js"), {
      cwd: repo,
      session_id: "testsess",
    });
  }
  assert.match(resumeOutput, /code-reviewer phase-2-tests \[ok\]/);
  assert.match(resumeOutput, /phase 2 review iterations so far: 2\/3/);
  assert.match(resumeOutput, /phase 2-tests review iterations so far: 1\/3/);

  // A compaction must not erase YOLO: with it recorded, the checkpoint restates
  // the mode (so the run stays autonomous) and reports the per-loop caps the
  // YOLO budget actually enforces.
  const yoloHome = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-progress-yolo-"));
  process.env.ULTRACODE_HUB_HOME = yoloHome;
  try {
    const { writeYoloEntry } = require(path.join(ROOT, "hooks", "lib", "yolo-state.js"));
    writeYoloEntry({
      session_dir: sessionDir,
      primary_repo_root: repo,
      enabled: true,
      note: "finish D2 overnight",
      updated_by: "test",
    });
  } finally {
    delete process.env.ULTRACODE_HUB_HOME;
  }
  const yoloEnv = { PLUGIN_ROOT: pluginRoot, ULTRACODE_HUB_HOME: yoloHome };
  let yoloResume;
  if (target === "grok") {
    runHook(
      path.join(pluginRoot, "hooks", "session-resume.js"),
      { cwd: repo, session_id: "testsess", hook_event_name: "pre_compact", source: "auto" },
      yoloEnv,
    );
    yoloResume = JSON.parse(
      runHook(
        path.join(pluginRoot, "hooks", "session-resume.js"),
        {
          cwd: repo,
          session_id: "testsess",
          hook_event_name: "pre_tool_use",
          toolName: "read_file",
          toolInput: { file_path: "README.md" },
        },
        yoloEnv,
      ),
    ).hookSpecificOutput.additionalContext;
  } else {
    yoloResume = runHook(
      path.join(pluginRoot, "hooks", "session-resume.js"),
      { cwd: repo, session_id: "testsess" },
      yoloEnv,
    );
  }
  assert.match(yoloResume, /YOLO mode: ON \(finish D2 overnight\)/);
  assert.match(yoloResume, /phase 2 review iterations so far: 2\/10/);
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

  const denied = recordGateDecision(tempDir, "backend", "spec", "approved");
  assert.equal(denied.ok, false);
  assert.match(denied.message, /has not returned a PASS/);

  const rejected = recordGateDecision(tempDir, "backend", "plan", "rejected", "needs rework");
  assert.equal(rejected.ok, true);

  fs.mkdirSync(path.join(tempDir, "backend"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "backend", "factcheck.json"),
    JSON.stringify({ spec: { verdict: "PASS", repo: "backend" } }),
  );
  const approved = recordGateDecision(tempDir, "backend", "spec", "approved");
  assert.equal(approved.ok, true);

  const gates = JSON.parse(fs.readFileSync(path.join(tempDir, "gates.json"), "utf-8"));
  assert.equal(gates.spec.decision, "approved");
  assert.equal(gates.spec.repo, "backend");
  assert.equal(gates.plan.decision, "rejected");
  assert.equal(gates.plan.notes, "needs rework");

  // A verdict recorded under one repo key does not approve another key's gate,
  // and the refusal says which key it looked under so the fix is the call, not a
  // hand-written file.
  const otherKey = recordGateDecision(tempDir, "web", "spec", "approved");
  assert.equal(otherKey.ok, false);
  assert.match(otherKey.message, /none recorded/);
  assert.match(otherKey.message, /Repo key: web/);

  // No repo key at all is refused outright: there is no directory this tool and
  // hooks/factcheck-record.js would both resolve to.
  for (const missing of ["", "   ", undefined, null, "Back End!"]) {
    const result = recordGateDecision(tempDir, missing, "spec", "approved");
    assert.equal(result.ok, false, String(missing));
    assert.match(result.message, /repo_key is required/);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempDir, "gates.json"), "utf-8")).spec.repo, "backend");
});

test("gate state resolves to one path from either session-dir form", () => {
  const { recordGateDecision, factCheckVerdict } = require(path.join(ROOT, "mcp", "lib", "gate.js"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-gate-form-"));
  const sessionDir = path.join(root, ".ultracode", "session", "ultracode-session-abc123");
  const repoSubdir = path.join(sessionDir, "backend");
  fs.mkdirSync(repoSubdir, { recursive: true });

  // Written where a spawn scoped to the repo subdir puts it...
  fs.writeFileSync(
    path.join(repoSubdir, "factcheck.json"),
    JSON.stringify({ plan: { verdict: "PASS", repo: "backend" } }),
  );

  // ...and found by a gate call passing either form of the session dir. This is
  // the deadlock the repo key removes: same inputs, same path, from both sides.
  assert.equal(factCheckVerdict(sessionDir, "backend", "plan"), "PASS");
  assert.equal(factCheckVerdict(repoSubdir, "backend", "plan"), "PASS");

  assert.equal(recordGateDecision(repoSubdir, "backend", "plan", "approved").ok, true);
  const gatesPath = path.join(sessionDir, "gates.json");
  assert.equal(JSON.parse(fs.readFileSync(gatesPath, "utf-8")).plan.decision, "approved");
  assert.equal(fs.existsSync(path.join(repoSubdir, "gates.json")), false);
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
      "agy-message-record.js",
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
      "plugin-guard.js",
      "review-cap.js",
      "scope-guard.js",
      "security-block.js",
      "session-guard.js",
      "session-resume.js",
      "skill-init-guard.js",
      "spawn-log.js",
      "spawn-scope.js",
      "subagent-parameters.json",
    ]);
    for (const lib of [
      "codex-spawn.js",
      "grok-hooks.js",
      "spawn-ticket.js",
      "common.js",
      "harness.js",
      "hook-context.js",
      "subagent-params.js",
      "session.js",
      "yolo-state.js",
      "scope-policy.js",
      "ledger-policy.js",
      "plugin-policy.js",
      "agy-transcript.js",
      "spawn-identity.js",
      "spawn-record.js",
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
    } else if (target === "grok") {
      assert.ok(config.hooks.PreToolUse);
      assert.ok(config.hooks.PostToolUse);
      // No SessionStart registration on grok: its SessionStart source is only
      // ever "new"/"load", never "compact", and Observe hooks have no model
      // channel anyway. The post-compaction checkpoint rides PreCompact
      // (marker) + PreToolUse "*" (inject) instead — lib/grok-hooks.js fact 3.
      assert.equal(config.hooks.SessionStart, undefined);
      assert.match(config.hooks.PreCompact[0].hooks[0].command, /session-resume\.js/);
      assert.equal(config.hooks.PreToolUse[0].matcher, "*");
      assert.match(config.hooks.PreToolUse[0].hooks[0].command, /session-resume\.js/);
      const spawnGroup = config.hooks.PostToolUse.find((group) =>
        /spawn_subagent/.test(group.matcher),
      );
      assert.ok(spawnGroup, "grok PostToolUse spawn group present");
      const commands = spawnGroup.hooks.map((hook) => hook.command).join("\n");
      assert.match(commands, /spawn-log\.js/);
      // DELIBERATELY absent (see hooks/factcheck-record.js header): grok's
      // spawn result is usually a background-launch ack, so the verdict is
      // recorded by the fact-check role itself via ultracode_factcheck. If
      // this assertion surprises you, read that header before "fixing" the
      // registration.
      assert.ok(!commands.includes("factcheck-record.js"));
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

test("runtime dir is shared across harnesses at the project root", () => {
  const layouts = Object.entries(HARNESS_LAYOUT.layouts);
  assert.equal(layouts.length, 4);
  for (const [target, layout] of layouts) {
    assert.equal(layout.runtime_dir, ".ultracode", target);
    // The point of the move: the runtime dir must not sit under any harness's
    // state dir, so one bootstrap serves every harness.
    assert.ok(!layout.runtime_dir.includes("/"), target);
    assert.ok(
      !layout.runtime_dir.startsWith(`${layout.state_dir}/`),
      `${target} runtime_dir must live outside ${layout.state_dir}`,
    );
  }
  // Skill/agent discovery stays harness-native — only the runtime dir moved.
  assert.equal(HARNESS_LAYOUT.layouts.claude.skills_dir, ".claude/skills");
  assert.equal(HARNESS_LAYOUT.layouts.codex.skills_dir, ".agents/skills");
  assert.equal(HARNESS_LAYOUT.layouts.grok.skills_dir, ".grok/skills");
  assert.equal(HARNESS_LAYOUT.layouts.antigravity.skills_dir, ".agents/skills");
});

test("generator rejects a harness-nested runtime dir", () => {
  const sourceRoot = path.join(WORKSPACE, "nested-runtime-dir");
  copyTreeFiltered(GENERATED_SOURCE_ROOT, sourceRoot, ["dist"]);
  const layoutPath = path.join(sourceRoot, "definitions", "harness-layout.json");
  const layout = JSON.parse(fs.readFileSync(layoutPath, "utf-8"));
  layout.layouts.claude.runtime_dir = ".claude/ultracode";
  fs.writeFileSync(layoutPath, JSON.stringify(layout, null, 2), "utf-8");
  let stderr = "";
  try {
    runGenerator("claude", path.join(sourceRoot, "out"), { sourceRoot });
    assert.fail("generator should have rejected a harness-nested runtime dir");
  } catch (err) {
    stderr = err.stderr || "";
    assert.equal(err.status, 2);
  }
  assert.match(stderr, /runtime_dir must be identical across harnesses/);
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
  assert.match(orchestrate, /\.ultracode\/repo-profile\.json/);
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
  assert.match(initKitCommand, /agent_type: ultracode_initializer/);
  assert.doesNotMatch(initKitCommand, /ultracode:initializer/);
  assert.match(orchestrate, /ultracode_fact_check/);
  assert.doesNotMatch(orchestrate, /ultracode:fact-check/);
  const hooks = JSON.parse(fs.readFileSync(path.join(CODEX_PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8"));
  assert.match(hooks.hooks.PreToolUse[0].matcher, /spawn_agent/);
  assert.match(hooks.hooks.PostToolUse[0].matcher, /spawn_agent/);
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
  assert.match(explore, /\.ultracode\/repo-profile\.json/);
  assert.match(explore, /\.grok\/skills\/module-hub/);
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
  assert.match(orchestrate, /default toolset has no skill tool/);

  const initKit = fs.readFileSync(path.join(GROK_PLUGIN_ROOT, "commands", "init-kit.md"), "utf-8");
  assert.match(initKit, /# \/init-kit/);
  assert.match(initKit, /\$ARGUMENTS/);
  assert.match(initKit, /pressing `r` in the Plugins tab/);
  assert.match(initKit, /\$\{GROK_SESSION_ID:-\$\{CLAUDE_CODE_SESSION_ID:-no-session-id\}\}/);

  const hooks = JSON.parse(fs.readFileSync(path.join(GROK_PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8"));
  // No SessionStart on grok — its source is never "compact" (lib/grok-hooks.js
  // fact 3); the checkpoint rides PreCompact + the PreToolUse "*" group.
  assert.equal(hooks.hooks.SessionStart, undefined);
  assert.match(hooks.hooks.PreCompact[0].hooks[0].command, /GROK_PLUGIN_ROOT/);
  assert.equal(hooks.hooks.PreToolUse[0].matcher, "*");
  assert.ok(hooks.hooks.PreToolUse.some((group) => /spawn_subagent/.test(group.matcher)));
});

test("grok hooks accept camelCase payloads", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-grok-camel-"));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts.grok.runtime_dir;
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const prompt = `Primary repo root: ${repo}.\nRepo root: ${repo}.\nSession dir: ${sessionDir}.\nRepo key: backend.\nTask: inspect repository.`;
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
  // Live Grok CLI 1.0.5 honors top-level {decision:"deny"} and fail-opens on the
  // Claude-style hookSpecificOutput.permissionDecision payload.
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /required parameter|Repo root|Session dir|Repo key|Task/i);

  const bashDenied = JSON.parse(
    runHook(
      path.join(GROK_PLUGIN_ROOT, "hooks", "bash-guard.js"),
      { toolInput: { command: "sleep 5" } },
      { GROK_PLUGIN_ROOT: GROK_PLUGIN_ROOT },
    ),
  );
  assert.equal(bashDenied.decision, "deny");
  assert.match(bashDenied.reason, /sleep/);

  // Grok installs orchestrate as commands/orchestrate.md; skill-init must still
  // refuse loading that path from an uninitialized repo.
  const uninit = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-grok-uninit-"));
  const commandPath = path.join(GROK_PLUGIN_ROOT, "commands", "orchestrate.md");
  assertDenied(
    JSON.parse(
      runHook(
        path.join(GROK_PLUGIN_ROOT, "hooks", "skill-init-guard.js"),
        {
          cwd: uninit,
          sessionId: "testsess",
          toolInput: { filePath: commandPath },
        },
        { GROK_PLUGIN_ROOT: GROK_PLUGIN_ROOT },
      ),
    ),
    /has no ultracode inventory/,
  );
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
  // AGY's own agent-md shape: prefixed name (the spawn TypeName) and a tools list.
  assert.match(explore, /^---\nname: ultracode-explore\n/);
  assert.match(explore, /^model: flash$/m);
  assert.match(explore, /^effort: high$/m);
  for (const tool of [
    "view_file",
    "write_to_file",
    "run_command",
    "grep_search",
    "find_by_name",
    "search_web",
    "read_url_content",
  ]) {
    assert.match(explore, new RegExp(`^ {4}- ${tool}$`, "m"), tool);
  }

  const orchestrate = fs.readFileSync(
    path.join(ANTIGRAVITY_PLUGIN_ROOT, "skills", "orchestrate", "SKILL.md"),
    "utf-8",
  );
  assert.match(orchestrate, /invoke_subagent/);
  assert.match(orchestrate, /# Antigravity Notes/);
  assert.match(orchestrate, /Antigravity has no separate Skill tool/);
});

test("antigravity agents ship as natively invocable subagents", () => {
  // AGY resolves a markdown agent as a subagent only in its own shape: the
  // frontmatter `name` is the exact TypeName a spawn passes, `tools` is a YAML
  // list, `subagent: true` marks it invocable, and the prompt sits under an H1.
  // In the Claude shape every ultracode spawn came back "subagent
  // ultracode-fact-check not found or not allowed to be invoked", and the model's
  // way around that was `define_subagent` with a prompt it wrote itself — a
  // different agent under the shipped agent's name.
  for (const name of ["fact-check", "plan", "implement", "code-reviewer"]) {
    const text = fs.readFileSync(
      path.join(ANTIGRAVITY_PLUGIN_ROOT, "agents", `${name}.md`),
      "utf-8",
    );
    assert.match(text, new RegExp(`^name: ultracode-${name}$`, "m"), name);
    assert.match(text, /^subagent: true$/m, name);
    assert.match(text, /^hidden: true$/m, name);
    assert.match(text, /^inheritMcp: true$/m, name);
    assert.match(text, /^tools:\n( {4}- \w+\n)+/m, `${name}: tools must be a YAML list`);
    // send_message is how an AGY subagent returns anything at all.
    assert.match(text, /^ {4}- send_message$/m, name);
    assert.match(text, /^# Agent System Instructions$/m, name);
  }

  // Instructions must name the spawn exactly as AGY resolves it, so no agent is
  // referred to by the colon form anywhere in the AGY build.
  const agentNames = fs
    .readdirSync(path.join(ANTIGRAVITY_PLUGIN_ROOT, "agents"))
    .map((file) => file.replace(/\.md$/, ""));
  const documents = [
    path.join(ANTIGRAVITY_PLUGIN_ROOT, "skills", "orchestrate", "SKILL.md"),
    path.join(ANTIGRAVITY_PLUGIN_ROOT, "skills", "init-kit", "SKILL.md"),
    ...agentNames.map((name) => path.join(ANTIGRAVITY_PLUGIN_ROOT, "agents", `${name}.md`)),
  ];
  for (const document of documents) {
    const text = fs.readFileSync(document, "utf-8");
    for (const name of agentNames) {
      assert.ok(
        !text.includes(`ultracode:${name}`),
        `${document} still spawns ultracode:${name} by its colon name`,
      );
    }
    // Skills are not agents and are still invoked by their colon name.
    if (document.endsWith("orchestrate/SKILL.md")) {
      assert.match(text, /ultracode:orchestrate/);
    }
  }

  // Claude/Codex/Grok keep the colon form and their own agent shapes.
  const claudeAgent = fs.readFileSync(
    path.join(CLAUDE_PLUGIN_ROOT, "agents", "fact-check.md"),
    "utf-8",
  );
  assert.match(claudeAgent, /^name: fact-check$/m);
  assert.doesNotMatch(claudeAgent, /^subagent: true$/m);
  assert.match(
    fs.readFileSync(path.join(CLAUDE_PLUGIN_ROOT, "commands", "orchestrate.md"), "utf-8"),
    /ultracode:fact-check/,
  );
});

test("antigravity hooks accept structured payloads", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-agy-test-"));
  const repo = tempDir;
  const runtimeDir = HARNESS_LAYOUT.layouts.antigravity.runtime_dir;
  const sessionDir = path.join(repo, runtimeDir, "session", "ultracode-session-testsess");
  fs.mkdirSync(sessionDir, { recursive: true });
  const prompt = `Primary repo root: ${repo}.\nRepo root: ${repo}.\nSession dir: ${sessionDir}.\nRepo key: backend.\nTask: inspect repository.`;

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

  const batchedDenied = JSON.parse(
    runHook(
      path.join(ANTIGRAVITY_PLUGIN_ROOT, "hooks", "session-guard.js"),
      {
        cwd: repo,
        conversationId: "testsess",
        toolCall: {
          args: {
            Subagents: [
              { TypeName: "ultracode:explore", Prompt: prompt },
              {
                TypeName: "ultracode:explore",
                Prompt: `Primary repo root: ${repo}.\nRepo root: ${repo}.\nSession dir: ${sessionDir}.\nRepo key: backend.`,
              },
            ],
          },
        },
      },
      { ANTIGRAVITY_PLUGIN_ROOT: ANTIGRAVITY_PLUGIN_ROOT },
    ),
  );
  assert.equal(batchedDenied.decision, "deny");
  assert.match(batchedDenied.reason, /Subagents\[1\]/);
  assert.match(batchedDenied.reason, /no Task:/);

  const routedBatch = JSON.parse(
    runHook(
      path.join(ANTIGRAVITY_PLUGIN_ROOT, "hooks", "model-router.js"),
      {
        cwd: repo,
        conversationId: "testsess",
        toolCall: {
          args: {
            Subagents: [
              { TypeName: "ultracode:explore", Prompt: prompt },
              { TypeName: "ultracode:code-reviewer", Prompt: prompt },
            ],
          },
        },
      },
      { ANTIGRAVITY_PLUGIN_ROOT: ANTIGRAVITY_PLUGIN_ROOT },
    ),
  );
  assert.equal(routedBatch.decision, "allow");
  assert.equal(routedBatch.overwrite.Subagents[0].Model, expectedModel("antigravity", "advanced"));
  assert.equal(routedBatch.overwrite.Subagents[1].Model, expectedModel("antigravity", "balanced"));
  assert.match(routedBatch.overwrite.Subagents[0].Prompt, /Ultracode agent: explore/);
  assert.match(routedBatch.overwrite.Subagents[1].Prompt, /Ultracode agent: code-reviewer/);

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

  // skill-init-guard with Antigravity workspacePaths (uninitialized repo)
  const uninitRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-agy-uninit-"));
  const skillPath = path.join(ANTIGRAVITY_PLUGIN_ROOT, "skills", "orchestrate", "SKILL.md");
  const initGuardDenied = JSON.parse(
    runHook(
      path.join(ANTIGRAVITY_PLUGIN_ROOT, "hooks", "skill-init-guard.js"),
      {
        workspacePaths: [uninitRepo],
        conversationId: "testsess",
        toolCall: {
          name: "view_file",
          args: { AbsolutePath: skillPath },
        },
      },
      { ANTIGRAVITY_PLUGIN_ROOT: ANTIGRAVITY_PLUGIN_ROOT },
    ),
  );
  assert.equal(initGuardDenied.decision, "deny");
  assert.match(initGuardDenied.reason, new RegExp(`repo \`${uninitRepo}\` has no ultracode inventory`));
  assert.doesNotMatch(initGuardDenied.reason, new RegExp(ANTIGRAVITY_PLUGIN_ROOT));

  // skill-init-guard with Antigravity workspacePaths (initialized repo)
  const initRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-agy-init-"));
  fs.mkdirSync(path.join(initRepo, runtimeDir), { recursive: true });
  fs.writeFileSync(path.join(initRepo, runtimeDir, "INVENTORY.md"), "# Inventory\n", "utf-8");
  const initGuardAllowed = runHook(
    path.join(ANTIGRAVITY_PLUGIN_ROOT, "hooks", "skill-init-guard.js"),
    {
      workspacePaths: [initRepo],
      conversationId: "testsess",
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: skillPath },
      },
    },
    { ANTIGRAVITY_PLUGIN_ROOT: ANTIGRAVITY_PLUGIN_ROOT },
  );
  assert.equal(initGuardAllowed, "");
});

