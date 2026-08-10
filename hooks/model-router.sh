#!/usr/bin/env bash
# ultracode :: PreToolUse(Task|Agent) model router.
#
# Makes each repo's repo-profile.json `models` block authoritative instead of advisory.
# Whatever model the orchestrator passed on a spawn, this hook overwrites it with the model
# that spawn's OWN repo assigns, by rewriting the tool input through
# `hookSpecificOutput.updatedInput`.
#
# Why this is the right lever: Claude Code resolves a subagent's model as
#   CLAUDE_CODE_SUBAGENT_MODEL  >  per-invocation `model` param  >  front matter  >  session model
# and SubagentStart is context-only (it cannot set a model). Rewriting the per-invocation param
# is therefore the only hook-side control point. Note that CLAUDE_CODE_SUBAGENT_MODEL still
# outranks this hook — leave it unset, or set it to `inherit`, for the profile to win.
#
# Fails open, always. Any missing tool, prompt field, profile, or entry exits 0 with no output,
# which leaves the spawn exactly as the orchestrator wrote it. This hook must never be able to
# break a pipeline run.

set -uo pipefail

IN="$(cat)"
command -v jq >/dev/null 2>&1 || exit 0

# Only ultracode's own pipeline agents. Never touch a built-in or another plugin's spawn.
AGENT="$(printf '%s' "$IN" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null)"
case "$AGENT" in ultracode:*) ;; *) exit 0 ;; esac
BARE="${AGENT#ultracode:}"          # profile keys are bare; spawns stay prefixed

PROMPT="$(printf '%s' "$IN" | jq -r '.tool_input.prompt // ""' 2>/dev/null)"

# Read a `Label: value` line out of the self-contained spawn prompt, dropping the trailing
# sentence period the prompt contract puts on these lines.
field() {
  printf '%s' "$PROMPT" | sed -n "s|^$1:[[:space:]]*\(.*\)\$|\1|p" | head -1 \
    | sed -e 's/[[:space:]]*$//' -e 's/\.*$//'
}

# The phase Complexity tier drives implement/write-test. Resolve it from the phase file: by the
# explicit `Phase file:` line when the spawn carries one, else by the phase number embedded in
# any `...-phase-{N}...` path in the prompt — which is how write-test resolves it, since its
# prompt carries the implement report (`ultracode-implement-*-phase-{N}.md`) rather than the
# phase file. No phase anywhere means an inline task, which the profile treats as `low`.
resolve_tier() {
  local pf n sess t
  pf="$(field 'Phase file')"
  if [ -z "$pf" ] || [ ! -f "$pf" ]; then
    n="$(printf '%s' "$PROMPT" | grep -oE 'phase-[0-9]+' | head -1 | tr -dc '0-9')"
    sess="$(field 'Session dir')"
    if [ -n "$n" ] && [ -n "$sess" ] && [ -d "$sess" ]; then
      pf="$(ls -1 "$sess"/ultracode-plan-*-phase-"$n"-*.md 2>/dev/null | head -1)"
    fi
  fi
  [ -n "${pf:-}" ] && [ -f "$pf" ] || { printf 'low'; return; }

  # Matches the phase header `**Complexity:** Low|Medium|High`, never a step's
  # `- **Complexity**: Small|Medium|Large` — different shape, and not at line start.
  t="$(grep -m1 -oiE '^\*\*Complexity:\*\*[[:space:]]*(low|medium|high)' "$pf" 2>/dev/null \
       | grep -oiE '(low|medium|high)$' | tr '[:upper:]' '[:lower:]')"
  printf '%s' "${t:-low}"
}

# Multi-repo: every spawn names the repo it targets, and each repo routes models its own way.
REPO="$(field 'Repo root')"
{ [ -n "$REPO" ] && [ -d "$REPO" ]; } || REPO="${CLAUDE_PROJECT_DIR:-$PWD}"
PROFILE="$REPO/.claude/ultracode/repo-profile.json"
[ -f "$PROFILE" ] || exit 0

# A half-saved or hand-broken profile routes nothing; say so rather than silently downgrading
# every spawn to the front-matter default for the rest of the session.
if ! jq -e . "$PROFILE" >/dev/null 2>&1; then
  printf '%s' "$IN" | jq -c '{hookSpecificOutput: {hookEventName: "PreToolUse",
    additionalContext: "ultracode: repo-profile.json is not valid JSON — model routing is off for this spawn."}}'
  exit 0
fi

case "$BARE" in
  implement|write-test)
    MODEL="$(jq -r --arg a "$BARE" --arg t "$(resolve_tier)" \
      '.models.byPhaseComplexity[$a][$t] // empty' "$PROFILE" 2>/dev/null)" ;;
  *)
    # initializer included: it has no byAgent entry by design, so this yields empty and the
    # /init-kit command's own per-mode model stands.
    MODEL="$(jq -r --arg a "$BARE" '.models.byAgent[$a] // empty' "$PROFILE" 2>/dev/null)" ;;
esac

# No entry for this agent or tier → don't rewrite. The spawn keeps the orchestrator's argument,
# and failing that the agent's front-matter default.
[ -n "${MODEL:-}" ] || exit 0

# updatedInput replaces the whole input object, so merge rather than emitting a bare {model}.
# No permissionDecision: normal permission handling still applies to the spawn.
printf '%s' "$IN" | jq -c --arg m "$MODEL" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    updatedInput: (.tool_input + {model: $m})
  }
}'
