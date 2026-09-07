#!/usr/bin/env node
// Enforce per-repository model AND harness routing, and apply one composed
// rewrite to every Ultracode subagent in the tool call. Harness
// envelope/casing lives in hooks/lib/harness.js; policy here only sees
// canonical spawn entries.
//
// WHY HARNESS ROUTING IS ENFORCED HERE TOO
//
// `harnesses` in repo-profile.json says which harness runs each stage. Left to
// prose, an orchestrator resolved that itself, which failed in both directions:
// it kept work local because the route "looked local", and it generalized one
// spawn's outcome into a standing rule for the rest of the session. Both defeat
// the point of a file the user edits. So the profile is read here, per spawn,
// and the orchestrator is told the outcome rather than deciding it:
//
//   * routed to another harness with a live listener → the local spawn is
//     denied, naming the harness and the publish call that reaches it;
//   * routed to this harness, unrouted, or routed somewhere with nothing
//     listening → allowed, with a note saying which case applied and that it
//     covers this spawn alone.
//
// The check re-reads the file on every spawn, like the model route, so a
// profile the user edits mid-session wins over anything the model remembers.

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
const { resolveHarnessRoute } = require("../mcp/lib/hub/harness-route");
const { hasLiveListener } = require("../mcp/lib/hub/listeners");
const { pipelineSessionCommand } = require("./lib/pipeline-session");

// Agents no `harnesses` route applies to. initializer belongs to /init-kit,
// which runs outside the hub's task flow.
const UNROUTABLE_AGENTS = new Set(["initializer"]);

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
  if (agent === "implementer" || agent === "write-test") {
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

// → { deny } to refuse this spawn, or { note } to allow it with a line for the
// model. Never throws: a broken profile or an unreadable hub answers "runs
// here", because routing work away is advisory and a stage must not be lost to
// a routing lookup that failed.
function harnessDecision(spawn, target) {
  let resolved = { route: null, source: null };
  try {
    resolved = resolveHarnessRoute({
      repoRoot: spawn.workRepoRoot,
      agentHint: spawn.agent,
      phaseFile: spawn.parameters.phase_file,
    });
  } catch {
    resolved = { route: null, source: null };
  }

  if (resolved.invalid) {
    return {
      note:
        `${spawn.agent}: the profile's harnesses route is "${resolved.invalid}", which is not a harness ` +
        `name, so it is ignored and this spawn runs here (${target}). Tell the user to fix the profile — ` +
        "routes are always claude, codex, grok, or antigravity.",
    };
  }
  if (!resolved.route) {
    return {
      note: `${spawn.agent}: no harnesses route in the profile, so this spawn runs here (${target}).`,
    };
  }
  if (resolved.route === target) {
    return {
      note:
        `${spawn.agent}: the profile routes it to ${target} (${resolved.source}), this harness, ` +
        "so this spawn runs here.",
    };
  }

  let listening = false;
  try {
    listening = hasLiveListener({ harness: resolved.route, repoRoot: spawn.workRepoRoot });
  } catch {
    listening = false;
  }
  if (!listening) {
    return {
      note:
        `${spawn.agent}: the profile routes it to ${resolved.route} (${resolved.source}), but no ` +
        `${resolved.route} session is listening for ${spawn.workRepoRoot}, so this spawn runs here ` +
        `(${target}). Say that to the user.`,
    };
  }
  return {
    deny:
      `ultracode: the profile routes ${spawn.agent} to ${resolved.route} (harnesses.${resolved.source}), ` +
      `not ${target}, and a ${resolved.route} session is listening for ${spawn.workRepoRoot}. ` +
      "Publish it with ultracode_task_publish (omit target_harness — the hub resolves the route itself) " +
      "and wait for the completion notice instead of spawning it here.",
    compact:
      `ultracode: ${spawn.agent} is routed to ${resolved.route}, not ${target}. ` +
      "Publish it with ultracode_task_publish (no target_harness) and wait; do not spawn it here.",
  };
}

// One note for the whole call. A single spawn call may carry several subagents,
// and the harness delivers one additionalContext string for all of them.
function routingNote(lines) {
  if (!lines.length) return "";
  return [
    "ultracode harness-routing check — applies to this spawn call only:",
    ...lines.map((line) => `- ${line}`),
    "The profile is re-read on every spawn. Do not carry this outcome to the next stage, do not infer a " +
      "standing route from it, and do not open repo-profile.json to predict it.",
  ].join("\n");
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

  // A hub-listen worker is exempt: it only runs tasks it claimed, and the hub
  // targeted those by harness, so the claim already authorized local execution.
  // Enforcing the route again there would refuse a review loop inside a task
  // this harness was handed, with nothing left to publish it to.
  const claimedWork = pipelineSessionCommand(routing.target, context.sessionId) === "hub-listen";

  const patches = new Map();
  const routeNotes = [];
  for (const spawn of context.spawns) {
    const agent = spawn.agent;
    if (!agent || !(agent in routing.defaults)) continue;

    if (skipSealedRouting(spawn)) continue;

    // Which harness runs this stage is settled before which model does: a
    // stage that belongs on another harness must not be denied for the local
    // profile's model route instead.
    if (!claimedWork && !UNROUTABLE_AGENTS.has(agent)) {
      const decision = harnessDecision(spawn, routing.target);
      if (decision.deny) {
        denyPreToolUse(decision.deny, decision.compact);
        return 0;
      }
      if (decision.note) routeNotes.push(decision.note);
    }

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

  const updatedInput = patches.size ? context.rewrittenToolInput(patches) : null;
  const payload = context.updatedInputPayload(updatedInput, routingNote(routeNotes));
  if (payload) emit(payload);
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
