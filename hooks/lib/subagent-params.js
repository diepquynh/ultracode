#!/usr/bin/env node
// Runtime reader/validator for hooks/subagent-parameters.json. The manifest is
// deliberately data, not hook logic: humans can review one list of what each
// leaf agent needs, and every harness enforces the same contract.

"use strict";

const path = require("node:path");
const { isDirectory, readJsonIfFile } = require("./common");
const { normalizeRepoKey } = require("./session");

let contractCache;

function contracts() {
  if (contractCache !== undefined) return contractCache;
  contractCache = readJsonIfFile(path.join(__dirname, "..", "subagent-parameters.json"));
  return contractCache;
}

function promptField(prompt, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(prompt || "").match(new RegExp(`^${escaped}:\\s*(.*?)\\s*\\.?$`, "mi"));
    if (match && match[1]) return match[1].trim();
  }
  return "";
}

function parseParameters(prompt) {
  const manifest = contracts();
  const values = {};
  if (!manifest || !manifest.parameters) return values;
  for (const [name, definition] of Object.entries(manifest.parameters)) {
    values[name] = promptField(prompt, definition.labels || []);
  }
  return values;
}

function validateValue(name, value, definition) {
  const label = definition.labels && definition.labels[0] ? `${definition.labels[0]}:` : `${name}:`;
  if (!value) return `no ${label}`;
  switch (definition.type) {
    case "absolute-directory":
      if (!path.isAbsolute(value)) return `${label} must be absolute`;
      if (!isDirectory(value)) return `${label} is not an existing directory`;
      return "";
    case "absolute-path":
      return path.isAbsolute(value) ? "" : `${label} must be absolute`;
    case "repo-key":
      return normalizeRepoKey(value) ? "" : `${label} is not a repo key; use lowercase letters, digits, and dashes`;
    case "enum":
      return Array.isArray(definition.values) && definition.values.includes(value.toLowerCase())
        ? ""
        : `${label} must be one of ${(definition.values || []).join(", ")}`;
    default:
      return value.trim() ? "" : `missing ${label}`;
  }
}

function requiredParameterNames(agent, values) {
  const manifest = contracts();
  const contract = manifest && manifest.agents && manifest.agents[agent];
  if (!contract) return { required: [], alternatives: [], known: false };
  const required = [...(contract.required || [])];
  if (contract.modes && values.mode && Array.isArray(contract.modes[values.mode.toLowerCase()])) {
    required.push(...contract.modes[values.mode.toLowerCase()]);
  }
  return { required: [...new Set(required)], alternatives: contract.oneOf || [], known: true };
}

function validateSubagentParameters(agent, promptOrValues) {
  const manifest = contracts();
  if (!manifest || !manifest.parameters) {
    return { ok: false, values: {}, errors: ["subagent parameter manifest is unavailable"] };
  }
  const values =
    promptOrValues && typeof promptOrValues === "object"
      ? promptOrValues
      : parseParameters(promptOrValues);
  const { required, alternatives, known } = requiredParameterNames(agent, values);
  if (!known) return { ok: true, values, errors: [] };

  const errors = [];
  for (const name of required) {
    const definition = manifest.parameters[name];
    if (!definition) {
      errors.push(`contract references undefined parameter ${name}`);
      continue;
    }
    const error = validateValue(name, values[name], definition);
    if (error) errors.push(error);
  }
  for (const group of alternatives) {
    if (!group.some((name) => values[name])) {
      errors.push(`one of ${group.join(" or ")} is required`);
    }
  }

  return { ok: errors.length === 0, values, errors };
}

function displayName(parameterName) {
  const manifest = contracts();
  const definition = manifest && manifest.parameters && manifest.parameters[parameterName];
  return definition && definition.labels && definition.labels[0]
    ? `${definition.labels[0]}:`
    : `${parameterName}:`;
}

module.exports = {
  contracts,
  parseParameters,
  requiredParameterNames,
  validateSubagentParameters,
  displayName,
};
