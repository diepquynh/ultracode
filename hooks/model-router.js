#!/usr/bin/env node
// Enforce per-repository Ultracode model routing for agent spawns.
//
// Reads a PreToolUse hook payload from stdin, writes a JSON hook response
// to stdout:
//   * deny            -> { hookSpecificOutput.permissionDecision = "deny" }
//   * allow (inherit) -> no output, exit 0
//   * allow (model)   -> { hookSpecificOutput.updatedInput.model = "<model>" }

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function deny(reason) {
  emit({
    decision: "deny",
    reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
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
  const toolInput = hookInput && (hookInput.tool_input || hookInput.toolInput);
  if (!toolInput || typeof toolInput !== "object") return 0;

  const pluginRoot = path.resolve(
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
    deny(
      "ultracode: generated model routing is unavailable; refusing an unenforced spawn.",
    );
    return 0;
  }

  const agentValue = ["subagent_type", "subagentType", "agent_type", "agentType", "task_name", "taskName"]
    .map((key) => toolInput[key])
    .find((value) => typeof value === "string") || "";
  let agent = agentValue;
  if (agent.startsWith("ultracode:")) agent = agent.slice("ultracode:".length);
  if (!routing.defaults || !(agent in routing.defaults)) return 0;

  const prompt = ["prompt", "message"]
    .map((key) => toolInput[key])
    .find((value) => typeof value === "string") || "";

  const repoValue = field(prompt, "Repo root");
  const cwd = hookInput.cwd || process.cwd();
  const repo =
    repoValue && isDirectory(repoValue) ? path.resolve(repoValue) : path.resolve(cwd);
  const profilePath = path.join(repo, routing.runtime_dir, "repo-profile.json");

  const isExemptFromRoute = agent === "initializer" || agent === "fact-check";

  let route;
  if (!isFile(profilePath)) {
    route = isExemptFromRoute ? toolInput.model || "default" : "default";
  } else {
    let profile;
    try {
      profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
    } catch {
      profile = null;
    }
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      deny(`ultracode: ${profilePath} is invalid; refusing an unenforced spawn.`);
      return 0;
    }
    const [present, computedRoute] = profileRoute(profile, agent, prompt);
    if (!present) {
      if (!isExemptFromRoute) {
        deny(
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
      route = toolInput.model || "default";
    } else {
      route = computedRoute;
    }
  }

  const [action, model] = resolveModel(route, routing, agent);
  if (action === "inherit") return 0;
  if (action === "error" || !model) {
    deny("ultracode: invalid model route for " + agent + "; refusing an unenforced spawn.");
    return 0;
  }

  const output = {
    hookEventName: "PreToolUse",
    updatedInput: { ...toolInput, model },
  };
  if (routing.target === "codex") output.permissionDecision = "allow";
  emit({ hookSpecificOutput: output });
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
