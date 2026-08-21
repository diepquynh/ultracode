#!/usr/bin/env node
// Enforce per-repository Ultracode model routing for agent spawns.
//
// Reads a PreToolUse hook payload from stdin, writes a JSON hook response
// to stdout:
//   * deny            -> { hookSpecificOutput.permissionDecision = "deny" } (no top-level `decision` —
//                         that field only accepts "approve"/"block" and "deny" there fails schema
//                         validation, silently discarding the whole payload)
//   * allow (inherit) -> no output, exit 0
//   * allow (model)   -> { hookSpecificOutput.updatedInput.model = "<model>" }
//
// A caller-supplied model that does not resolve to the routed slug is denied,
// not rewritten. Grok treats the original spawn `model` as an explicit
// override (has_user_specified) and will keep it even after updatedInput
// fires, so a silent rewrite cannot win. Omit model, or pass the routed slug.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { denyPreToolUse, bareAgentName, agentFromToolInput } = require("./lib/common.js");
const { augmentPrompt } = require("./lib/context-brief.js");
const { resolveRepoRoot } = require("./lib/session.js");

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function field(prompt, label) {
  const pattern = new RegExp(
    `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.*?)\\s*\\.?$`,
    "m",
  );
  const match = prompt.match(pattern);
  return match ? match[1] : "";
}

function readTextIfFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function phaseTier(prompt) {
  let phaseFile = field(prompt, "Phase file");
  if (phaseFile && !isFile(phaseFile)) phaseFile = "";
  if (!phaseFile) {
    const phaseMatch = prompt.match(/phase-(\d+)/);
    const sessionDir = field(prompt, "Session dir");
    if (phaseMatch && isDirectory(sessionDir)) {
      const prefix = `ultracode-plan-*-phase-${phaseMatch[1]}-`;
      const candidates = listFiles(sessionDir)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
        .sort();
      phaseFile = candidates.length ? path.join(sessionDir, candidates[0]) : "";
    }
  }
  if (!phaseFile || !isFile(phaseFile)) return "low";
  const content = readTextIfFile(phaseFile) || "";
  const match = content.match(
    /^\*\*Complexity:\*\*\s*(low|medium|high)\s*$/im,
  );
  return match ? match[1].toLowerCase() : "low";
}

function profileRoute(profile, agent, prompt) {
  const models = profile && profile.models;
  if (!models || typeof models !== "object") return [false, null];
  if (agent === "implement" || agent === "write-test") {
    const byComplexity = models.byPhaseComplexity;
    const agentRoutes =
      byComplexity && typeof byComplexity === "object"
        ? byComplexity[agent]
        : null;
    const tier = phaseTier(prompt);
    if (!agentRoutes || typeof agentRoutes !== "object") return [false, null];
    if (!(tier in agentRoutes)) return [false, null];
    return [true, agentRoutes[tier]];
  }
  const byAgent = models.byAgent;
  if (!byAgent || typeof byAgent !== "object") return [false, null];
  if (!(agent in byAgent)) return [false, null];
  return [true, byAgent[agent]];
}

function resolveModel(route, routing, agent) {
  if (route === "inherit") return ["inherit", null];
  if (route === "default") {
    const model =
      routing.defaults && routing.defaults[agent]
        ? routing.defaults[agent]
        : undefined;
    return model ? ["model", model] : ["error", null];
  }
  let targetSpecific = false;
  let resolved = route;
  if (route && typeof route === "object") {
    targetSpecific = true;
    resolved = route[routing.target];
  }
  if (typeof resolved !== "string" || !resolved.trim()) return ["error", null];
  let model;
  if (routing.tiers && resolved in routing.tiers) {
    model = routing.tiers[resolved];
  } else if (targetSpecific) {
    model = resolved;
  } else {
    model =
      routing.aliases && Object.prototype.hasOwnProperty.call(routing.aliases, resolved)
        ? routing.aliases[resolved]
        : resolved;
  }
  return ["model", model];
}

function canonicalizeCallerModel(name, routing) {
  if (typeof name !== "string") return "";
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (routing.tiers && Object.prototype.hasOwnProperty.call(routing.tiers, trimmed)) {
    return routing.tiers[trimmed];
  }
  if (routing.aliases && Object.prototype.hasOwnProperty.call(routing.aliases, trimmed)) {
    return routing.aliases[trimmed];
  }
  return trimmed;
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const stdin = await readStdin();
  let hookInput;
  try {
    hookInput = JSON.parse(stdin);
  } catch {
    return 0;
  }
  const toolInput =
    hookInput &&
    (hookInput.toolCall && typeof hookInput.toolCall === "object"
      ? hookInput.toolCall.args || hookInput.toolCall.input
      : hookInput.tool_input || hookInput.toolInput);
  if (!toolInput || typeof toolInput !== "object") return 0;

  const pluginRoot = path.resolve(
    process.env.ANTIGRAVITY_PLUGIN_ROOT ||
    process.env.AGY_PLUGIN_ROOT ||
    process.env.GROK_PLUGIN_ROOT ||
    process.env.PLUGIN_ROOT ||
    process.env.CLAUDE_PLUGIN_ROOT ||
    path.join(__dirname, ".."),
  );

  let routing;
  try {
    const text = fs.readFileSync(
      path.join(pluginRoot, "hooks", "model-routing.json"),
      "utf-8",
    );
    routing = JSON.parse(text);
  } catch {
    denyPreToolUse(
      "ultracode: generated model routing is unavailable; refusing an unenforced spawn.",
    );
    return 0;
  }

  let agent = agentFromToolInput(toolInput);
  if (!agent) {
    const agentValue = ["subagent_type", "subagentType", "agent_type", "agentType", "task_name", "taskName", "Role", "role", "TypeName", "typeName"]
      .map((key) => toolInput[key])
      .find((value) => typeof value === "string") || "";
    agent = bareAgentName(agentValue);
  }
  if (!routing.defaults || !(agent in routing.defaults)) return 0;

  let prompt = "";
  if (Array.isArray(toolInput.Subagents) && toolInput.Subagents.length > 0) {
    const first = toolInput.Subagents[0];
    if (typeof first.Prompt === "string") prompt = first.Prompt;
    else if (typeof first.prompt === "string") prompt = first.prompt;
  }
  if (!prompt) {
    prompt = ["prompt", "Prompt", "message", "Message"]
      .map((key) => toolInput[key])
      .find((value) => typeof value === "string") || "";
  }

  const repo = resolveRepoRoot(hookInput, prompt);
  const profilePath = path.join(repo, routing.runtime_dir, "repo-profile.json");

  const isExemptFromRoute = agent === "initializer" || agent === "fact-check";

  let callerRawModel = toolInput.model || toolInput.Model;
  if (!callerRawModel && Array.isArray(toolInput.Subagents) && toolInput.Subagents.length > 0) {
    callerRawModel = toolInput.Subagents[0].Model || toolInput.Subagents[0].model;
  }

  let route;
  if (!isFile(profilePath)) {
    route = isExemptFromRoute ? callerRawModel || "default" : "default";
  } else {
    let profile;
    try {
      profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
    } catch {
      profile = null;
    }
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      denyPreToolUse(`ultracode: ${profilePath} is invalid; refusing an unenforced spawn.`);
      return 0;
    }
    const [present, computedRoute] = profileRoute(profile, agent, prompt);
    if (!present) {
      if (!isExemptFromRoute) {
        denyPreToolUse(
          `ultracode: ${profilePath} has no model route for ${agent}; ` +
          'set a tier, "default", or "inherit" explicitly.',
        );
        return 0;
      }
      // The initializer is spawned by the init-kit command, which sets its model per mode, and the
      // seeded profile deliberately carries no initializer route. Denying here would make every
      // re-initialization of an already-initialized repo fail. A route set by hand still wins.
      // fact-check is exempted the same way: it is now a mandatory gate on every spec/plan, so an
      // existing repo-profile.json written before this agent existed must not start hard-failing
      // every approval until the user (or a re-run of /init-kit) adds an explicit route.
      route = callerRawModel || "default";
    } else {
      route = computedRoute;
    }
  }

  // Never allowed to break a spawn: any failure building the brief leaves the
  // prompt exactly as the caller wrote it.
  let briefedPrompt = null;
  try {
    briefedPrompt = augmentPrompt({
      agent,
      prompt,
      repoRoot: repo,
      runtimeDir: routing.runtime_dir,
    });
  } catch {
    briefedPrompt = null;
  }
  const promptKey = ["prompt", "message"].find((key) => typeof toolInput[key] === "string");
  const withBrief = (input) =>
    briefedPrompt && promptKey ? { ...input, [promptKey]: briefedPrompt } : input;

  // Antigravity tells a subagent's own hooks nothing about which agent they are
  // running inside — no `agent_type`, and its conversation id is not the pipeline's
  // session id — so every per-agent hook was inert in there: build-streak counted
  // no failures and its escalation gate could never fire. The spawn prompt is the
  // one thing that crosses into the subagent's conversation and is preserved as its
  // own first transcript step, so the identity is stamped there, by this hook rather
  // than by the orchestrator's good behaviour. hooks/lib/agy-transcript.js
  // (selfContext) reads it back.
  const stampAgent = (text) =>
    routing.target === "antigravity" && text && !/^Ultracode agent:/m.test(text)
      ? `${text}${text.endsWith("\n") ? "" : "\n"}Ultracode agent: ${agent}\n`
      : text;
  const agyPrompt = stampAgent(briefedPrompt || prompt);
  const agySubagents = (extra = {}) =>
    toolInput.Subagents.map((sub, idx) => (idx === 0 ? { ...sub, Prompt: agyPrompt, ...extra } : sub));

  const [action, model] = resolveModel(route, routing, agent);
  if (action === "inherit") {
    if (routing.target === "antigravity" && Array.isArray(toolInput.Subagents) && toolInput.Subagents.length > 0) {
      // Emitted whenever the prompt changed at all — the stamp alone is reason
      // enough, even with no brief to add.
      if (agyPrompt !== (toolInput.Subagents[0].Prompt || toolInput.Subagents[0].prompt)) {
        emit({ decision: "allow", overwrite: { ...toolInput, Subagents: agySubagents() } });
      }
      return 0;
    }
    if (briefedPrompt) {
      if (routing.target === "antigravity" && promptKey) {
        emit({
          decision: "allow",
          overwrite: { ...withBrief(toolInput), [promptKey]: agyPrompt },
        });
      } else if (promptKey) {
        emit({
          hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: withBrief(toolInput) },
        });
      }
    }
    return 0;
  }
  if (action === "error" || !model) {
    denyPreToolUse("ultracode: invalid model route for " + agent + "; refusing an unenforced spawn.");
    return 0;
  }

  const callerModel = canonicalizeCallerModel(callerRawModel, routing);
  if (callerModel && callerModel !== "inherit" && callerModel !== model) {
    denyPreToolUse(
      `ultracode: spawn model "${callerRawModel}" does not match the routed model ` +
      `"${model}" for ${agent}. Omit model, or re-spawn with model: ${model} — ` +
      "the profile owns this route and a caller override is not applied.",
    );
    return 0;
  }

  let updated;
  if (routing.target === "antigravity" && Array.isArray(toolInput.Subagents) && toolInput.Subagents.length > 0) {
    updated = { ...toolInput, Subagents: agySubagents({ Model: model }) };
    emit({
      decision: "allow",
      overwrite: updated,
    });
  } else if (routing.target === "antigravity") {
    updated = { ...withBrief({ ...toolInput, model, Model: model }), ...(promptKey ? { [promptKey]: agyPrompt } : {}) };
    emit({
      decision: "allow",
      overwrite: updated,
    });
  } else {
    updated = withBrief({ ...toolInput, model });
    const output = {
      hookEventName: "PreToolUse",
      updatedInput: updated,
    };
    if (routing.target === "codex") output.permissionDecision = "allow";
    emit({
      decision: "allow",
      overwrite: updated,
      hookSpecificOutput: output,
    });
  }
  return 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  () => {
    process.exit(0);
  },
);
