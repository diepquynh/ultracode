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

const COMMAND_NAMES = new Set([
  "code-review",
  "epa",
  "explore",
  "generate-spec",
  "implement",
  "init-kit",
  "module-docs",
  "plan",
  "prompt-gen",
  "write-test",
]);

let WORKSPACE = null;
let GENERATED_SOURCE_ROOT = null;
let CLAUDE_PLUGIN_ROOT = null;
let CODEX_PLUGIN_ROOT = null;
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
      targetName === "claude"
        ? "$ARGUMENTS"
        : "the user's text following the explicit skill invocation",
    "{{command_prefix}}": targetName === "claude" ? "/" : "$",
    "{{agent_selector}}": targetName === "claude" ? "subagent_type" : "agent_type",
    "{{agent_tool}}": targetName === "claude" ? "Agent" : "spawn_agent",
    "{{session_id_expr}}": target.session_id_expr,
    "{{session_id_source}}": target.session_id_source,
    "{{session_id_names}}": target.session_id_names,
    "{{session_id_agent_names}}": target.session_id_agent_names,
    "{{session_id_inheritance}}": target.session_id_inheritance,
    "{{session_id_unavailable}}": target.session_id_unavailable,
    "{{reload_action}}":
      targetName === "claude"
        ? "running `/reload-plugins` or restarting the session"
        : "starting a new Codex session",
    "{{balanced_model}}": MODEL_MAPPING.tiers.balanced[targetName],
    "{{advanced_model}}": MODEL_MAPPING.tiers.advanced[targetName],
  };
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
  // Build both plugin distributions the way install.sh does: from a clean
  // copy of the sources. The generator's default output path is used on
  // purpose — that `dist/<target>/ultracode` layout is the one install.sh
  // points each harness marketplace at.
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-tests-"));
  GENERATED_SOURCE_ROOT = path.join(WORKSPACE, "checkout");
  copyTreeFiltered(ROOT, GENERATED_SOURCE_ROOT, IGNORED_SOURCE_ENTRIES);
  for (const target of ["claude", "codex"]) {
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
  assert.equal(definitions.length, 22);
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
  assert.match(stdout, /generated 22 definitions for claude/);
});

test("generation is deterministic for both targets", () => {
  for (const target of ["claude", "codex"]) {
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
    "${CLAUDE_PLUGIN_ROOT}",
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

test("model tiers map to both harnesses", () => {
  assert.deepEqual(MODEL_MAPPING.tiers, {
    fast: { claude: "haiku", codex: "gpt-5.6-luna" },
    balanced: { claude: "sonnet", codex: "gpt-5.6-terra" },
    advanced: { claude: "opus", codex: "gpt-5.6-sol" },
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
  const sourceTerms = new Set();
  for (const capability of Object.values(capabilities)) {
    for (const term of capability.source_terms || []) {
      sourceTerms.add(term);
    }
  }
  const declaredClaudeTools = new Set();
  for (const [, definition] of sourceDefinitions()) {
    if (definition.kind !== "agent") continue;
    for (const capabilityId of definition.config.tools) {
      assert.ok(capabilities[capabilityId], `unmapped capability: ${capabilityId}`);
      const entry = capabilities[capabilityId];
      assert.ok(entry.claude);
      assert.ok(entry.codex);
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
  for (const required of ["Agent", "Task", "AskUserQuestion", "EnterPlanMode"]) {
    assert.ok(sourceTerms.has(required));
  }
});

test("generated output passes check mode", () => {
  for (const [target, root] of [
    ["claude", CLAUDE_PLUGIN_ROOT],
    ["codex", CODEX_PLUGIN_ROOT],
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

test("installer dry run covers both harnesses", () => {
  for (const target of ["claude", "codex"]) {
    const result = execFileSync(
      "bash",
      [INSTALLER, target, "--dry-run"],
      { cwd: ROOT, encoding: "utf-8" },
    );
    assert.ok(result.includes(`for ${target}`), result);
    assert.ok(result.includes("Would generate dist/<harness>/ultracode"));
    assert.ok(result.includes("local marketplace"));
  }
  const both = execFileSync(
    "bash",
    [INSTALLER, "--dry-run"],
    { cwd: ROOT, encoding: "utf-8" },
  );
  assert.ok(both.includes("for claude codex"));
});

test("installer reports missing harness before installing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-install-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  for (const tool of ["bash", "node", "git"]) {
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
  const pluginRoot = target === "claude" ? CLAUDE_PLUGIN_ROOT : CODEX_PLUGIN_ROOT;
  const hookInput = {
    cwd: repo,
    tool_input: {
      subagent_type: "ultracode:code-reviewer",
      prompt: `Repo root: ${repo}`,
      model: "wrong-model",
    },
  };
  const expected = target === "claude" ? "sonnet" : "gpt-5.6-terra";

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
  const pluginRoot = target === "claude" ? CLAUDE_PLUGIN_ROOT : CODEX_PLUGIN_ROOT;
  const explicitTierModel = target === "claude" ? "haiku" : "gpt-5.6-luna";
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

test("both plugin distributions include target hooks", () => {
  for (const [target, root] of [
    ["claude", CLAUDE_PLUGIN_ROOT],
    ["codex", CODEX_PLUGIN_ROOT],
  ]) {
    const hookDir = path.join(root, "hooks");
    const files = fs
      .readdirSync(hookDir)
      .filter((name) => fs.statSync(path.join(hookDir, name)).isFile())
      .sort();
    assert.deepEqual(files, [
      "hooks.json",
      "model-router.js",
      "model-routing.json",
      "session-start.sh",
    ]);
    const config = JSON.parse(
      fs.readFileSync(path.join(hookDir, "hooks.json"), "utf-8"),
    );
    assert.ok(config.hooks.SessionStart);
    assert.ok(config.hooks.PreToolUse);
    const sessionCommand = config.hooks.SessionStart[0].hooks[0].command;
    assert.ok(sessionCommand.startsWith("bash "));
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
  const exploreCommand = fs.readFileSync(
    path.join(CODEX_PLUGIN_ROOT, "skills", "explore", "SKILL.md"),
    "utf-8",
  );
  assert.match(exploreCommand, /\$\{CODEX_THREAD_ID:-no-session-id\}/);
  assert.match(exploreCommand, /# \$explore/);
  assert.ok(!exploreCommand.includes("$ARGUMENTS"));
  assert.ok(!exploreCommand.includes("subagent_type"));
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
});
