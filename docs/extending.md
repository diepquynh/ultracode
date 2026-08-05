# Extending & publishing

## Extending to a new stack

Add `refs/<stack>.md` following the shape of `refs/java-spring.md`: detection signals, slicing strategy,
conventional commands, test framework, a component catalog (find pattern + invariants per type), conventions,
and review-rule seeds. Add a detection row to the initializer's detect-mode table (`agents/initializer.md`,
Step D2). The `_generic.md` fallback handles unknown stacks by discovering components empirically.

## Publish

Set an explicit `version` in `.claude-plugin/plugin.json` and bump it on every release (pushing commits alone
does not trigger updates for version-pinned installs). Validate before distributing:
`claude plugin validate .` (or `/plugin validate .` inside Claude Code).
