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

const COMMAND_NAMES = new Set(["init-kit"]);

let WORKSPACE = null;
let GENERATED_SOURCE_ROOT = null;
let CLAUDE_PLUGIN_ROOT = null;
let CODEX_PLUGIN_ROOT = null;
let GROK_PLUGIN_ROOT = null;
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
  for (const target of ["claude", "codex", "grok"]) {
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
          ? path.join(output, relativeParent, `${name}.md`)
          : path.join(output, relativeParent, name, "SKILL.md");
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
        description: definition.description,
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
  for (const target of ["claude", "codex", "grok"]) {
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
    "${CLAUDE_PLUGIN_ROOT}",
    "${GROK_PLUGIN_ROOT}",
    "${PLUGIN_ROOT}",
    "CLAUDE_CODE_SESSION_ID",
    "GROK_SESSION_ID",
    "CODEX_THREAD_ID",
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
    fast: { claude: "haiku", codex: "gpt-5.6-luna", grok: "grok-build-0.1" },
    balanced: { claude: "sonnet", codex: "gpt-5.6-terra", grok: "grok-4.5" },
    advanced: { claude: "opus", codex: "gpt-5.6-sol", grok: "grok-4.6" },
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
});

test("{{tool_*}} placeholders resolve to the correct harness-native name", () => {
  for (const [id, entry] of Object.entries(TOOL_MAPPING.capabilities)) {
    const token = `{{tool_${id}}}`;
    assert.equal(adaptForTarget(token, "claude"), entry.claude);
    assert.equal(adaptForTarget(token, "codex"), entry.codex);
    assert.equal(adaptForTarget(token, "grok"), entry.grok);
  }
});

test("generated output passes check mode", () => {
  for (const [target, root] of [
    ["claude", CLAUDE_PLUGIN_ROOT],
    ["codex", CODEX_PLUGIN_ROOT],
    ["grok", GROK_PLUGIN_ROOT],
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
  const stale = path.join(output, "skills", "orchestrate", "SKILL.md");
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
  throw new Error(`unknown target: ${target}`);
}

function expectedModel(target, tier) {
  return MODEL_MAPPING.tiers[tier][target];
}

test("installer dry run covers every harness", () => {
  for (const target of ["claude", "codex", "grok"]) {
    const result = execFileSync(
      "bash",
      [INSTALLER, target, "--dry-run"],
      { cwd: ROOT, encoding: "utf-8" },
    );
    assert.ok(result.includes(`for ${target}`), result);
    assert.ok(result.includes("Would generate dist/<harness>/ultracode"));
    assert.ok(result.includes("local marketplace"));
  }
  const all = execFileSync(
    "bash",
    [INSTALLER, "--dry-run"],
    { cwd: ROOT, encoding: "utf-8" },
  );
  assert.ok(all.includes("for claude grok codex"));
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
      model: "wrong-model",
    },
  };
  const expected = expectedModel(target, "balanced");

  let stdout = runHook(
    path.join(pluginRoot, "hooks", "model-router.js"),
    hookInput,
    { PLUGIN_ROOT: pluginRoot },
  );
  let output = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(output.updatedInput.model, expected);
  if (target === "codex") assert.equal(output.permissionDecision, "allow");

  profile.models.byAgent["code-reviewer"] = "inherit";
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const inherited = runHook(
    path.join(pluginRoot, "hooks", "model-router.js"),
    hookInput,
    { PLUGIN_ROOT: pluginRoot },
  );
  assert.equal(inherited, "");

  profile.models.byAgent["code-reviewer"] = "default";
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const defaulted = runHook(
    path.join(pluginRoot, "hooks", "model-router.js"),
    hookInput,
    { PLUGIN_ROOT: pluginRoot },
  );
  const defaultOutput = JSON.parse(defaulted).hookSpecificOutput;
  assert.equal(defaultOutput.updatedInput.model, expected);

  profile.models.byAgent["code-reviewer"] = {
    claude: "custom-claude-model",
    codex: "custom-codex-model",
    grok: "custom-grok-model",
  };
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const targeted = runHook(
    path.join(pluginRoot, "hooks", "model-router.js"),
    hookInput,
    { PLUGIN_ROOT: pluginRoot },
  );
  const targetOutput = JSON.parse(targeted).hookSpecificOutput;
  assert.equal(targetOutput.updatedInput.model, `custom-${target}-model`);

  delete profile.models.byAgent["code-reviewer"];
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf-8");
  const missing = runHook(
    path.join(pluginRoot, "hooks", "model-router.js"),
    hookInput,
    { PLUGIN_ROOT: pluginRoot },
  );
  const denied = JSON.parse(missing).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /no model route/);
}

test("model router rewrites and honors explicit fallbacks", () => {
  routeProfileTest("claude");
  routeProfileTest("codex");
  routeProfileTest("grok");
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
  assert.equal(overridden.updatedInput.model, explicitTierModel);
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

  for (const name of [
    "ultracode-spec-2026-01-01-topic.md",
    "ultracode-plan-2026-01-01-topic.md",
    "plan.md",
    "phase-2-service-layer.md",
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
}

test("artifact-guard denies orchestrator edits to pipeline artifacts but exempts subagents", () => {
  artifactGuardTest("claude");
  artifactGuardTest("codex");
  artifactGuardTest("grok");
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

  // An inline no-plan implement spawn (no Phase file:) is exempt from the plan gate.
  assert.equal(run("implement"), "");

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
  ]) {
    assert.ok(fs.statSync(path.join(root, "mcp", "gate-server.js")).isFile());
    assert.ok(fs.statSync(path.join(root, "package.json")).isFile());
    assert.ok(fs.statSync(path.join(root, "package-lock.json")).isFile());
    const servers =
      target === "grok"
        ? JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf-8")).mcpServers
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

test("mcp/lib/memory dedupes by (area, lesson), moves the newest to the end, and caps entries", () => {
  const { appendLesson, DEFAULT_MAX_ENTRIES } = require(
    path.join(ROOT, "mcp", "lib", "memory.js"),
  );
  let text = appendLesson("", { area: "auth", lesson: "L1", source: "a" });
  text = appendLesson(text, { area: "build", lesson: "L2", source: "a" });
  text = appendLesson(text, { area: "auth", lesson: "L1", source: "b" });
  const lines = text.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines, [
    "- [build] L2 — source: a",
    "- [auth] L1 — source: b",
  ]);

  let capped = "";
  for (let i = 0; i < DEFAULT_MAX_ENTRIES + 10; i++) {
    capped = appendLesson(capped, { area: "a", lesson: `lesson-${i}`, source: "s" });
  }
  const cappedLines = capped.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(cappedLines.length, DEFAULT_MAX_ENTRIES);
  assert.match(cappedLines[0], /lesson-10/);
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
  ]) {
    const hookDir = path.join(root, "hooks");
    const files = fs
      .readdirSync(hookDir)
      .filter((name) => fs.statSync(path.join(hookDir, name)).isFile())
      .sort();
    assert.deepEqual(files, [
      "artifact-guard.js",
      "bash-guard.js",
      "factcheck-record.js",
      "hooks.json",
      "model-router.js",
      "model-routing.json",
      "pipeline-gate.js",
      "review-cap.js",
      "security-block.js",
      "session-guard.js",
      "session-resume.js",
      "session-start.sh",
      "spawn-log.js",
    ]);
    assert.ok(fs.statSync(path.join(hookDir, "lib", "common.js")).isFile());
    assert.ok(fs.statSync(path.join(hookDir, "lib", "session.js")).isFile());
    const config = JSON.parse(
      fs.readFileSync(path.join(hookDir, "hooks.json"), "utf-8"),
    );
    assert.ok(config.hooks.SessionStart);
    assert.ok(config.hooks.PreToolUse);
    assert.ok(config.hooks.PostToolUse);
    const sessionCommand = config.hooks.SessionStart[0].hooks[0].command;
    assert.ok(sessionCommand.startsWith("bash "));
    const compactCommand = config.hooks.SessionStart[1].hooks[0].command;
    assert.match(compactCommand, /session-resume\.js/);
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
  assert.match(explore, /model: grok-4\.6/);
  assert.match(explore, /tools: read_file, search_replace, run_terminal_command, grep, list_dir, web_search, web_fetch/);
  assert.match(explore, /\.grok\/ultracode/);
  assert.ok(!explore.includes(".claude/"));
  assert.ok(!explore.includes("CLAUDE_PLUGIN_ROOT"));

  const orchestrate = fs.readFileSync(
    path.join(GROK_PLUGIN_ROOT, "skills", "orchestrate", "SKILL.md"),
    "utf-8",
  );
  assert.match(orchestrate, /spawn_subagent/);
  assert.match(orchestrate, /subagent_type/);
  assert.match(orchestrate, /# Grok Notes/);
  assert.match(orchestrate, /There is no structured question tool/);

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
  assert.equal(denied.decision, "deny");
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");

  const bashDenied = JSON.parse(
    runHook(
      path.join(GROK_PLUGIN_ROOT, "hooks", "bash-guard.js"),
      { toolInput: { command: "sleep 5" } },
      { GROK_PLUGIN_ROOT: GROK_PLUGIN_ROOT },
    ),
  );
  assert.equal(bashDenied.decision, "deny");
});
