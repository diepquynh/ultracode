from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate_definitions.py"
CLAUDE_PLUGIN_ROOT = ROOT / "dist" / "claude" / "ultracode"
CODEX_PLUGIN_ROOT = ROOT / "dist" / "codex" / "ultracode"
BASELINE = json.loads((ROOT / "tests" / "claude-baseline.json").read_text(encoding="utf-8"))
TOOL_MAPPING = json.loads((ROOT / "definitions" / "tool-mapping.json").read_text(encoding="utf-8"))
MODEL_MAPPING = json.loads((ROOT / "definitions" / "model-mapping.json").read_text(encoding="utf-8"))
HARNESS_LAYOUT = json.loads(
    (ROOT / "definitions" / "harness-layout.json").read_text(encoding="utf-8")
)
LAYOUT_TOKEN_PATTERN = re.compile(
    r"\{\{[a-z][a-z0-9_]*\}\}"
)
COMMAND_NAMES = {
    "code-review",
    "epa",
    "explore",
    "generate-spec",
    "implement",
    "init-kit",
    "module-docs",
    "plan",
    "prompt-gen",
    "write-test",
}


def adapt_for_target(text: str, target_name: str) -> str:
    target = HARNESS_LAYOUT["layouts"][target_name]
    for token, value in {
        "{{state_dir}}": target["state_dir"],
        "{{runtime_dir}}": target["runtime_dir"],
        "{{skills_dir}}": target["skills_dir"],
        "{{agents_dir}}": target["agents_dir"],
        "{{plugin_root}}": f"${{{target['plugin_root_env']}}}",
        "{{arguments}}": "$ARGUMENTS"
        if target_name == "claude"
        else "the user's text following the explicit skill invocation",
        "{{command_prefix}}": "/" if target_name == "claude" else "$",
        "{{agent_selector}}": "subagent_type"
        if target_name == "claude"
        else "agent_type",
        "{{agent_tool}}": "Agent" if target_name == "claude" else "spawn_agent",
        "{{session_id_expr}}": "${CLAUDE_CODE_SESSION_ID:-${GROK_SESSION_ID:-no-session-id}}"
        if target_name == "claude"
        else "${CODEX_THREAD_ID:-no-session-id}",
        "{{session_id_source}}": "`CLAUDE_CODE_SESSION_ID`, else `GROK_SESSION_ID` (inherited unchanged)"
        if target_name == "claude"
        else "`CODEX_THREAD_ID`, falling back to `no-session-id` (inherited unchanged)",
        "{{session_id_names}}": "`CLAUDE_CODE_SESSION_ID`, else `GROK_SESSION_ID`"
        if target_name == "claude"
        else "`CODEX_THREAD_ID`, falling back to `no-session-id`",
        "{{reload_action}}": "running `/reload-plugins` or restarting the session"
        if target_name == "claude"
        else "starting a new Codex session",
        "{{balanced_model}}": MODEL_MAPPING["tiers"]["balanced"][target_name],
        "{{advanced_model}}": MODEL_MAPPING["tiers"]["advanced"][target_name],
    }.items():
        text = text.replace(token, value)
    return text


def adapt_for_codex(text: str) -> str:
    return adapt_for_target(text, "codex")


def run_generator(target: str, output: Path, check: bool = False) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        str(GENERATOR),
        "--target",
        target,
        "--output-dir",
        str(output),
    ]
    if check:
        command.append("--check")
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)


def run_generator_with_default_output(
    target: str, check: bool = False
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        str(GENERATOR),
        "--target",
        target,
    ]
    if check:
        command.append("--check")
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)


def split_frontmatter(path: Path) -> tuple[dict[str, object], str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise AssertionError(f"{path} has no YAML frontmatter")
    marker = text.find("\n---\n", 4)
    if marker < 0:
        raise AssertionError(f"{path} has unterminated YAML frontmatter")
    raw = text[4:marker]
    body = text[marker + len("\n---\n") :]
    if body.startswith("\n"):
        body = body[1:]

    metadata: dict[str, object] = {}
    folded_key: str | None = None
    folded_lines: list[str] = []
    for line in raw.splitlines():
        if line.startswith("  ") and folded_key:
            folded_lines.append(line.strip())
            continue
        if folded_key:
            metadata[folded_key] = " ".join(folded_lines)
            folded_key = None
            folded_lines = []
        key, value = line.split(":", 1)
        value = value.strip()
        if value == ">":
            folded_key = key
        elif key == "tools":
            metadata[key] = [item.strip() for item in value.split(",")]
        elif key == "argument-hint" and value.startswith('"'):
            metadata[key] = json.loads(value)
        else:
            metadata[key] = value
    if folded_key:
        metadata[folded_key] = " ".join(folded_lines)
    return metadata, body


def file_snapshot(root: Path) -> dict[str, bytes]:
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def source_definitions() -> list[tuple[Path, dict[str, object]]]:
    result = []
    for parent in ("agents", "skills", "commands"):
        for path in sorted((ROOT / parent).glob("*/definition.json")):
            result.append((path, json.loads(path.read_text(encoding="utf-8"))))
    return result


class DefinitionTests(unittest.TestCase):
    def test_every_definition_was_migrated(self) -> None:
        definitions = source_definitions()
        self.assertEqual(len(definitions), 22)
        self.assertEqual(
            {data["name"] for _, data in definitions if data["kind"] == "agent"},
            set(BASELINE["agents"]),
        )
        self.assertEqual(
            {data["name"] for _, data in definitions if data["kind"] == "skill"},
            set(BASELINE["skills"]),
        )
        self.assertEqual(
            {data["name"] for _, data in definitions if data["kind"] == "command"},
            COMMAND_NAMES,
        )
        for path, data in definitions:
            prompt = path.parent / str(data["prompt"])
            self.assertTrue(prompt.is_file())
            self.assertEqual(prompt.parent, path.parent)

    @unittest.skipUnless(importlib.util.find_spec("jsonschema"), "jsonschema is not installed")
    def test_sources_match_json_schema(self) -> None:
        import jsonschema

        schema = json.loads(
            (ROOT / "definitions" / "definition.schema.json").read_text(encoding="utf-8")
        )
        validator = jsonschema.Draft202012Validator(schema)
        for path, data in source_definitions():
            errors = sorted(validator.iter_errors(data), key=lambda error: list(error.path))
            self.assertEqual(errors, [], f"{path}: {[error.message for error in errors]}")

    def test_claude_generation_matches_pre_refactor_behavior(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir)
            result = run_generator("claude", output)
            self.assertEqual(result.returncode, 0, result.stderr)
            for kind, relative_parent in (("agents", "agents"), ("skills", "skills")):
                for name, expected in BASELINE[kind].items():
                    path = (
                        output / relative_parent / f"{name}.md"
                        if kind == "agents"
                        else output / relative_parent / name / "SKILL.md"
                    )
                    metadata, body = split_frontmatter(path)
                    self.assertEqual(metadata, expected["frontmatter"], str(path))
                    self.assertEqual(
                        hashlib.sha256(body.encode()).hexdigest(),
                        expected["body_sha256"],
                        str(path),
                    )
            for source_path, definition in source_definitions():
                if definition["kind"] != "command":
                    continue
                generated = output / "commands" / f"{definition['name']}.md"
                metadata, body = split_frontmatter(generated)
                self.assertEqual(
                    metadata,
                    {
                        "description": definition["description"],
                        "argument-hint": definition["config"]["argument_hint"],
                    },
                    str(generated),
                )
                source_body = (source_path.parent / definition["prompt"]).read_text()
                self.assertEqual(body, adapt_for_target(source_body, "claude"))

    def test_generation_is_deterministic_for_both_targets(self) -> None:
        for target in ("claude", "codex"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
                first = Path(first_dir)
                second = Path(second_dir)
                first_result = run_generator(target, first)
                second_result = run_generator(target, second)
                self.assertEqual(first_result.returncode, 0, first_result.stderr)
                self.assertEqual(second_result.returncode, 0, second_result.stderr)
                self.assertEqual(file_snapshot(first), file_snapshot(second))

    def test_neutral_sources_do_not_hardcode_a_harness_layout(self) -> None:
        neutral_files = [
            *ROOT.glob("agents/*/definition.json"),
            *ROOT.glob("agents/*/prompt.md"),
            *ROOT.glob("skills/*/definition.json"),
            *ROOT.glob("skills/*/prompt.md"),
            *ROOT.glob("commands/*/definition.json"),
            *ROOT.glob("commands/*/prompt.md"),
            *ROOT.glob("refs/*.md"),
        ]
        self.assertTrue(neutral_files)
        for path in neutral_files:
            content = path.read_text(encoding="utf-8")
            for concrete_term in (
                ".claude/",
                ".codex/",
                "${CLAUDE_PLUGIN_ROOT}",
                "${PLUGIN_ROOT}",
            ):
                self.assertNotIn(concrete_term, content, str(path))

    def test_generated_text_resolves_all_layout_tokens(self) -> None:
        for target, root in (
            ("claude", CLAUDE_PLUGIN_ROOT),
            ("codex", CODEX_PLUGIN_ROOT),
        ):
            with self.subTest(target=target):
                text_files = [
                    path
                    for path in root.rglob("*")
                    if path.is_file()
                    and path.suffix in {".md", ".toml", ".json", ".sh", ".py"}
                ]
                self.assertTrue(text_files)
                for path in text_files:
                    self.assertIsNone(
                        LAYOUT_TOKEN_PATTERN.search(path.read_text(encoding="utf-8")),
                        str(path),
                    )

    def test_codex_agents_are_valid_toml(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir)
            result = run_generator("codex", output)
            self.assertEqual(result.returncode, 0, result.stderr)
            for source_path, definition in source_definitions():
                name = str(definition["name"])
                if definition["kind"] in {"skill", "command"}:
                    metadata, body = split_frontmatter(output / "skills" / name / "SKILL.md")
                    self.assertEqual(metadata["name"], name)
                    self.assertTrue(
                        body.endswith(
                            adapt_for_codex(
                                (source_path.parent / definition["prompt"]).read_text()
                            )
                        )
                    )
                    if definition["kind"] == "command":
                        invocation_policy = (
                            output / "skills" / name / "agents" / "openai.yaml"
                        )
                        invocation_metadata = invocation_policy.read_text(encoding="utf-8")
                        self.assertIn("interface:\n", invocation_metadata)
                        self.assertIn("  display_name: ", invocation_metadata)
                        self.assertIn("  short_description: ", invocation_metadata)
                        self.assertIn(
                            "policy:\n  allow_implicit_invocation: false\n",
                            invocation_metadata,
                        )
                    continue
                generated = output / "agents" / f"{name}.toml"
                parsed = tomllib.loads(generated.read_text(encoding="utf-8"))
                expected_keys = {
                    "name",
                    "description",
                    "model_reasoning_effort",
                    "sandbox_mode",
                    "developer_instructions",
                }
                self.assertEqual(set(parsed), expected_keys)
                self.assertEqual(parsed["name"], name)
                self.assertEqual(
                    parsed["description"], adapt_for_codex(str(definition["description"]))
                )
                self.assertTrue(
                    parsed["developer_instructions"].endswith(
                        adapt_for_codex(
                            (source_path.parent / definition["prompt"]).read_text()
                        )
                    )
                )
                expected_sandbox = (
                    "workspace-write"
                    if {"edit", "write"}.intersection(definition["config"]["tools"])
                    else "read-only"
                )
                self.assertEqual(parsed["sandbox_mode"], expected_sandbox)

    def test_model_tiers_map_to_both_harnesses(self) -> None:
        self.assertEqual(
            MODEL_MAPPING["tiers"],
            {
                "fast": {"claude": "haiku", "codex": "gpt-5.6-luna"},
                "balanced": {"claude": "sonnet", "codex": "gpt-5.6-terra"},
                "advanced": {"claude": "opus", "codex": "gpt-5.6-sol"},
            },
        )
        for _, definition in source_definitions():
            if definition["kind"] == "agent":
                self.assertIn(definition["config"]["model_tier"], MODEL_MAPPING["tiers"])

    def test_tool_mapping_covers_declared_and_referenced_tools(self) -> None:
        capabilities = TOOL_MAPPING["capabilities"]
        source_terms = {
            term
            for capability in capabilities.values()
            for term in capability.get("source_terms", [])
        }
        declared_claude_tools: set[str] = set()
        for _, definition in source_definitions():
            if definition["kind"] != "agent":
                continue
            for capability_id in definition["config"]["tools"]:
                self.assertIn(capability_id, capabilities)
                entry = capabilities[capability_id]
                self.assertTrue(entry["claude"])
                self.assertTrue(entry["codex"])
                declared_claude_tools.add(entry["claude"])
        expected_declared = {
            tool
            for agent in BASELINE["agents"].values()
            for tool in agent["frontmatter"]["tools"]
        }
        self.assertEqual(declared_claude_tools, expected_declared)
        self.assertTrue(
            {"Agent", "Task", "AskUserQuestion", "EnterPlanMode"}.issubset(source_terms),
            "mapping must cover orchestration tool vocabulary used inside prompts",
        )

    def test_checked_in_claude_output_is_current(self) -> None:
        result = run_generator("claude", CLAUDE_PLUGIN_ROOT, check=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_checked_in_codex_output_is_current(self) -> None:
        result = run_generator("codex", CODEX_PLUGIN_ROOT, check=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_default_output_uses_nested_harness_plugin_root(self) -> None:
        for target, expected_root in (
            ("claude", CLAUDE_PLUGIN_ROOT),
            ("codex", CODEX_PLUGIN_ROOT),
        ):
            with self.subTest(target=target):
                result = run_generator_with_default_output(target, check=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(str(expected_root), result.stdout)

    def test_model_router_rewrites_and_honors_explicit_fallbacks(self) -> None:
        for target, expected in (("claude", "sonnet"), ("codex", "gpt-5.6-terra")):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temp_dir:
                repo = Path(temp_dir)
                runtime_dir = HARNESS_LAYOUT["layouts"][target]["runtime_dir"]
                profile_path = repo / runtime_dir / "repo-profile.json"
                profile_path.parent.mkdir(parents=True)
                profile = {
                    "models": {
                        "byAgent": {"code-reviewer": "balanced"},
                        "byPhaseComplexity": {},
                    }
                }
                profile_path.write_text(json.dumps(profile), encoding="utf-8")
                plugin_root = CLAUDE_PLUGIN_ROOT if target == "claude" else CODEX_PLUGIN_ROOT
                hook_input = {
                    "cwd": str(repo),
                    "tool_input": {
                        "subagent_type": "ultracode:code-reviewer",
                        "prompt": f"Repo root: {repo}",
                        "model": "wrong-model",
                    },
                }
                result = subprocess.run(
                    [sys.executable, str(plugin_root / "hooks" / "model-router.py")],
                    input=json.dumps(hook_input),
                    text=True,
                    capture_output=True,
                    env={**os.environ, "PLUGIN_ROOT": str(plugin_root)},
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                output = json.loads(result.stdout)["hookSpecificOutput"]
                self.assertEqual(output["updatedInput"]["model"], expected)
                if target == "codex":
                    self.assertEqual(output["permissionDecision"], "allow")

                profile["models"]["byAgent"]["code-reviewer"] = "inherit"
                profile_path.write_text(json.dumps(profile), encoding="utf-8")
                inherited = subprocess.run(
                    [sys.executable, str(plugin_root / "hooks" / "model-router.py")],
                    input=json.dumps(hook_input),
                    text=True,
                    capture_output=True,
                    env={**os.environ, "PLUGIN_ROOT": str(plugin_root)},
                    check=False,
                )
                self.assertEqual(inherited.returncode, 0, inherited.stderr)
                self.assertEqual(inherited.stdout, "")

                profile["models"]["byAgent"]["code-reviewer"] = "default"
                profile_path.write_text(json.dumps(profile), encoding="utf-8")
                defaulted = subprocess.run(
                    [sys.executable, str(plugin_root / "hooks" / "model-router.py")],
                    input=json.dumps(hook_input),
                    text=True,
                    capture_output=True,
                    env={**os.environ, "PLUGIN_ROOT": str(plugin_root)},
                    check=False,
                )
                self.assertEqual(defaulted.returncode, 0, defaulted.stderr)
                default_output = json.loads(defaulted.stdout)["hookSpecificOutput"]
                self.assertEqual(default_output["updatedInput"]["model"], expected)

                profile["models"]["byAgent"]["code-reviewer"] = {
                    "claude": "custom-claude-model",
                    "codex": "custom-codex-model",
                }
                profile_path.write_text(json.dumps(profile), encoding="utf-8")
                targeted = subprocess.run(
                    [sys.executable, str(plugin_root / "hooks" / "model-router.py")],
                    input=json.dumps(hook_input),
                    text=True,
                    capture_output=True,
                    env={**os.environ, "PLUGIN_ROOT": str(plugin_root)},
                    check=False,
                )
                self.assertEqual(targeted.returncode, 0, targeted.stderr)
                target_output = json.loads(targeted.stdout)["hookSpecificOutput"]
                self.assertEqual(
                    target_output["updatedInput"]["model"], f"custom-{target}-model"
                )

                del profile["models"]["byAgent"]["code-reviewer"]
                profile_path.write_text(json.dumps(profile), encoding="utf-8")
                missing = subprocess.run(
                    [sys.executable, str(plugin_root / "hooks" / "model-router.py")],
                    input=json.dumps(hook_input),
                    text=True,
                    capture_output=True,
                    env={**os.environ, "PLUGIN_ROOT": str(plugin_root)},
                    check=False,
                )
                self.assertEqual(missing.returncode, 0, missing.stderr)
                denied = json.loads(missing.stdout)["hookSpecificOutput"]
                self.assertEqual(denied["permissionDecision"], "deny")
                self.assertIn("no model route", denied["permissionDecisionReason"])

    def test_both_plugin_distributions_include_target_hooks(self) -> None:
        for target, root in (
            ("claude", CLAUDE_PLUGIN_ROOT),
            ("codex", CODEX_PLUGIN_ROOT),
        ):
            with self.subTest(target=target):
                hook_dir = root / "hooks"
                self.assertEqual(
                    {path.name for path in hook_dir.iterdir() if path.is_file()},
                    {"hooks.json", "model-router.py", "model-routing.json", "session-start.sh"},
                )
                config = json.loads((hook_dir / "hooks.json").read_text(encoding="utf-8"))
                self.assertIn("SessionStart", config["hooks"])
                self.assertIn("PreToolUse", config["hooks"])
                session_command = config["hooks"]["SessionStart"][0]["hooks"][0]["command"]
                self.assertTrue(session_command.startswith("bash "))
                routing = json.loads(
                    (hook_dir / "model-routing.json").read_text(encoding="utf-8")
                )
                self.assertEqual(routing["target"], target)
                self.assertEqual(
                    routing["runtime_dir"],
                    HARNESS_LAYOUT["layouts"][target]["runtime_dir"],
                )
                self.assertEqual(set(routing["tiers"]), set(MODEL_MAPPING["tiers"]))

    def test_codex_output_uses_codex_runtime_layout(self) -> None:
        text_files = [
            *CODEX_PLUGIN_ROOT.glob("agents/*.toml"),
            *CODEX_PLUGIN_ROOT.glob("skills/*/SKILL.md"),
            *CODEX_PLUGIN_ROOT.glob("refs/*.md"),
        ]
        self.assertTrue(text_files)
        for path in text_files:
            content = path.read_text(encoding="utf-8")
            self.assertNotIn(".claude/", content, str(path))
        orchestrate = (
            CODEX_PLUGIN_ROOT / "skills" / "orchestrate" / "SKILL.md"
        ).read_text(encoding="utf-8")
        self.assertIn(".codex/ultracode/repo-profile.json", orchestrate)
        inventory_reference = (
            CODEX_PLUGIN_ROOT / "refs" / "inventory-and-profile.md"
        ).read_text(encoding="utf-8")
        self.assertIn(".agents/skills", inventory_reference)
        explore_command = (
            CODEX_PLUGIN_ROOT / "skills" / "explore" / "SKILL.md"
        ).read_text(encoding="utf-8")
        self.assertIn("${CODEX_THREAD_ID:-no-session-id}", explore_command)
        self.assertIn("# $explore", explore_command)
        self.assertNotIn("$ARGUMENTS", explore_command)
        self.assertNotIn("subagent_type", explore_command)

    def test_codex_plugin_metadata_matches_plugin_identity(self) -> None:
        source_metadata = json.loads(
            (ROOT / "definitions" / "plugin-metadata.json").read_text(encoding="utf-8")
        )
        codex_manifest = json.loads(
            (CODEX_PLUGIN_ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
        )
        claude_manifest = json.loads(
            (CLAUDE_PLUGIN_ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")
        )
        self.assertEqual(codex_manifest["name"], source_metadata["name"])
        self.assertEqual(CODEX_PLUGIN_ROOT.name, source_metadata["name"])
        self.assertEqual(CLAUDE_PLUGIN_ROOT.name, source_metadata["name"])
        for field in ("name", "version", "description", "author", "license", "keywords"):
            self.assertEqual(codex_manifest[field], claude_manifest[field])
            self.assertEqual(codex_manifest[field], source_metadata[field])
        self.assertEqual(codex_manifest["skills"], "./skills/")
        self.assertEqual(codex_manifest["interface"]["displayName"], "Ultracode")

    def test_source_tree_has_no_generated_definition_leftovers(self) -> None:
        self.assertEqual(list((ROOT / "agents").glob("*.md")), [])
        self.assertEqual(list((ROOT / "skills").glob("*/SKILL.md")), [])
        self.assertEqual(list((ROOT / "commands").glob("*.md")), [])
        self.assertFalse((ROOT / ".claude-plugin").exists())


if __name__ == "__main__":
    unittest.main()
