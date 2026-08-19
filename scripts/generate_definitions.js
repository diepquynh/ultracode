#!/usr/bin/env node
// Generate Claude Code, Grok Build, or Codex definitions from neutral JSON sources.
//
// Mirrors scripts/generate_definitions.py so install.sh can drive the same
// plugin generation pipeline.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const SOURCE_PARENTS = ["agents", "skills", "commands"];
const COMMON_PLUGIN_INPUTS = [
  "refs",
  "assets",
  "LICENSE",
  "mcp",
  "package.json",
  "package-lock.json",
];
const COMMON_HOOK_FILES = [
  "model-router.js",
  "session-resume.js",
  "review-cap.js",
  "session-guard.js",
  "bash-guard.js",
  "bash-scope-guard.js",
  "artifact-guard.js",
  "scope-guard.js",
  "spawn-log.js",
  "pipeline-gate.js",
  "security-block.js",
  "factcheck-record.js",
  "lib/common.js",
  "lib/session.js",
  "lib/scope-policy.js",
  "lib/shell-paths.js",
];

const HARNESS_TEMPLATE_KEYS = new Set([
  "state_dir",
  "runtime_dir",
  "skills_dir",
  "agents_dir",
  "plugin_root",
  "arguments",
  "command_prefix",
  "agent_selector",
  "session_id_expr",
  "session_id_source",
  "session_id_names",
  "session_id_agent_names",
  "session_id_inheritance",
  "session_id_unavailable",
  "reload_action",
  "balanced_model",
  "advanced_model",
]);

const HARNESS_TEMPLATE_PATTERN = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const HARNESS_SPECIFIC_SOURCE_TERMS = [
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

const AGENT_KEYS = new Set([
  "schema_version",
  "kind",
  "name",
  "description",
  "prompt",
  "config",
]);
const SKILL_KEYS = new Set([
  "schema_version",
  "kind",
  "name",
  "description",
  "prompt",
]);
const COMMAND_KEYS = new Set([
  "schema_version",
  "kind",
  "name",
  "description",
  "prompt",
  "config",
]);

class DefinitionError extends Error {}

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new DefinitionError(`cannot read ${filePath}: ${err.message}`);
  }
}

function require_(condition, message) {
  if (!condition) throw new DefinitionError(message);
}

function toolTemplateTokens(mapping) {
  return Object.keys(mapping.capabilities).map((id) => `tool_${id}`);
}

function allowedTemplateTokens(mapping) {
  return new Set([...HARNESS_TEMPLATE_KEYS, ...toolTemplateTokens(mapping)]);
}

function validateNeutralText(filePath, text, allowedTokens) {
  const unknownTokens = new Set();
  for (const match of text.matchAll(HARNESS_TEMPLATE_PATTERN)) {
    const token = match[1];
    if (!allowedTokens.has(token)) unknownTokens.add(token);
  }
  require_(
    unknownTokens.size === 0,
    `${filePath}: unknown harness template tokens: ${[...unknownTokens]
      .sort()
      .map((t) => `{{${t}}}`)
      .join(", ")}`,
  );
  const concreteTerms = HARNESS_SPECIFIC_SOURCE_TERMS.filter((t) =>
    text.includes(t),
  );
  require_(
    concreteTerms.length === 0,
    `${filePath}: neutral source contains harness-specific paths or variables: ${concreteTerms.join(", ")}`,
  );
}

function validateMapping(filePath, mapping) {
  require_(typeof mapping === "object" && mapping !== null, `${filePath}: root must be a JSON object`);
  require_(mapping.schema_version === 1, `${filePath}: unsupported schema_version`);
  const capabilities = mapping.capabilities;
  require_(
    typeof capabilities === "object" && capabilities !== null && Object.keys(capabilities).length > 0,
    `${filePath}: capabilities must be an object`,
  );
  for (const [capabilityId, entry] of Object.entries(capabilities)) {
    require_(
      typeof capabilityId === "string" &&
        capabilityId.length > 0 &&
        /^[a-z][a-z0-9_]*$/.test(capabilityId),
      `${filePath}: capability IDs must be lower-case snake_case`,
    );
    require_(typeof entry === "object" && entry !== null, `${filePath}: ${capabilityId} must be an object`);
    for (const target of ["claude", "codex", "grok"]) {
      require_(
        typeof entry[target] === "string" && entry[target].length > 0,
        `${filePath}: ${capabilityId}.${target} must be a non-empty string`,
      );
    }
    if (entry.codex_strategy !== undefined) {
      require_(
        typeof entry.codex_strategy === "string" && entry.codex_strategy.length > 0,
        `${filePath}: ${capabilityId}.codex_strategy must be a non-empty string when present`,
      );
    }
    if (entry.grok_strategy !== undefined) {
      require_(
        typeof entry.grok_strategy === "string" && entry.grok_strategy.length > 0,
        `${filePath}: ${capabilityId}.grok_strategy must be a non-empty string when present`,
      );
    }
    const allowedFields = new Set(["claude", "codex", "grok", "codex_strategy", "grok_strategy"]);
    const extraFields = Object.keys(entry).filter((k) => !allowedFields.has(k));
    require_(
      extraFields.length === 0,
      `${filePath}: ${capabilityId} has unknown fields: ${extraFields.sort().join(", ")}`,
    );
  }
}

function validateModelMapping(filePath, mapping) {
  require_(typeof mapping === "object" && mapping !== null, `${filePath}: root must be a JSON object`);
  require_(mapping.schema_version === 1, `${filePath}: unsupported schema_version`);
  const tiers = mapping.tiers;
  require_(typeof tiers === "object" && tiers !== null, `${filePath}: tiers must be an object`);
  for (const [tier, models] of Object.entries(tiers)) {
    require_(typeof models === "object" && models !== null, `${filePath}: tier ${tier} must be an object`);
    const keys = Object.keys(models).sort();
    require_(
      keys.length === 3 &&
        keys.includes("claude") &&
        keys.includes("codex") &&
        keys.includes("grok"),
      `${filePath}: tier ${tier} must map every harness`,
    );
    for (const model of Object.values(models)) {
      require_(
        typeof model === "string" && model.trim().length > 0,
        `${filePath}: tier ${tier} model names must be non-empty strings`,
      );
    }
  }
}

const HARNESS_LAYOUT_REQUIRED = [
  "state_dir",
  "runtime_dir",
  "skills_dir",
  "agents_dir",
  "plugin_root_env",
  "session_id_expr",
  "session_id_source",
  "session_id_names",
  "session_id_agent_names",
  "session_id_inheritance",
  "session_id_unavailable",
];

function validateHarnessLayout(filePath, layout) {
  require_(typeof layout === "object" && layout !== null, `${filePath}: root must be a JSON object`);
  require_(layout.schema_version === 1, `${filePath}: unsupported schema_version`);
  const layouts = layout.layouts;
  const layoutKeys = layouts && Object.keys(layouts).sort();
  require_(
    typeof layouts === "object" &&
      layouts !== null &&
      layoutKeys.length === 3 &&
      layoutKeys.includes("claude") &&
      layoutKeys.includes("codex") &&
      layoutKeys.includes("grok"),
    `${filePath}: layouts must map claude, grok, and codex`,
  );
  for (const [target, values] of Object.entries(layouts)) {
    const valueKeys = Object.keys(values).sort();
    const expected = [...HARNESS_LAYOUT_REQUIRED].sort();
    require_(
      typeof values === "object" &&
        values !== null &&
        valueKeys.length === expected.length &&
        valueKeys.every((k, i) => k === expected[i]),
      `${filePath}: invalid ${target} layout`,
    );
    for (const value of Object.values(values)) {
      require_(
        typeof value === "string" && value.length > 0,
        `${filePath}: ${target} layout values must be non-empty strings`,
      );
    }
  }
}

const PLUGIN_METADATA_REQUIRED = [
  "schema_version",
  "name",
  "display_name",
  "version",
  "description",
  "author",
  "license",
  "keywords",
  "claude",
  "codex",
  "grok",
];

function validatePluginMetadata(filePath, metadata) {
  require_(typeof metadata === "object" && metadata !== null, `${filePath}: root must be a JSON object`);
  require_(metadata.schema_version === 1, `${filePath}: unsupported schema_version`);
  const keys = Object.keys(metadata).sort();
  const expected = [...PLUGIN_METADATA_REQUIRED].sort();
  require_(
    keys.length === expected.length && keys.every((k, i) => k === expected[i]),
    `${filePath}: invalid metadata fields`,
  );
  for (const field of [
    "name",
    "display_name",
    "version",
    "description",
    "license",
  ]) {
    require_(
      typeof metadata[field] === "string" && metadata[field].trim().length > 0,
      `${filePath}: ${field} must be a non-empty string`,
    );
  }
  require_(
    typeof metadata.author === "object" &&
      metadata.author !== null &&
      typeof metadata.author.name === "string" &&
      metadata.author.name.trim().length > 0,
    `${filePath}: author.name must be set`,
  );
  require_(
    Array.isArray(metadata.keywords) &&
      metadata.keywords.every(
        (keyword) => typeof keyword === "string" && keyword.length > 0,
      ),
    `${filePath}: keywords must be a string array`,
  );
  require_(
    typeof metadata.claude === "object" &&
      metadata.claude !== null &&
      typeof metadata.claude.marketplace_description === "string",
    `${filePath}: claude.marketplace_description must be set`,
  );
  require_(
    typeof metadata.codex === "object" &&
      metadata.codex !== null &&
      typeof metadata.codex.interface === "object" &&
      metadata.codex.interface !== null,
    `${filePath}: codex.interface must be set`,
  );
  require_(
    typeof metadata.grok === "object" &&
      metadata.grok !== null &&
      typeof metadata.grok.category === "string" &&
      metadata.grok.category.trim().length > 0,
    `${filePath}: grok.category must be set`,
  );
}

function validateDefinition(filePath, data, toolIds, modelTiers) {
  require_(typeof data === "object" && data !== null, `${filePath}: root must be a JSON object`);
  const kind = data.kind;
  require_(
    kind === "agent" || kind === "skill" || kind === "command",
    `${filePath}: invalid definition kind`,
  );
  const expectedKeys = {
    agent: AGENT_KEYS,
    skill: SKILL_KEYS,
    command: COMMAND_KEYS,
  }[kind];
  const dataKeys = new Set(Object.keys(data));
  const missing = [...expectedKeys].filter((k) => !dataKeys.has(k));
  const extra = [...dataKeys].filter((k) => !expectedKeys.has(k));
  require_(missing.length === 0, `${filePath}: missing fields: ${[...missing].sort().join(", ")}`);
  require_(extra.length === 0, `${filePath}: unknown fields: ${[...extra].sort().join(", ")}`);
  require_(data.schema_version === 1, `${filePath}: unsupported schema_version`);
  const name = data.name;
  require_(typeof name === "string" && name.length > 0, `${filePath}: name must be a non-empty string`);
  require_(
    name.split("-").every((part) => /^[a-z0-9]+$/i.test(part)),
    `${filePath}: name must be lower-case kebab-case`,
  );
  require_(filePath.split(path.sep).slice(-2, -1)[0] === name, `${filePath}: directory name must match definition name`);
  require_(
    typeof data.description === "string" && data.description.trim().length > 0,
    `${filePath}: description must be a non-empty string`,
  );
  const promptPath = data.prompt;
  require_(
    typeof promptPath === "string" &&
      !path.isAbsolute(promptPath) &&
      promptPath.split("/").length === 1,
    `${filePath}: prompt must be a file beside definition.json`,
  );
  require_(promptPath.endsWith(".md"), `${filePath}: prompt must be Markdown`);
  require_(
    fs.existsSync(path.join(path.dirname(filePath), promptPath)) &&
      fs.statSync(path.join(path.dirname(filePath), promptPath)).isFile(),
    `${filePath}: prompt file does not exist`,
  );

  if (kind === "agent") {
    const config = data.config;
    require_(typeof config === "object" && config !== null, `${filePath}: config must be an object`);
    const expectedConfigKeys = new Set([
      "model_tier",
      "reasoning_effort",
      "tools",
      "timeout_seconds",
      "context",
    ]);
    const configKeys = new Set(Object.keys(config));
    require_(
      configKeys.size === expectedConfigKeys.size &&
        [...configKeys].every((k) => expectedConfigKeys.has(k)),
      `${filePath}: invalid config fields`,
    );
    require_(
      modelTiers.has(config.model_tier),
      `${filePath}: config.model_tier must name a tier from definitions/model-mapping.json`,
    );
    const effort = config.reasoning_effort;
    require_(
      typeof effort === "object" &&
        effort !== null &&
        Object.keys(effort).every((k) => k === "claude" || k === "codex" || k === "grok") &&
        ["low", "medium", "high", "max"].includes(effort.claude) &&
        ["low", "medium", "high", "xhigh", "max"].includes(effort.codex) &&
        ["low", "medium", "high", "xhigh", "max"].includes(effort.grok),
      `${filePath}: config.reasoning_effort must set claude, codex, and grok`,
    );
    require_(
      Number.isInteger(config.timeout_seconds) && config.timeout_seconds > 0,
      `${filePath}: timeout_seconds must be a positive integer`,
    );
    require_(config.context === "fork", `${filePath}: unsupported context`);
    const tools = config.tools;
    require_(
      Array.isArray(tools) &&
        tools.length > 0 &&
        tools.every((tool) => typeof tool === "string"),
      `${filePath}: tools must be a non-empty string array`,
    );
    require_(new Set(tools).size === tools.length, `${filePath}: tools must not contain duplicates`);
    const unknownTools = tools.filter((t) => !toolIds.has(t));
    require_(
      unknownTools.length === 0,
      `${filePath}: unmapped tools: ${unknownTools.sort().join(", ")}`,
    );
  } else if (kind === "command") {
    const config = data.config;
    const configKeys = new Set(Object.keys(config));
    require_(
      typeof config === "object" &&
        config !== null &&
        configKeys.size === 1 &&
        configKeys.has("argument_hint"),
      `${filePath}: command config must contain only argument_hint`,
    );
    require_(
      typeof config.argument_hint === "string",
      `${filePath}: config.argument_hint must be a string`,
    );
  }
}

function listFilesMatching(dir, suffix) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const inner of listFilesMatching(full, suffix)) {
        out.push(inner);
      }
    } else if (stat.isFile() && name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out.sort();
}

function loadDefinitions(sourceRoot, mapping, modelMapping) {
  const toolIds = new Set(Object.keys(mapping.capabilities));
  const modelTiers = new Set(Object.keys(modelMapping.tiers));
  const allowedTokens = allowedTemplateTokens(mapping);
  const definitions = [];
  for (const parentName of SOURCE_PARENTS) {
    const parent = path.join(sourceRoot, parentName);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) continue;
    const expectedKind = parentName.slice(0, -1);
    for (const path_ of listFilesMatching(parent, "definition.json")) {
      const data = loadJSON(path_);
      validateDefinition(path_, data, toolIds, modelTiers);
      require_(
        data.kind === expectedKind,
        `${path_}: kind does not match parent directory`,
      );
      const promptPath = path.join(path.dirname(path_), data.prompt);
      const prompt = fs.readFileSync(promptPath, "utf-8");
      validateNeutralText(path_, data.description, allowedTokens);
      validateNeutralText(promptPath, prompt, allowedTokens);
      definitions.push({ sourceDir: path.dirname(path_), data, prompt });
    }
  }
  require_(definitions.length > 0, `${sourceRoot}: no definitions found`);
  const identities = definitions.map((d) => `${d.data.kind}:${d.data.name}`);
  require_(new Set(identities).size === identities.length, "duplicate definition names");
  return definitions;
}

function wrapText(text, width) {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function foldedYaml(key, value) {
  const normalized = value.split(/\s+/).filter((w) => w.length > 0).join(" ");
  const lines = wrapText(normalized, 96);
  return [`${key}: >`, ...lines.map((l) => `  ${l}`)];
}

function claudeFrontmatter(definition, mapping, modelMapping) {
  const data = definition.data;
  const lines = [
    "---",
    `name: ${definition.data.name}`,
    ...foldedYaml("description", data.description),
  ];
  if (definition.data.kind === "agent") {
    const translatedTools = data.config.tools.map(
      (toolId) => mapping.capabilities[toolId].claude,
    );
    const model = modelMapping.tiers[data.config.model_tier].claude;
    lines.push(
      `model: ${model}`,
      `effort: ${data.config.reasoning_effort.claude}`,
      `tools: ${translatedTools.join(", ")}`,
      `timeout: ${data.config.timeout_seconds}`,
      `context: ${data.config.context}`,
    );
  }
  lines.push("---");
  return lines.join("\n") + "\n\n";
}

function renderClaude(definition, mapping, modelMapping) {
  return claudeFrontmatter(definition, mapping, modelMapping) + definition.prompt;
}

function renderClaudeCommand(definition) {
  const argumentHint = JSON.stringify(definition.data.config.argument_hint);
  return [
    "---",
    `description: ${definition.data.description}`,
    `argument-hint: ${argumentHint}`,
    "---",
    "",
    definition.prompt,
  ].join("\n");
}

function tomlString(value) {
  // JSON strings are valid TOML basic strings for the characters used here.
  return JSON.stringify(value);
}

function codexToolPolicy(definition, mapping) {
  const codexTools = [];
  const extraInstructions = [];
  for (const toolId of definition.data.config.tools) {
    const entry = mapping.capabilities[toolId];
    const codexTool = entry.codex;
    if (codexTool && !codexTool.includes(" ")) {
      codexTools.push(codexTool);
    }
    const instruction = entry.codex_strategy;
    if (instruction && !extraInstructions.includes(instruction)) {
      extraInstructions.push(instruction);
    }
  }
  const uniqueTools = [...new Set(codexTools)];
  const lines = [
    "# Harness Tool Policy",
    "",
    `Limit direct tool use in this role to these Codex capabilities: ${uniqueTools
      .map((t) => `\`${t}\``)
      .join(", ")}.`,
  ];
  lines.push(...extraInstructions);
  return lines.join("\n");
}

// Tool names are already resolved to their Codex-native form by the {{tool_*}}
// placeholder substitution in renderHarnessTemplate. This only surfaces the extra
// behavioral guidance (codex_strategy) for capabilities whose Codex mechanism needs
// more explanation than a name swap — e.g. neither Codex nor Grok Build has a Skill
// tool, so skill loading is a read of the skill's SKILL.md. Prose mappings (any
// value that contains a space) are instructions, not Codex tool names.
function codexCapabilityNotes(promptRaw, mapping) {
  const notes = [];
  for (const [id, entry] of Object.entries(mapping.capabilities)) {
    if (!entry.codex_strategy) continue;
    if (promptRaw.includes(`{{tool_${id}}}`) && !notes.includes(entry.codex_strategy)) {
      notes.push(entry.codex_strategy);
    }
  }
  if (notes.length === 0) return "";
  return ["# Codex Notes", "", ...notes].join("\n");
}

function renderHarnessTemplate(text, target, harnessLayout, modelMapping, mapping) {
  const layout = harnessLayout.layouts[target];
  const replacements = {
    "{{state_dir}}": layout.state_dir,
    "{{runtime_dir}}": layout.runtime_dir,
    "{{skills_dir}}": layout.skills_dir,
    "{{agents_dir}}": layout.agents_dir,
    "{{plugin_root}}": `\${${layout.plugin_root_env}}`,
    "{{arguments}}":
      target === "codex"
        ? "the user's text following the explicit skill invocation"
        : "$ARGUMENTS",
    "{{command_prefix}}": target === "codex" ? "$" : "/",
    "{{agent_selector}}": target === "codex" ? "agent_type" : "subagent_type",
    "{{session_id_expr}}": layout.session_id_expr,
    "{{session_id_source}}": layout.session_id_source,
    "{{session_id_names}}": layout.session_id_names,
    "{{session_id_agent_names}}": layout.session_id_agent_names,
    "{{session_id_inheritance}}": layout.session_id_inheritance,
    "{{session_id_unavailable}}": layout.session_id_unavailable,
    "{{reload_action}}":
      target === "claude"
        ? "running `/reload-plugins` or restarting the session"
        : target === "grok"
          ? "pressing `r` in the Plugins tab or starting a new session"
          : "starting a new Codex session",
    "{{balanced_model}}": modelMapping.tiers.balanced[target],
    "{{advanced_model}}": modelMapping.tiers.advanced[target],
  };
  for (const [id, entry] of Object.entries(mapping.capabilities)) {
    replacements[`{{tool_${id}}}`] = entry[target];
  }
  for (const [token, value] of Object.entries(replacements)) {
    text = text.split(token).join(value);
  }
  const unresolved = new Set();
  for (const match of text.matchAll(HARNESS_TEMPLATE_PATTERN)) {
    unresolved.add(match[1]);
  }
  require_(
    unresolved.size === 0,
    `generated ${target} text contains unresolved harness template tokens: ${[...unresolved]
      .sort()
      .map((t) => `{{${t}}}`)
      .join(", ")}`,
  );
  return text;
}

function renderCodexAgent(
  definition,
  mapping,
  modelMapping,
  harnessLayout,
) {
  const data = definition.data;
  const config = data.config;
  const writeTools = new Set(["edit", "write"]);
  const sandboxMode = config.tools.some((t) => writeTools.has(t))
    ? "workspace-write"
    : "read-only";
  const adaptedPrompt = renderHarnessTemplate(
    definition.prompt,
    "codex",
    harnessLayout,
    modelMapping,
    mapping,
  );
  const policy = renderHarnessTemplate(
    codexToolPolicy(definition, mapping),
    "codex",
    harnessLayout,
    modelMapping,
    mapping,
  );
  const instructions = `${policy}\n\n${adaptedPrompt}`;
  const codexEffort =
    config.reasoning_effort.codex ?? config.reasoning_effort.claude;
  const lines = [
    "# Generated from harness-neutral source. Do not edit this file directly.",
    `# Source timeout_seconds = ${config.timeout_seconds}; context = ${config.context}.`,
    "# Codex role files do not expose per-role timeout or context-mode fields.",
    "# The model router supplies the target model so repo-profile.json remains authoritative.",
    `name = ${tomlString(data.name)}`,
    `description = ${tomlString(renderHarnessTemplate(data.description, "codex", harnessLayout, modelMapping, mapping))}`,
    `model_reasoning_effort = ${tomlString(codexEffort)}`,
    `sandbox_mode = ${tomlString(sandboxMode)}`,
    `developer_instructions = ${tomlString(instructions)}`,
    "",
  ];
  return lines.join("\n");
}

function renderCodexSkill(definition, mapping, modelMapping, harnessLayout) {
  const notes = codexCapabilityNotes(definition.prompt, mapping);
  const body = notes ? `${notes}\n\n${definition.prompt}` : definition.prompt;
  return renderHarnessTemplate(
    claudeFrontmatter(definition, mapping, modelMapping) + body,
    "codex",
    harnessLayout,
    modelMapping,
    mapping,
  );
}

function renderCodexCommand(
  definition,
  mapping,
  modelMapping,
  harnessLayout,
) {
  const notes = codexCapabilityNotes(definition.prompt, mapping);
  const body = notes ? `${notes}\n\n${definition.prompt}` : definition.prompt;
  return renderHarnessTemplate(
    claudeFrontmatter(definition, mapping, modelMapping) + body,
    "codex",
    harnessLayout,
    modelMapping,
    mapping,
  );
}

function grokCapabilityNotes(promptRaw, mapping) {
  const notes = [];
  for (const [id, entry] of Object.entries(mapping.capabilities)) {
    if (!entry.grok_strategy) continue;
    if (promptRaw.includes(`{{tool_${id}}}`) && !notes.includes(entry.grok_strategy)) {
      notes.push(entry.grok_strategy);
    }
  }
  if (notes.length === 0) return "";
  return ["# Grok Notes", "", ...notes].join("\n");
}

function grokFrontmatter(definition, mapping) {
  const data = definition.data;
  const lines = [
    "---",
    `name: ${definition.data.name}`,
    ...foldedYaml("description", data.description),
  ];
  if (definition.data.kind === "agent") {
    const translatedTools = data.config.tools
      .map((toolId) => mapping.capabilities[toolId].grok)
      .filter((tool) => tool && !tool.includes(" "));
    const writeTools = new Set(["edit", "write"]);
    const permissionMode = data.config.tools.some((t) => writeTools.has(t))
      ? "default"
      : "plan";
    const grokEffort =
      data.config.reasoning_effort.grok ?? data.config.reasoning_effort.claude;
    // No model: spawn/hook (or inherit-parent) stays authoritative, like Codex.
    // effort stays on the definition — spawn_subagent has no per-invocation field.
    lines.push(
      "prompt_mode: full",
      `permission_mode: ${permissionMode}`,
      `effort: ${grokEffort}`,
      `tools: ${translatedTools.join(", ")}`,
    );
  }
  lines.push("---");
  return lines.join("\n") + "\n\n";
}

function renderGrok(definition, mapping, modelMapping, harnessLayout) {
  const notes = grokCapabilityNotes(definition.prompt, mapping);
  const body = notes ? `${notes}\n\n${definition.prompt}` : definition.prompt;
  const source =
    definition.data.kind === "command"
      ? renderClaudeCommand(definition)
      : grokFrontmatter(definition, mapping) + body;
  return renderHarnessTemplate(source, "grok", harnessLayout, modelMapping, mapping);
}

function outputPath(target, outputRoot, definition) {
  if (definition.data.kind === "agent") {
    const suffix = target === "codex" ? ".toml" : ".md";
    return path.join(outputRoot, "agents", `${definition.data.name}${suffix}`);
  }
  if (definition.data.kind === "skill" || target === "codex") {
    return path.join(outputRoot, "skills", definition.data.name, "SKILL.md");
  }
  return path.join(outputRoot, "commands", `${definition.data.name}.md`);
}

function jsonDocument(payload) {
  return Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function codexCommandMetadata(definition) {
  const displayName =
    definition.data.name === "epa"
      ? "EPA"
      : definition.data.name
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ");
  const shortDescription = `Run the ${displayName} Ultracode stage explicitly.`;
  return Buffer.from(
    "interface:\n" +
      `  display_name: ${JSON.stringify(displayName)}\n` +
      `  short_description: ${JSON.stringify(shortDescription)}\n` +
      "policy:\n" +
      "  allow_implicit_invocation: false\n",
    "utf-8",
  );
}

function gateMcpServers(target, harnessLayout) {
  const pluginRootEnv = harnessLayout.layouts[target].plugin_root_env;
  return {
    "ultracode-gate": {
      command: "node",
      args: [`\${${pluginRootEnv}}/mcp/gate-server.js`],
    },
  };
}

function pluginMetadataFiles(target, metadata, harnessLayout) {
  const common = {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    author: metadata.author,
    license: metadata.license,
    keywords: metadata.keywords,
  };
  if (target === "claude") {
    const plugin = {
      name: metadata.name,
      displayName: metadata.display_name,
      version: metadata.version,
      description: metadata.description,
      author: metadata.author,
      license: metadata.license,
      keywords: metadata.keywords,
      mcpServers: gateMcpServers(target, harnessLayout),
    };
    const marketplace = {
      name: metadata.name,
      owner: metadata.author,
      description: metadata.claude.marketplace_description,
      plugins: [
        {
          name: metadata.name,
          source: ".",
          description: metadata.description,
        },
      ],
    };
    return {
      ".claude-plugin/plugin.json": jsonDocument(plugin),
      ".claude-plugin/marketplace.json": jsonDocument(marketplace),
    };
  }
  if (target === "grok") {
    const plugin = {
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      author: metadata.author,
      license: metadata.license,
      keywords: metadata.keywords,
    };
    if (metadata.grok.homepage) plugin.homepage = metadata.grok.homepage;
    const marketplace = {
      name: metadata.name,
      description: metadata.description,
      owner: metadata.author,
      plugins: [
        {
          name: metadata.name,
          description: metadata.description,
          category: metadata.grok.category,
          source: { type: "local", path: "." },
          keywords: metadata.keywords,
        },
      ],
    };
    if (metadata.grok.homepage) marketplace.plugins[0].homepage = metadata.grok.homepage;
    return {
      ".grok-plugin/plugin.json": jsonDocument(plugin),
      ".grok-plugin/marketplace.json": jsonDocument(marketplace),
      ".mcp.json": jsonDocument({ mcpServers: gateMcpServers(target, harnessLayout) }),
    };
  }
  const interfaceObj = {
    displayName: metadata.display_name,
    ...metadata.codex.interface,
  };
  return {
    ".codex-plugin/plugin.json": jsonDocument({
      ...common,
      skills: "./skills/",
      interface: interfaceObj,
      mcpServers: gateMcpServers(target, harnessLayout),
    }),
  };
}

function modelRoutingFile(target, definitions, modelMapping, harnessLayout) {
  const tiers = {};
  for (const [tier, targets] of Object.entries(modelMapping.tiers)) {
    tiers[tier] = targets[target];
  }
  const aliases = {};
  for (const targets of Object.values(modelMapping.tiers)) {
    for (const model of Object.values(targets)) {
      aliases[model] = targets[target];
    }
  }
  const defaults = {};
  for (const definition of definitions) {
    if (definition.data.kind === "agent") {
      defaults[definition.data.name] = tiers[definition.data.config.model_tier];
    }
  }
  return jsonDocument({
    schema_version: 1,
    target,
    runtime_dir: harnessLayout.layouts[target].runtime_dir,
    skills_dir: harnessLayout.layouts[target].skills_dir,
    agents_dir: harnessLayout.layouts[target].agents_dir,
    tiers,
    aliases,
    defaults,
  });
}

function* walkFiles(root) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

function pluginStaticFiles(
  target,
  sourceRoot,
  definitions,
  mapping,
  modelMapping,
  harnessLayout,
) {
  const allowedTokens = allowedTemplateTokens(mapping);
  const inputs = [...COMMON_PLUGIN_INPUTS];
  const files = new Map();
  for (const inputName of inputs) {
    const source = path.join(sourceRoot, inputName);
    require_(
      fs.existsSync(source),
      `missing plugin input: ${source}`,
    );
    if (!fs.statSync(source).isDirectory() && fs.statSync(source).isFile()) {
      files.set(inputName, fs.readFileSync(source));
      continue;
    }
    for (const filePath of walkFiles(source)) {
      const rel = path.relative(sourceRoot, filePath);
      let content = fs.readFileSync(filePath);
      if (path.extname(filePath) === ".md") {
        const text = content.toString("utf-8");
        if (COMMON_PLUGIN_INPUTS.includes(inputName)) {
          validateNeutralText(filePath, text, allowedTokens);
        }
        content = Buffer.from(
          renderHarnessTemplate(text, target, harnessLayout, modelMapping, mapping),
          "utf-8",
        );
      }
      files.set(rel.split(path.sep).join("/"), content);
    }
  }
  if (target === "codex") {
    for (const definition of definitions) {
      if (definition.data.kind === "command") {
        files.set(
          path.join("skills", definition.data.name, "agents", "openai.yaml").split(path.sep).join("/"),
          codexCommandMetadata(definition),
        );
      }
    }
  }
  const hookConfig = path.join(sourceRoot, "hooks", `hooks.${target}.json`);
  require_(
    fs.existsSync(hookConfig),
    `missing plugin input: ${hookConfig}`,
  );
  files.set("hooks/hooks.json", fs.readFileSync(hookConfig));
  for (const filename of COMMON_HOOK_FILES) {
    const source = path.join(sourceRoot, "hooks", filename);
    require_(
      fs.existsSync(source),
      `missing plugin input: ${source}`,
    );
    files.set(`hooks/${filename}`, fs.readFileSync(source));
  }
  files.set(
    "hooks/model-routing.json",
    modelRoutingFile(target, definitions, modelMapping, harnessLayout),
  );
  return files;
}

function render(target, definition, mapping, modelMapping, harnessLayout) {
  if (target === "claude") {
    const source =
      definition.data.kind === "command"
        ? renderClaudeCommand(definition)
        : renderClaude(definition, mapping, modelMapping);
    return renderHarnessTemplate(source, target, harnessLayout, modelMapping, mapping);
  }
  if (target === "grok") {
    return renderGrok(definition, mapping, modelMapping, harnessLayout);
  }
  if (definition.data.kind === "command") {
    return renderCodexCommand(definition, mapping, modelMapping, harnessLayout);
  }
  if (definition.data.kind === "skill") {
    return renderCodexSkill(definition, mapping, modelMapping, harnessLayout);
  }
  return renderCodexAgent(definition, mapping, modelMapping, harnessLayout);
}

function writeIfChanged(filePath, content, encoding) {
  let existing = null;
  try {
    existing = fs.readFileSync(filePath, encoding);
  } catch {
    existing = null;
  }
  if (existing !== null && existing === content) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, encoding);
  return true;
}

function generate(target, sourceRoot, outputRoot, check) {
  const mappingPath = path.join(sourceRoot, "definitions", "tool-mapping.json");
  const mapping = loadJSON(mappingPath);
  validateMapping(mappingPath, mapping);
  const modelMappingPath = path.join(
    sourceRoot,
    "definitions",
    "model-mapping.json",
  );
  const modelMapping = loadJSON(modelMappingPath);
  validateModelMapping(modelMappingPath, modelMapping);
  const harnessLayoutPath = path.join(
    sourceRoot,
    "definitions",
    "harness-layout.json",
  );
  const harnessLayout = loadJSON(harnessLayoutPath);
  validateHarnessLayout(harnessLayoutPath, harnessLayout);
  const pluginMetadataPath = path.join(
    sourceRoot,
    "definitions",
    "plugin-metadata.json",
  );
  const pluginMetadata = loadJSON(pluginMetadataPath);
  validatePluginMetadata(pluginMetadataPath, pluginMetadata);
  const definitions = loadDefinitions(sourceRoot, mapping, modelMapping);

  const mismatches = [];
  for (const definition of definitions) {
    const destination = outputPath(target, outputRoot, definition);
    const content = render(target, definition, mapping, modelMapping, harnessLayout);
    if (check) {
      if (!fs.existsSync(destination)) {
        mismatches.push(`missing: ${destination}`);
      } else if (fs.readFileSync(destination, "utf-8") !== content) {
        mismatches.push(`out of date: ${destination}`);
      }
      continue;
    }
    writeIfChanged(destination, content, "utf-8");
  }

  const pluginFiles = new Map();
  for (const [rel, content] of Object.entries(
    pluginMetadataFiles(target, pluginMetadata, harnessLayout),
  )) {
    pluginFiles.set(rel, content);
  }
  for (const [rel, content] of pluginStaticFiles(
    target,
    sourceRoot,
    definitions,
    mapping,
    modelMapping,
    harnessLayout,
  )) {
    pluginFiles.set(rel, content);
  }

  for (const [rel, content] of [...pluginFiles.entries()].sort()) {
    const destination = path.join(outputRoot, rel);
    if (check) {
      if (!fs.existsSync(destination)) {
        mismatches.push(`missing: ${destination}`);
      } else if (fs.readFileSync(destination).equals(content) !== true) {
        mismatches.push(`out of date: ${destination}`);
      }
      continue;
    }
    writeIfChanged(destination, content);
  }

  if (mismatches.length > 0) {
    process.stderr.write("generated definitions are not current:\n");
    for (const mismatch of mismatches) {
      process.stderr.write(`  ${mismatch}\n`);
    }
    return 1;
  }
  const action = check ? "verified" : "generated";
  process.stdout.write(
    `${action} ${definitions.length} definitions for ${target} in ${outputRoot}\n`,
  );
  return 0;
}

function parseArgs(argv) {
  const args = {
    target: null,
    outputDir: null,
    sourceRoot: REPO_ROOT,
    check: false,
  };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--target") {
      args.target = argv[i + 1];
      i += 2;
    } else if (arg === "--output-dir") {
      args.outputDir = path.resolve(argv[i + 1]);
      i += 2;
    } else if (arg === "--source-root") {
      args.sourceRoot = path.resolve(argv[i + 1]);
      i += 2;
    } else if (arg === "--check") {
      args.check = true;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
      i += 1;
    } else {
      throw new DefinitionError(`unknown argument: ${arg}`);
    }
  }
  if (!args.target || !["claude", "codex", "grok"].includes(args.target)) {
    throw new DefinitionError("--target must be 'claude', 'codex', or 'grok'");
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(
      "Usage: node generate_definitions.js --target <claude|grok|codex> [--output-dir DIR] [--source-root DIR] [--check]\n",
    );
    return 0;
  }
  try {
    const sourceRoot = args.sourceRoot;
    const outputDir =
      args.outputDir ?? path.join(sourceRoot, "dist", args.target, "ultracode");
    return generate(args.target, sourceRoot, outputDir, args.check);
  } catch (err) {
    if (err instanceof DefinitionError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

process.exit(main());
