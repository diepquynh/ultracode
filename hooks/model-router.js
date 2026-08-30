#!/usr/bin/env node
// Enforce per-repository model routing and apply one composed rewrite to every
// Ultracode subagent in the tool call. Harness envelope/casing lives in
// hooks/lib/harness.js; policy here only sees canonical spawn entries.

"use strict";

const path = require("node:path");
const {
  denyPreToolUse,
  emit,
  generatedRouting,
  isFile,
  readHookInput,
  readJsonIfFile,
  readTextIfFile,
} = require("./lib/common");
const { augmentPrompt } = require("./lib/context-brief");
const { forkTurnsPin, promptRewritable, skipSealedRouting } = require("./lib/codex-spawn");
const { HookContext } = require("./lib/hook-context");

function phaseTier(phaseFile) {
  if (!phaseFile || !isFile(phaseFile)) return "low";
  const content = readTextIfFile(phaseFile) || "";
  const match = content.match(/^\*\*Complexity:\*\*\s*(low|medium|high)\s*$/im);
  return match ? match[1].toLowerCase() : "low";
}

function profileRoute(profile, spawn) {
  const { agent } = spawn;
  const models = profile && profile.models;
  if (!models || typeof models !== "object") return [false, null];
  if (agent === "implement" || agent === "write-test") {
    const routes = models.byPhaseComplexity && models.byPhaseComplexity[agent];
    const tier = phaseTier(spawn.parameters.phase_file);
    if (!routes || typeof routes !== "object" || !(tier in routes)) return [false, null];
    return [true, routes[tier]];
  }
  const routes = models.byAgent;
  if (!routes || typeof routes !== "object" || !(agent in routes)) return [false, null];
  return [true, routes[agent]];
}

function resolveModel(route, routing, agent) {
  if (route === "inherit") return ["inherit", null];
  if (route === "default") {
    const model = routing.defaults && routing.defaults[agent];
    return model ? ["model", model] : ["error", null];
  }
  let targetSpecific = false;
  let resolved = route;
  if (route && typeof route === "object") {
    targetSpecific = true;
    resolved = route[routing.target];
  }
  if (typeof resolved !== "string" || !resolved.trim()) return ["error", null];
  if (routing.tiers && resolved in routing.tiers) return ["model", routing.tiers[resolved]];
  if (targetSpecific) return ["model", resolved];
  return [
    "model",
    routing.aliases && Object.prototype.hasOwnProperty.call(routing.aliases, resolved)
      ? routing.aliases[resolved]
      : resolved,
  ];
}

function canonicalizeCallerModel(name, routing) {
  if (typeof name !== "string" || !name.trim()) return "";
  const trimmed = name.trim();
  if (routing.tiers && Object.prototype.hasOwnProperty.call(routing.tiers, trimmed)) {
    return routing.tiers[trimmed];
  }
  if (routing.aliases && Object.prototype.hasOwnProperty.call(routing.aliases, trimmed)) {
    return routing.aliases[trimmed];
  }
  return trimmed;
}

function stampedPrompt(target, primaryRepoRoot, spawn, prompt) {
  if (target !== "antigravity" || !prompt) return prompt;
  let stamped = prompt;
  const stamps = [
    ["Ultracode agent", spawn.agent],
    ["Ultracode primary repo", primaryRepoRoot],
  ];
  for (const [label, value] of stamps) {
    if (value && !new RegExp(`^${label}:`, "m").test(stamped)) {
      stamped += `${stamped.endsWith("\n") ? "" : "\n"}${label}: ${value}\n`;
    }
  }
  return stamped;
}

async function main() {
  const hookInput = await readHookInput();
  const context = new HookContext(hookInput);
  if (!context.toolInput || !context.targetInfo) return 0;

  const routing = generatedRouting();
  if (!routing || !routing.defaults) {
    denyPreToolUse("ultracode: generated model routing is unavailable; refusing an unenforced spawn.");
    return 0;
  }

  const patches = new Map();
  for (const spawn of context.spawns) {
    const agent = spawn.agent;
    if (!agent || !(agent in routing.defaults)) continue;

    if (skipSealedRouting(spawn)) continue;

    const profilePath = path.join(spawn.workRepoRoot, routing.runtime_dir, "repo-profile.json");
    const exempt = agent === "initializer" || agent === "fact-check";
    let route;
    if (!isFile(profilePath)) {
      route = exempt ? spawn.model || "default" : "default";
    } else {
      const profile = readJsonIfFile(profilePath);
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        denyPreToolUse(`ultracode: ${profilePath} is invalid; refusing an unenforced spawn.`);
        return 0;
      }
      const [present, computed] = profileRoute(profile, spawn);
      if (!present && !exempt) {
        denyPreToolUse(
          `ultracode: ${profilePath} has no model route for ${agent}; set a tier, "default", or "inherit" explicitly.`,
        );
        return 0;
      }
      route = present ? computed : spawn.model || "default";
    }

    // A sealed prompt is never rewritten (lib/codex-spawn.js); the child gets
    // the brief's substance through its role instructions instead.
    let prompt = spawn.prompt;
    if (promptRewritable(spawn)) {
      try {
        const augmented = augmentPrompt({
          agent,
          prompt: spawn.prompt,
          repoRoot: spawn.workRepoRoot,
          runtimeDir: routing.runtime_dir,
        });
        prompt = typeof augmented === "string" ? augmented : spawn.prompt;
      } catch {
        prompt = spawn.prompt;
      }
      prompt = stampedPrompt(routing.target, spawn.primaryRepoRoot, spawn, prompt);
    }

    const [action, model] = resolveModel(route, routing, agent);
    if (action === "error" || (action === "model" && !model)) {
      denyPreToolUse(`ultracode: invalid model route for ${agent}; refusing an unenforced spawn.`);
      return 0;
    }

    const callerModel = canonicalizeCallerModel(spawn.model, routing);
    if (action === "model" && callerModel && callerModel !== "inherit" && callerModel !== model) {
      denyPreToolUse(
        `ultracode: spawn model "${spawn.model}" does not match the routed model "${model}" for ${agent}. ` +
          `Omit model, or re-spawn with model: ${model} — the profile owns this route.`,
      );
      return 0;
    }

    const patch = {};
    if (prompt !== spawn.prompt) patch.prompt = prompt;
    // On codex this injected model IS the route — role TOMLs deliberately
    // carry no model, because a role-file model would override this argument
    // unconditionally (docs/model-routing.md, cross-harness section).
    if (action === "model") patch.model = model;
    const pin = forkTurnsPin(routing.target, spawn);
    if (pin) patch.assign = pin;
    if (Object.keys(patch).length) patches.set(spawn.index, patch);
  }

  if (patches.size) {
    const updatedInput = context.rewrittenToolInput(patches);
    emit(context.updatedInputPayload(updatedInput));
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
