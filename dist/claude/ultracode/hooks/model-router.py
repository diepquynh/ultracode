#!/usr/bin/env python3
"""Enforce per-repository Ultracode model routing for agent spawns."""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")))


def deny(reason: str) -> None:
    emit(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }
    )


def field(prompt: str, label: str) -> str:
    match = re.search(rf"^{re.escape(label)}:\s*(.*?)\s*\.?$", prompt, re.MULTILINE)
    return match.group(1) if match else ""


def phase_tier(prompt: str) -> str:
    phase_file = field(prompt, "Phase file")
    if not phase_file or not Path(phase_file).is_file():
        phase_match = re.search(r"phase-(\d+)", prompt)
        session_dir = field(prompt, "Session dir")
        if phase_match and Path(session_dir).is_dir():
            candidates = sorted(
                glob.glob(
                    str(
                        Path(session_dir)
                        / f"ultracode-plan-*-phase-{phase_match.group(1)}-*.md"
                    )
                )
            )
            phase_file = candidates[0] if candidates else ""
    if not phase_file or not Path(phase_file).is_file():
        return "low"
    match = re.search(
        r"^\*\*Complexity:\*\*\s*(low|medium|high)\s*$",
        Path(phase_file).read_text(encoding="utf-8"),
        re.IGNORECASE | re.MULTILINE,
    )
    return match.group(1).lower() if match else "low"


def profile_route(profile: dict[str, Any], agent: str, prompt: str) -> tuple[bool, Any]:
    models = profile.get("models")
    if not isinstance(models, dict):
        return False, None
    if agent in {"implement", "write-test"}:
        by_complexity = models.get("byPhaseComplexity")
        agent_routes = by_complexity.get(agent) if isinstance(by_complexity, dict) else None
        tier = phase_tier(prompt)
        if not isinstance(agent_routes, dict) or tier not in agent_routes:
            return False, None
        return True, agent_routes[tier]
    by_agent = models.get("byAgent")
    if not isinstance(by_agent, dict) or agent not in by_agent:
        return False, None
    return True, by_agent[agent]


def resolve_model(route: Any, routing: dict[str, Any], agent: str) -> tuple[str, str | None]:
    if route == "inherit":
        return "inherit", None
    if route == "default":
        model = routing["defaults"].get(agent)
        return ("model", model) if model else ("error", None)
    target_specific = isinstance(route, dict)
    if target_specific:
        route = route.get(routing["target"])
    if not isinstance(route, str) or not route.strip():
        return "error", None
    if route in routing["tiers"]:
        model = routing["tiers"][route]
    elif target_specific:
        model = route
    else:
        model = routing["aliases"].get(route, route)
    return "model", model


def main() -> int:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0
    tool_input = hook_input.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0

    plugin_root = Path(
        os.environ.get("PLUGIN_ROOT")
        or os.environ.get("CLAUDE_PLUGIN_ROOT")
        or Path(__file__).resolve().parents[1]
    )
    try:
        routing = json.loads((plugin_root / "hooks" / "model-routing.json").read_text())
    except (OSError, json.JSONDecodeError, KeyError):
        deny("ultracode: generated model routing is unavailable; refusing an unenforced spawn.")
        return 0

    agent_value = next(
        (
            tool_input[key]
            for key in ("subagent_type", "agent_type", "task_name")
            if isinstance(tool_input.get(key), str)
        ),
        "",
    )
    agent = agent_value.removeprefix("ultracode:")
    if agent not in routing["defaults"]:
        return 0

    prompt = next(
        (
            tool_input[key]
            for key in ("prompt", "message")
            if isinstance(tool_input.get(key), str)
        ),
        "",
    )
    repo_value = field(prompt, "Repo root")
    repo = Path(repo_value) if repo_value and Path(repo_value).is_dir() else Path(hook_input.get("cwd", os.getcwd()))
    profile_path = repo / routing["runtime_dir"] / "repo-profile.json"

    if agent == "initializer" and not profile_path.is_file():
        route: Any = tool_input.get("model", "default")
    elif not profile_path.is_file():
        route = "default"
    else:
        try:
            profile = json.loads(profile_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            deny(f"ultracode: {profile_path} is invalid; refusing an unenforced spawn.")
            return 0
        present, route = profile_route(profile, agent, prompt)
        if not present:
            deny(
                f"ultracode: {profile_path} has no model route for {agent}; "
                'set a tier, "default", or "inherit" explicitly.'
            )
            return 0

    action, model = resolve_model(route, routing, agent)
    if action == "inherit":
        return 0
    if action == "error" or not model:
        deny(f"ultracode: invalid model route for {agent}; refusing an unenforced spawn.")
        return 0

    output: dict[str, Any] = {
        "hookEventName": "PreToolUse",
        "updatedInput": {**tool_input, "model": model},
    }
    if routing["target"] == "codex":
        output["permissionDecision"] = "allow"
    emit({"hookSpecificOutput": output})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
