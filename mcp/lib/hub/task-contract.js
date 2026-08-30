"use strict";

// The task-payload contract for ultracode_task_publish: a task is a set of
// explicit ADDRESSES into shared state, never inlined context. The consuming
// harness already has the full artifacts on disk under the publisher's
// .ultracode session dir; shipping paths instead of prose is both the token
// saving and the same "required inputs over inference" rule every subagent
// spawn follows (hooks/subagent-parameters.json) — a payload that omits an
// address fails here, at publish time, not in the worker's first tool call.

const path = require("node:path");
const { isInside, isDirectory } = require("../../../hooks/lib/common");
const { sessionBaseDir, normalizeRepoKey } = require("../../../hooks/lib/session");
const subagentParameters = require("../../../hooks/subagent-parameters.json");

// Tasks are addresses; 32 KiB of JSON already smells like inlined context.
const MAX_PAYLOAD_BYTES = 32 * 1024;

function isAbsoluteFileish(value) {
  return typeof value === "string" && value.trim() && path.isAbsolute(value.trim());
}

// Returns { ok, errors: string[] }. Every failure names the field, so the
// publisher can repair the payload without guessing.
function validateTaskPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be a JSON object."] };
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf-8") > MAX_PAYLOAD_BYTES) {
    errors.push(
      `payload exceeds ${MAX_PAYLOAD_BYTES} bytes — pass file paths under source.session_dir instead of inlining context.`,
    );
  }

  if (typeof payload.task !== "string" || !payload.task.trim()) {
    errors.push("task must be a non-empty self-contained statement of the work.");
  }
  if (!isAbsoluteFileish(payload.repo_root) || !isDirectory(payload.repo_root.trim())) {
    errors.push("repo_root must be an existing absolute directory.");
  }
  const key = normalizeRepoKey(payload.repo_key);
  if (!key) {
    errors.push("repo_key must be a lowercase slug ([a-z0-9-]); a guessed or empty key is refused.");
  } else if (key !== payload.repo_key) {
    errors.push(`repo_key must be passed already normalized (got '${payload.repo_key}', expected '${key}').`);
  }

  if (payload.agent_hint !== undefined) {
    const known = Object.keys(subagentParameters.agents || {});
    if (!known.includes(payload.agent_hint)) {
      errors.push(`agent_hint '${payload.agent_hint}' is not a shipped agent (${known.join(", ")}).`);
    }
  }

  const source = payload.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    errors.push("source must be an object carrying the publisher's session addresses.");
  } else {
    if (!isAbsoluteFileish(source.session_dir)) {
      errors.push("source.session_dir must be an absolute path.");
    } else {
      const base = sessionBaseDir(path.resolve(source.session_dir.trim()));
      if (!path.basename(base).startsWith("ultracode-session-")) {
        errors.push("source.session_dir must contain an 'ultracode-session-<id>' component.");
      } else {
        const artifactPaths = [];
        if (source.spec_file !== undefined) artifactPaths.push(["source.spec_file", source.spec_file]);
        if (source.phase_file !== undefined) artifactPaths.push(["source.phase_file", source.phase_file]);
        if (source.report_files !== undefined) {
          if (!Array.isArray(source.report_files)) {
            errors.push("source.report_files must be an array of absolute paths.");
          } else {
            for (const [index, file] of source.report_files.entries()) {
              artifactPaths.push([`source.report_files[${index}]`, file]);
            }
          }
        }
        for (const [label, value] of artifactPaths) {
          if (!isAbsoluteFileish(value)) {
            errors.push(`${label} must be an absolute path.`);
          } else if (!isInside(base, path.resolve(value.trim()))) {
            errors.push(`${label} must be inside the publisher's session dir (${base}).`);
          }
        }
      }
    }
  }

  if (payload.constraints !== undefined) {
    if (!payload.constraints || typeof payload.constraints !== "object" || Array.isArray(payload.constraints)) {
      errors.push("constraints must be an object when given.");
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateTaskPayload, MAX_PAYLOAD_BYTES };
