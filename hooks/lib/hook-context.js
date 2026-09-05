#!/usr/bin/env node
// Canonical primitives for one hook invocation. Hooks ask this class for the
// actor, tool input, every requested spawn, work repo, primary session root,
// repo key, and state paths instead of re-parsing harness payloads themselves.

"use strict";

const path = require("node:path");
const {
  bareAgentName,
  generatedTarget,
  harnessAdapter,
  hookAgentType,
  hookSessionId,
  hookToolInput,
  hookToolResponse,
  hookTranscriptPath,
  isDirectory,
  knownAgents,
} = require("./common");
const {
  baseSessionDir,
  normalizeRepoKey,
  pluginTargetInfo,
  resolvePrimaryRepoRoot,
  resolveRepoRoot,
  sessionBaseDir,
} = require("./session");
const { parseParameters } = require("./subagent-params");
const { resolveSealedContract, sealedWorkRepoRoot } = require("./codex-spawn");
const { spawnContextFromTranscript } = require("./spawn-identity");

class HookContext {
  constructor(hookInput) {
    this.input = hookInput && typeof hookInput === "object" ? hookInput : {};
    this.targetInfo = pluginTargetInfo();
    this.target = (this.targetInfo && this.targetInfo.target) || generatedTarget() || "claude";
    this.adapter = harnessAdapter();
    this.toolInput = hookToolInput(this.input);
    this.toolResponse = hookToolResponse(this.input);
    this.sessionId = hookSessionId(this.input);
    this.primaryRepoRoot = resolvePrimaryRepoRoot(this.input);
    this.sessionRoot = this.targetInfo
      ? baseSessionDir(this.primaryRepoRoot, this.targetInfo.runtimeDir, this.sessionId)
      : "";
    this._spawns = null;
  }

  get spawns() {
    if (!this._spawns) {
      this._spawns = this.adapter.spawnEntries(this.toolInput, knownAgents()).map((spawn) =>
        this.#withSpawnContext(spawn),
      );
    }
    return this._spawns;
  }

  #withSpawnContext(spawn) {
    // A sealed spawn message (lib/codex-spawn.js) has no readable Label:
    // lines; its contract comes from the spawn ticket, so every policy hook
    // sees the same parameters a plaintext prompt would have carried.
    const { parameters, ticket } = resolveSealedContract(
      this.target,
      this.sessionId,
      spawn,
      parseParameters(spawn.prompt),
    );
    const repoKey = normalizeRepoKey(parameters.repo_key);
    const workRepoRoot =
      sealedWorkRepoRoot(spawn, parameters) || resolveRepoRoot(this.input, spawn.prompt);
    const primaryRepoRoot = parameters.primary_repo_root
      ? path.resolve(parameters.primary_repo_root)
      : this.primaryRepoRoot;
    const declaredSessionDir = parameters.session_dir ? path.resolve(parameters.session_dir) : "";
    const derivedSessionRoot = this.targetInfo
      ? baseSessionDir(primaryRepoRoot, this.targetInfo.runtimeDir, this.sessionId)
      : this.sessionRoot;
    const effectiveSessionDir =
      declaredSessionDir || (repoKey && derivedSessionRoot ? path.join(derivedSessionRoot, repoKey) : derivedSessionRoot);
    return {
      ...spawn,
      parameters,
      ticket,
      repoKey,
      workRepoRoot,
      primaryRepoRoot,
      stateRoot: effectiveSessionDir ? sessionBaseDir(effectiveSessionDir) : derivedSessionRoot,
      effectiveSessionDir,
    };
  }

  #spawnPromptContext() {
    const transcriptPath = hookTranscriptPath(this.input);
    if (!transcriptPath) return null;
    return spawnContextFromTranscript(transcriptPath);
  }

  // Actor for a leaf tool call. Claude/Codex/Grok often supply agent_type on the
  // hook payload but still leave cwd/project rooted at the primary checkout; the
  // spawn prompt (via transcript) is what names the work Repo root / Repo key /
  // Session dir. Always prefer those declared lines when present so secondary-repo
  // implementer/write-test can write code under the work checkout while reports stay
  // under the primary session root.
  currentActor() {
    const declared = bareAgentName(hookAgentType(this.input));
    const self = this.#spawnPromptContext();
    const promptRepoRoot =
      self && self.repoRoot && isDirectory(self.repoRoot) ? path.resolve(self.repoRoot) : "";
    const promptSessionDir = self && self.sessionDir ? path.resolve(self.sessionDir) : "";
    const promptRepoKey = normalizeRepoKey(self && self.repoKey);

    if (declared) {
      return {
        agent: declared,
        repoRoot: promptRepoRoot || resolveRepoRoot(this.input, ""),
        repoKey: promptRepoKey,
        sessionDir: promptSessionDir || this.sessionRoot,
        source: promptRepoRoot || promptSessionDir || promptRepoKey ? "payload+transcript" : "payload",
      };
    }

    if (self && self.agent) {
      return {
        agent: self.agent,
        repoRoot: promptRepoRoot || resolveRepoRoot(this.input, ""),
        repoKey: promptRepoKey,
        sessionDir: promptSessionDir || this.sessionRoot,
        source: "transcript",
      };
    }

    return {
      agent: "",
      repoRoot: resolveRepoRoot(this.input, ""),
      repoKey: "",
      sessionDir: this.sessionRoot,
      source: "none",
    };
  }

  statePath(name, repoKey = "") {
    const key = normalizeRepoKey(repoKey);
    const directory = key ? path.join(this.sessionRoot, key) : this.sessionRoot;
    return directory ? path.join(directory, name) : "";
  }

  rewrittenToolInput(patches) {
    return this.adapter.rewriteSpawns(this.toolInput, patches);
  }

  updatedInputPayload(updatedInput) {
    return this.adapter.emitUpdatedInput(updatedInput);
  }
}

module.exports = { HookContext };
