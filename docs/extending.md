# Extending & publishing

## Extending to a new stack

Add `refs/<stack>.md` following the shape of `refs/java-spring.md`: detection signals, slicing strategy,
conventional commands, test framework, a component catalog (find pattern + invariants per type), conventions,
and review-rule seeds. Add a detection row to the initializer source prompt
(`agents/initializer/prompt.md`, Step D2), then regenerate the harness files. The `_generic.md` fallback handles
unknown stacks by discovering components empirically.

## Editing agents, plugin skills, and commands

Do not edit generated files under `dist/` directly — that tree is build output, regenerated on every install
and never committed, so edits there are lost. Follow
[Definition authoring](definitions.md): update the definition's JSON and prompt source, generate the Claude
Code and Codex distributions, and run the definition tests before publishing.

## Publish

Set an explicit `version` in `definitions/plugin-metadata.json` and bump it on every release (pushing commits
alone does not trigger updates for version-pinned installs). Regenerate both distributions. Validate the
Claude distribution with `claude plugin validate dist/claude/ultracode`. Also run
`node --test tests/test_definitions.test.js` to verify both generated harness formats.
