# Stack Reference: generic (fallback)

Used when no specific stack reference matches. Instead of a fixed component catalog, the scout infers
component types from the repo's own regularities. Author a proper `refs/<stack>.md` later and re-run
`/init-kit` for higher-quality skills. At the approval gate, choose **regenerate** for the existing
generic-derived skills so they are rebuilt from the new reference. A plain re-run reuses them as-is.

## Detection signals
- None matched cleanly. Record the dominant extension(s) and any manifest or build files found so a real
  reference can be authored later.

## Slicing
- Slice by top-level source directories. If the tree is flat, slice by the most common directory-name groups.

## Conventional commands
- Look for a `Makefile` (use its `build`, `test`, `lint`, and `fmt` targets), a `Justfile`, a `Taskfile.yml`,
  or CI config (`.github/workflows/*`, `.gitlab-ci.yml`) and copy the commands they actually run.
- If none exist, set commands to `null` and note this in the profile.

## Empirical component discovery
For the assigned slice:
1. **Suffix clustering.** List file base names and find recurring suffixes (`*Service`, `*Controller`,
   `*_handler`, `*Repository`, `*Model`, `*View`). Each recurring suffix is a candidate component type.
   ```bash
   ls {slice} | sed -E 's/\.[^.]+$//' | grep -oE '[A-Z][a-z]+$|_[a-z]+$' | sort | uniq -c | sort -rn | head
   ```
2. **Directory clustering.** Recurring directory names across slices (`handlers/`, `models/`, `services/`)
   name component types by convention.
3. **Import/annotation clustering.** The most frequently imported framework symbols or repeated
   annotation/decorator lines indicate the framework's building blocks.

For each candidate type, capture the same invariants any reference would: one exemplar, its structural
markers (base type, decorators, location), and a distilled template with placeholders.

## Conventions to look for
- Whatever a formatter or linter config enforces (`.editorconfig`, `.prettierrc`, `.rubocop.yml`, and similar).
- Naming regularities and error-handling patterns visible across exemplars.

## Review rule seeds
| ID | Rule | Severity | Auto-fixable |
| --- | --- | --- | --- |
| C1 | Violates the repo's own formatter/linter config | M | yes |
| S1 | Missing auth/validation on an externally reachable entry point | H | no |
| T1 | New public unit without a test (if the repo has tests) | M | no |
