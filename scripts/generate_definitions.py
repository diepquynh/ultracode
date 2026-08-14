#!/usr/bin/env python3
"""Generate Claude Code or Codex definitions from neutral JSON sources."""

from __future__ import annotations

import argparse
import json
import re
import sys
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_PARENTS = ("agents", "skills", "commands")
COMMON_PLUGIN_INPUTS = ("refs", "assets", "LICENSE")
COMMON_HOOK_FILES = ("model-router.py", "session-start.sh")
HARNESS_TEMPLATE_KEYS = {
    "state_dir",
    "runtime_dir",
    "skills_dir",
    "agents_dir",
    "plugin_root",
    "arguments",
    "command_prefix",
    "agent_selector",
    "agent_tool",
    "session_id_expr",
    "session_id_source",
    "session_id_names",
    "reload_action",
    "balanced_model",
    "advanced_model",
}
HARNESS_TEMPLATE_PATTERN = re.compile(r"\{\{([a-z][a-z0-9_]*)\}\}")
HARNESS_SPECIFIC_SOURCE_TERMS = (
    ".claude/",
    ".codex/",
    "${CLAUDE_PLUGIN_ROOT}",
    "${PLUGIN_ROOT}",
)
AGENT_KEYS = {
    "schema_version",
    "kind",
    "name",
    "description",
    "prompt",
    "config",
}
SKILL_KEYS = {"schema_version", "kind", "name", "description", "prompt"}
COMMAND_KEYS = {
    "schema_version",
    "kind",
    "name",
    "description",
    "prompt",
    "config",
}


class DefinitionError(ValueError):
    pass


@dataclass(frozen=True)
class Definition:
    source_dir: Path
    data: dict[str, Any]
    prompt: str

    @property
    def kind(self) -> str:
        return self.data["kind"]

    @property
    def name(self) -> str:
        return self.data["name"]


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DefinitionError(f"cannot read {path}: {exc}") from exc


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DefinitionError(message)


def validate_neutral_text(path: Path, text: str) -> None:
    unknown_tokens = set(HARNESS_TEMPLATE_PATTERN.findall(text)) - HARNESS_TEMPLATE_KEYS
    require(
        not unknown_tokens,
        f"{path}: unknown harness template tokens: "
        + ", ".join(f"{{{{{token}}}}}" for token in sorted(unknown_tokens)),
    )
    concrete_terms = [term for term in HARNESS_SPECIFIC_SOURCE_TERMS if term in text]
    require(
        not concrete_terms,
        f"{path}: neutral source contains harness-specific paths or variables: "
        + ", ".join(concrete_terms),
    )


def validate_mapping(path: Path, mapping: Any) -> None:
    require(isinstance(mapping, dict), f"{path}: root must be a JSON object")
    require(mapping.get("schema_version") == 1, f"{path}: unsupported schema_version")
    capabilities = mapping.get("capabilities")
    require(isinstance(capabilities, dict) and capabilities, f"{path}: capabilities must be an object")
    for capability_id, entry in capabilities.items():
        require(
            isinstance(capability_id, str)
            and capability_id
            and capability_id.replace("_", "").isalnum()
            and capability_id.lower() == capability_id,
            f"{path}: capability IDs must be lower-case snake_case",
        )
        require(isinstance(entry, dict), f"{path}: {capability_id} must be an object")
        for target in ("claude", "codex"):
            require(
                isinstance(entry.get(target), str) and entry[target],
                f"{path}: {capability_id}.{target} must be a non-empty string",
            )
        source_terms = entry.get("source_terms")
        require(
            isinstance(source_terms, list)
            and source_terms
            and all(isinstance(term, str) and term for term in source_terms),
            f"{path}: {capability_id}.source_terms must contain non-empty strings",
        )


def validate_model_mapping(path: Path, mapping: Any) -> None:
    require(isinstance(mapping, dict), f"{path}: root must be a JSON object")
    require(mapping.get("schema_version") == 1, f"{path}: unsupported schema_version")
    tiers = mapping.get("tiers")
    require(isinstance(tiers, dict) and tiers, f"{path}: tiers must be an object")
    for tier, models in tiers.items():
        require(isinstance(models, dict), f"{path}: tier {tier} must be an object")
        require(set(models) == {"claude", "codex"}, f"{path}: tier {tier} must map both harnesses")
        require(
            all(isinstance(model, str) and model.strip() for model in models.values()),
            f"{path}: tier {tier} model names must be non-empty strings",
        )


def validate_harness_layout(path: Path, layout: Any) -> None:
    require(isinstance(layout, dict), f"{path}: root must be a JSON object")
    require(layout.get("schema_version") == 1, f"{path}: unsupported schema_version")
    layouts = layout.get("layouts")
    require(
        isinstance(layouts, dict) and set(layouts) == {"claude", "codex"},
        f"{path}: layouts must map claude and codex",
    )
    required = {
        "state_dir",
        "runtime_dir",
        "skills_dir",
        "agents_dir",
        "plugin_root_env",
    }
    for target, values in layouts.items():
        require(isinstance(values, dict) and set(values) == required, f"{path}: invalid {target} layout")
        require(
            all(isinstance(value, str) and value for value in values.values()),
            f"{path}: {target} layout values must be non-empty strings",
        )


def validate_plugin_metadata(path: Path, metadata: Any) -> None:
    require(isinstance(metadata, dict), f"{path}: root must be a JSON object")
    require(metadata.get("schema_version") == 1, f"{path}: unsupported schema_version")
    required = {
        "schema_version",
        "name",
        "display_name",
        "version",
        "description",
        "author",
        "license",
        "keywords",
        "claude",
        "codex",
    }
    require(set(metadata) == required, f"{path}: invalid metadata fields")
    for field in ("name", "display_name", "version", "description", "license"):
        require(
            isinstance(metadata[field], str) and metadata[field].strip(),
            f"{path}: {field} must be a non-empty string",
        )
    require(
        isinstance(metadata["author"], dict)
        and isinstance(metadata["author"].get("name"), str)
        and metadata["author"]["name"].strip(),
        f"{path}: author.name must be set",
    )
    require(
        isinstance(metadata["keywords"], list)
        and all(isinstance(keyword, str) and keyword for keyword in metadata["keywords"]),
        f"{path}: keywords must be a string array",
    )
    require(
        isinstance(metadata["claude"], dict)
        and isinstance(metadata["claude"].get("marketplace_description"), str),
        f"{path}: claude.marketplace_description must be set",
    )
    require(
        isinstance(metadata["codex"], dict)
        and isinstance(metadata["codex"].get("interface"), dict),
        f"{path}: codex.interface must be set",
    )


def validate_definition(
    path: Path,
    data: Any,
    tool_ids: set[str],
    model_tiers: set[str],
) -> None:
    require(isinstance(data, dict), f"{path}: root must be a JSON object")
    kind = data.get("kind")
    require(kind in {"agent", "skill", "command"}, f"{path}: invalid definition kind")
    expected_keys = {
        "agent": AGENT_KEYS,
        "skill": SKILL_KEYS,
        "command": COMMAND_KEYS,
    }[kind]
    missing = expected_keys - data.keys()
    extra = data.keys() - expected_keys
    require(not missing, f"{path}: missing fields: {', '.join(sorted(missing))}")
    require(not extra, f"{path}: unknown fields: {', '.join(sorted(extra))}")
    require(data["schema_version"] == 1, f"{path}: unsupported schema_version")
    name = data["name"]
    require(isinstance(name, str) and name, f"{path}: name must be a non-empty string")
    require(
        all(part.isalnum() and part.lower() == part for part in name.split("-")),
        f"{path}: name must be lower-case kebab-case",
    )
    require(path.parent.name == name, f"{path}: directory name must match definition name")
    require(
        isinstance(data["description"], str) and data["description"].strip(),
        f"{path}: description must be a non-empty string",
    )
    prompt_path = Path(data["prompt"])
    require(
        not prompt_path.is_absolute() and len(prompt_path.parts) == 1,
        f"{path}: prompt must be a file beside definition.json",
    )
    require(prompt_path.suffix == ".md", f"{path}: prompt must be Markdown")
    require((path.parent / prompt_path).is_file(), f"{path}: prompt file does not exist")

    if kind == "agent":
        config = data["config"]
        require(isinstance(config, dict), f"{path}: config must be an object")
        expected_config_keys = {
            "model_tier",
            "reasoning_effort",
            "tools",
            "timeout_seconds",
            "context",
        }
        require(set(config) == expected_config_keys, f"{path}: invalid config fields")
        require(
            config["model_tier"] in model_tiers,
            f"{path}: config.model_tier must name a tier from definitions/model-mapping.json",
        )
        effort = config["reasoning_effort"]
        require(
            isinstance(effort, dict)
            and set(effort).issubset({"claude", "codex"})
            and effort.get("claude") in {"low", "medium", "high", "max"}
            and effort.get("codex", "high") in {"low", "medium", "high", "xhigh", "max"},
            f"{path}: config.reasoning_effort.claude must be set",
        )
        require(
            isinstance(config["timeout_seconds"], int) and config["timeout_seconds"] > 0,
            f"{path}: timeout_seconds must be a positive integer",
        )
        require(config["context"] == "fork", f"{path}: unsupported context")
        tools = config["tools"]
        require(
            isinstance(tools, list)
            and tools
            and all(isinstance(tool, str) for tool in tools),
            f"{path}: tools must be a non-empty string array",
        )
        require(len(tools) == len(set(tools)), f"{path}: tools must not contain duplicates")
        unknown_tools = set(tools) - tool_ids
        require(not unknown_tools, f"{path}: unmapped tools: {', '.join(sorted(unknown_tools))}")
    elif kind == "command":
        config = data["config"]
        require(
            isinstance(config, dict) and set(config) == {"argument_hint"},
            f"{path}: command config must contain only argument_hint",
        )
        require(
            isinstance(config["argument_hint"], str),
            f"{path}: config.argument_hint must be a string",
        )


def load_definitions(
    source_root: Path,
    mapping: dict[str, Any],
    model_mapping: dict[str, Any],
) -> list[Definition]:
    tool_ids = set(mapping["capabilities"])
    model_tiers = set(model_mapping["tiers"])
    definitions: list[Definition] = []
    for parent_name in SOURCE_PARENTS:
        parent = source_root / parent_name
        expected_kind = parent_name[:-1]
        for path in sorted(parent.glob("*/definition.json")):
            data = load_json(path)
            validate_definition(path, data, tool_ids, model_tiers)
            require(data["kind"] == expected_kind, f"{path}: kind does not match parent directory")
            prompt = (path.parent / data["prompt"]).read_text(encoding="utf-8")
            validate_neutral_text(path, data["description"])
            validate_neutral_text(path.parent / data["prompt"], prompt)
            definitions.append(Definition(path.parent, data, prompt))

    require(definitions, f"{source_root}: no definitions found")
    identities = [(item.kind, item.name) for item in definitions]
    require(len(identities) == len(set(identities)), "duplicate definition names")
    return definitions


def folded_yaml(key: str, value: str) -> list[str]:
    normalized = " ".join(value.split())
    lines = textwrap.wrap(
        normalized,
        width=100,
        initial_indent="  ",
        subsequent_indent="  ",
        break_long_words=False,
        break_on_hyphens=False,
    )
    return [f"{key}: >", *lines]


def claude_frontmatter(
    definition: Definition,
    mapping: dict[str, Any],
    model_mapping: dict[str, Any],
) -> str:
    data = definition.data
    lines = ["---", f"name: {definition.name}", *folded_yaml("description", data["description"])]
    if definition.kind == "agent":
        translated_tools: list[str] = []
        for tool_id in data["config"]["tools"]:
            translated_tools.append(mapping["capabilities"][tool_id]["claude"])
        config = data["config"]
        model = model_mapping["tiers"][config["model_tier"]]["claude"]
        lines.extend(
            [
                f"model: {model}",
                f"effort: {config['reasoning_effort']['claude']}",
                f"tools: {', '.join(translated_tools)}",
                f"timeout: {config['timeout_seconds']}",
                f"context: {config['context']}",
            ]
        )
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def render_claude(
    definition: Definition,
    mapping: dict[str, Any],
    model_mapping: dict[str, Any],
) -> str:
    return claude_frontmatter(definition, mapping, model_mapping) + definition.prompt


def render_claude_command(definition: Definition) -> str:
    argument_hint = json.dumps(definition.data["config"]["argument_hint"], ensure_ascii=False)
    return "\n".join(
        [
            "---",
            f"description: {definition.data['description']}",
            f"argument-hint: {argument_hint}",
            "---",
            "",
            definition.prompt,
        ]
    )


def toml_string(value: str) -> str:
    # JSON strings are valid TOML basic strings for the characters used here.
    return json.dumps(value, ensure_ascii=False)


def codex_tool_policy(definition: Definition, mapping: dict[str, Any]) -> str:
    codex_tools: list[str] = []
    extra_instructions: list[str] = []
    for tool_id in definition.data["config"]["tools"]:
        entry = mapping["capabilities"][tool_id]
        codex_tool = entry.get("codex")
        if codex_tool and codex_tool != "skill discovery":
            codex_tools.append(codex_tool)
        instruction = entry.get("codex_strategy")
        if instruction and instruction not in extra_instructions:
            extra_instructions.append(instruction)
    unique_tools = list(dict.fromkeys(codex_tools))
    lines = [
        "# Harness Tool Policy",
        "",
        "Limit direct tool use in this role to these Codex capabilities: "
        + ", ".join(f"`{tool}`" for tool in unique_tools)
        + ".",
    ]
    lines.extend(extra_instructions)
    return "\n".join(lines)


def codex_vocabulary_policy(prompt: str, mapping: dict[str, Any]) -> str:
    translations: list[str] = []
    strategies: list[str] = []
    for entry in mapping["capabilities"].values():
        used_terms = [
            term
            for term in entry.get("source_terms", [])
            if re.search(rf"\b{re.escape(term)}\b", prompt)
        ]
        if not used_terms:
            continue
        source = "/".join(f"`{term}`" for term in used_terms)
        translations.append(f"- {source} means the Codex `{entry['codex']}` capability.")
        strategy = entry.get("codex_strategy")
        if strategy and strategy not in strategies:
            strategies.append(strategy)
    if not translations:
        return ""
    lines = [
        "# Codex Vocabulary",
        "",
        "The preserved prompt uses Claude Code tool names. Interpret them as follows:",
        "",
        *translations,
    ]
    if strategies:
        lines.extend(["", *strategies])
    return "\n".join(lines)


def render_harness_template(
    text: str,
    target: str,
    harness_layout: dict[str, Any],
    model_mapping: dict[str, Any],
) -> str:
    layout = harness_layout["layouts"][target]
    replacements = {
        "{{state_dir}}": layout["state_dir"],
        "{{runtime_dir}}": layout["runtime_dir"],
        "{{skills_dir}}": layout["skills_dir"],
        "{{agents_dir}}": layout["agents_dir"],
        "{{plugin_root}}": f"${{{layout['plugin_root_env']}}}",
        "{{arguments}}": "$ARGUMENTS"
        if target == "claude"
        else "the user's text following the explicit skill invocation",
        "{{command_prefix}}": "/" if target == "claude" else "$",
        "{{agent_selector}}": "subagent_type" if target == "claude" else "agent_type",
        "{{agent_tool}}": "Agent" if target == "claude" else "spawn_agent",
        "{{session_id_expr}}": "${CLAUDE_CODE_SESSION_ID:-${GROK_SESSION_ID:-no-session-id}}"
        if target == "claude"
        else "${CODEX_THREAD_ID:-no-session-id}",
        "{{session_id_source}}": "`CLAUDE_CODE_SESSION_ID`, else `GROK_SESSION_ID` (inherited unchanged)"
        if target == "claude"
        else "`CODEX_THREAD_ID`, falling back to `no-session-id` (inherited unchanged)",
        "{{session_id_names}}": "`CLAUDE_CODE_SESSION_ID`, else `GROK_SESSION_ID`"
        if target == "claude"
        else "`CODEX_THREAD_ID`, falling back to `no-session-id`",
        "{{reload_action}}": "running `/reload-plugins` or restarting the session"
        if target == "claude"
        else "starting a new Codex session",
        "{{balanced_model}}": model_mapping["tiers"]["balanced"][target],
        "{{advanced_model}}": model_mapping["tiers"]["advanced"][target],
    }
    for token, value in replacements.items():
        text = text.replace(token, value)
    unresolved = set(HARNESS_TEMPLATE_PATTERN.findall(text))
    require(
        not unresolved,
        f"generated {target} text contains unresolved harness template tokens: "
        + ", ".join(f"{{{{{token}}}}}" for token in sorted(unresolved)),
    )
    return text


def render_codex_agent(
    definition: Definition,
    mapping: dict[str, Any],
    model_mapping: dict[str, Any],
    harness_layout: dict[str, Any],
) -> str:
    data = definition.data
    config = data["config"]
    write_tools = {"edit", "write"}
    sandbox_mode = "workspace-write" if write_tools.intersection(config["tools"]) else "read-only"
    adapted_prompt = render_harness_template(
        definition.prompt, "codex", harness_layout, model_mapping
    )
    policies = [codex_tool_policy(definition, mapping), codex_vocabulary_policy(adapted_prompt, mapping)]
    instructions = "\n\n".join(policy for policy in policies if policy) + "\n\n" + adapted_prompt
    codex_effort = config["reasoning_effort"].get("codex", config["reasoning_effort"]["claude"])
    lines = [
        "# Generated from harness-neutral source. Do not edit this file directly.",
        f"# Source timeout_seconds = {config['timeout_seconds']}; context = {config['context']}.",
        "# Codex role files do not expose per-role timeout or context-mode fields.",
        "# The model router supplies the target model so repo-profile.json remains authoritative.",
        f"name = {toml_string(data['name'])}",
        f"description = {toml_string(render_harness_template(data['description'], 'codex', harness_layout, model_mapping))}",
    ]
    lines.extend(
        [
            f"model_reasoning_effort = {toml_string(codex_effort)}",
            f"sandbox_mode = {toml_string(sandbox_mode)}",
            f"developer_instructions = {toml_string(instructions)}",
            "",
        ]
    )
    return "\n".join(lines)


def render_codex_skill(
    definition: Definition,
    mapping: dict[str, Any],
    model_mapping: dict[str, Any],
    harness_layout: dict[str, Any],
) -> str:
    policy = codex_vocabulary_policy(definition.prompt, mapping)
    body = f"{policy}\n\n{definition.prompt}" if policy else definition.prompt
    return render_harness_template(
        claude_frontmatter(definition, mapping, model_mapping) + body,
        "codex",
        harness_layout,
        model_mapping,
    )


def render_codex_command(
    definition: Definition,
    mapping: dict[str, Any],
    model_mapping: dict[str, Any],
    harness_layout: dict[str, Any],
) -> str:
    policy = codex_vocabulary_policy(definition.prompt, mapping)
    body = f"{policy}\n\n{definition.prompt}" if policy else definition.prompt
    return render_harness_template(
        claude_frontmatter(definition, mapping, model_mapping) + body,
        "codex",
        harness_layout,
        model_mapping,
    )


def output_path(target: str, output_root: Path, definition: Definition) -> Path:
    if definition.kind == "agent":
        suffix = ".md" if target == "claude" else ".toml"
        return output_root / "agents" / f"{definition.name}{suffix}"
    if definition.kind == "skill" or target == "codex":
        return output_root / "skills" / definition.name / "SKILL.md"
    return output_root / "commands" / f"{definition.name}.md"


def json_document(payload: dict[str, Any]) -> bytes:
    return (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode()


def codex_command_metadata(definition: Definition) -> bytes:
    display_name = (
        "EPA"
        if definition.name == "epa"
        else definition.name.replace("-", " ").title()
    )
    short_description = f"Run the {display_name} Ultracode stage explicitly."
    return (
        "interface:\n"
        f"  display_name: {json.dumps(display_name)}\n"
        f"  short_description: {json.dumps(short_description)}\n"
        "policy:\n"
        "  allow_implicit_invocation: false\n"
    ).encode()


def plugin_metadata_files(target: str, metadata: dict[str, Any]) -> dict[Path, bytes]:
    common = {
        "name": metadata["name"],
        "version": metadata["version"],
        "description": metadata["description"],
        "author": metadata["author"],
        "license": metadata["license"],
        "keywords": metadata["keywords"],
    }
    if target == "claude":
        plugin = {
            "name": metadata["name"],
            "displayName": metadata["display_name"],
            "version": metadata["version"],
            "description": metadata["description"],
            "author": metadata["author"],
            "license": metadata["license"],
            "keywords": metadata["keywords"],
        }
        marketplace = {
            "name": metadata["name"],
            "owner": metadata["author"],
            "description": metadata["claude"]["marketplace_description"],
            "plugins": [
                {
                    "name": metadata["name"],
                    "source": ".",
                    "description": metadata["description"],
                }
            ],
        }
        return {
            Path(".claude-plugin/plugin.json"): json_document(plugin),
            Path(".claude-plugin/marketplace.json"): json_document(marketplace),
        }

    interface = {
        "displayName": metadata["display_name"],
        **metadata["codex"]["interface"],
    }
    return {
        Path(".codex-plugin/plugin.json"): json_document(
            {**common, "skills": "./skills/", "interface": interface}
        )
    }


def model_routing_file(
    target: str,
    definitions: list[Definition],
    model_mapping: dict[str, Any],
    harness_layout: dict[str, Any],
) -> bytes:
    tiers = {
        tier: targets[target]
        for tier, targets in model_mapping["tiers"].items()
    }
    aliases = {
        model: targets[target]
        for targets in model_mapping["tiers"].values()
        for model in targets.values()
    }
    defaults = {
        definition.name: tiers[definition.data["config"]["model_tier"]]
        for definition in definitions
        if definition.kind == "agent"
    }
    return json_document(
        {
            "schema_version": 1,
            "target": target,
            "runtime_dir": harness_layout["layouts"][target]["runtime_dir"],
            "tiers": tiers,
            "aliases": aliases,
            "defaults": defaults,
        }
    )


def plugin_static_files(
    target: str,
    source_root: Path,
    definitions: list[Definition],
    model_mapping: dict[str, Any],
    harness_layout: dict[str, Any],
) -> dict[Path, bytes]:
    inputs = list(COMMON_PLUGIN_INPUTS)
    files: dict[Path, bytes] = {}
    for input_name in inputs:
        source = source_root / input_name
        require(source.exists(), f"missing plugin input: {source}")
        if source.is_file():
            files[Path(input_name)] = source.read_bytes()
            continue
        for path in sorted(source.rglob("*")):
            if path.is_file():
                content = path.read_bytes()
                if path.suffix == ".md":
                    if input_name in COMMON_PLUGIN_INPUTS:
                        validate_neutral_text(path, content.decode("utf-8"))
                    content = render_harness_template(
                        content.decode("utf-8"), target, harness_layout, model_mapping
                    ).encode()
                files[path.relative_to(source_root)] = content
    if target == "codex":
        for definition in definitions:
            if definition.kind == "command":
                files[
                    Path("skills") / definition.name / "agents" / "openai.yaml"
                ] = codex_command_metadata(definition)
    hook_config = source_root / "hooks" / f"hooks.{target}.json"
    require(hook_config.is_file(), f"missing plugin input: {hook_config}")
    files[Path("hooks/hooks.json")] = hook_config.read_bytes()
    for filename in COMMON_HOOK_FILES:
        source = source_root / "hooks" / filename
        require(source.is_file(), f"missing plugin input: {source}")
        files[Path("hooks") / filename] = source.read_bytes()
    files[Path("hooks/model-routing.json")] = model_routing_file(
        target, definitions, model_mapping, harness_layout
    )
    return files


def render(
    target: str,
    definition: Definition,
    mapping: dict[str, Any],
    model_mapping: dict[str, Any],
    harness_layout: dict[str, Any],
) -> str:
    if target == "claude":
        source = (
            render_claude_command(definition)
            if definition.kind == "command"
            else render_claude(definition, mapping, model_mapping)
        )
        return render_harness_template(
            source,
            target,
            harness_layout,
            model_mapping,
        )
    if definition.kind == "command":
        return render_codex_command(
            definition, mapping, model_mapping, harness_layout
        )
    if definition.kind == "skill":
        return render_codex_skill(definition, mapping, model_mapping, harness_layout)
    return render_codex_agent(definition, mapping, model_mapping, harness_layout)


def generate(target: str, source_root: Path, output_root: Path, check: bool) -> int:
    mapping_path = source_root / "definitions" / "tool-mapping.json"
    mapping = load_json(mapping_path)
    validate_mapping(mapping_path, mapping)
    model_mapping_path = source_root / "definitions" / "model-mapping.json"
    model_mapping = load_json(model_mapping_path)
    validate_model_mapping(model_mapping_path, model_mapping)
    harness_layout_path = source_root / "definitions" / "harness-layout.json"
    harness_layout = load_json(harness_layout_path)
    validate_harness_layout(harness_layout_path, harness_layout)
    plugin_metadata_path = source_root / "definitions" / "plugin-metadata.json"
    plugin_metadata = load_json(plugin_metadata_path)
    validate_plugin_metadata(plugin_metadata_path, plugin_metadata)
    definitions = load_definitions(source_root, mapping, model_mapping)
    mismatches: list[str] = []
    for definition in definitions:
        destination = output_path(target, output_root, definition)
        content = render(target, definition, mapping, model_mapping, harness_layout)
        if check:
            if not destination.is_file():
                mismatches.append(f"missing: {destination}")
            elif destination.read_text(encoding="utf-8") != content:
                mismatches.append(f"out of date: {destination}")
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")

    plugin_files = plugin_metadata_files(target, plugin_metadata)
    plugin_files.update(
        plugin_static_files(target, source_root, definitions, model_mapping, harness_layout)
    )
    for relative_path, content in sorted(plugin_files.items(), key=lambda item: str(item[0])):
        destination = output_root / relative_path
        if check:
            if not destination.is_file():
                mismatches.append(f"missing: {destination}")
            elif destination.read_bytes() != content:
                mismatches.append(f"out of date: {destination}")
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)

    if mismatches:
        print("generated definitions are not current:", file=sys.stderr)
        for mismatch in mismatches:
            print(f"  {mismatch}", file=sys.stderr)
        return 1
    action = "verified" if check else "generated"
    print(f"{action} {len(definitions)} definitions for {target} in {output_root}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=("claude", "codex"), required=True)
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="output plugin root (default: <source-root>/dist/<target>/ultracode)",
    )
    parser.add_argument("--source-root", type=Path, default=REPO_ROOT)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if target files are missing or differ; do not write files",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        source_root = args.source_root.resolve()
        output_dir = (
            args.output_dir.resolve()
            if args.output_dir is not None
            else source_root / "dist" / args.target / "ultracode"
        )
        return generate(
            args.target,
            source_root,
            output_dir,
            args.check,
        )
    except DefinitionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
