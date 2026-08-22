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
    const parameters = parseParameters(spawn.prompt);
    const repoKey = normalizeRepoKey(parameters.repo_key);
    const workRepoRoot = resolveRepoRoot(this.input, spawn.prompt);
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
      repoKey,
      workRepoRoot,
      primaryRepoRoot,
      stateRoot: effectiveSessionDir ? sessionBaseDir(effectiveSessionDir) : derivedSessionRoot,
      effectiveSessionDir,
    };
  }

  currentActor() {
    const declared = bareAgentName(hookAgentType(this.input));
    if (declared) {
      return {
        agent: declared,
        repoRoot: resolveRepoRoot(this.input, ""),
        repoKey: "",
        sessionDir: this.sessionRoot,
        source: "payload",
      };
    }

    const transcriptPath = hookTranscriptPath(this.input);
    if (transcriptPath) {
      try {
        const { selfContext } = require("./agy-transcript");
        const self = selfContext(transcriptPath);
        if (self.agent) {
          return {
            agent: self.agent,
            repoRoot: self.repoRoot || resolveRepoRoot(this.input, ""),
            repoKey: normalizeRepoKey(self.repoKey),
            sessionDir: self.sessionDir || this.sessionRoot,
            source: "transcript",
          };
        }
      } catch {
        // No transcript context: return an explicit empty actor below.
      }
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
