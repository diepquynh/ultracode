# Stack Reference — generic (fallback)

Used when no specific stack reference matches. Instead of a fixed component catalog, the scout infers
component types **empirically** from the repo's own regularities. Author a proper `refs/<stack>.md` later
and re-run `/init-kit` for higher-quality skills.

## Detection signals
- None matched cleanly. Record the dominant extension(s) and any manifest/build files found so a real
  reference can be authored later.

## Slicing
- Slice by top-level source directories. If flat, slice by the most common directory-name groups.

## Conventional commands
- Look for a `Makefile` (use its `build`/`test`/`lint`/`fmt` targets), a `Justfile`, a `Taskfile.yml`,
  or CI config (`.github/workflows/*`, `.gitlab-ci.yml`) and copy the commands they actually run.
- If none exist, set commands to `null` and note this in the profile.

## Empirical component discovery
For the assigned slice:
1. **Suffix clustering** — list file base-names; find recurring suffixes (`*Service`, `*Controller`,
   `*_handler`, `*Repository`, `*Model`, `*View`). Each recurring suffix is a candidate component type.
   ```bash
   ls {slice} | sed -E 's/\.[^.]+$//' | grep -oE '[A-Z][a-z]+$|_[a-z]+$' | sort | uniq -c | sort -rn | head
   ```
2. **Directory clustering** — recurring directory names across slices (`handlers/`, `models/`, `services/`)
   name component types by convention.
3. **Import/annotation clustering** — the most frequently imported framework symbols or repeated
   annotation/decorator lines indicate the framework's building blocks.

For each candidate type, capture the same invariants any reference would: one exemplar, its structural
markers (base type, decorators, location), and a distilled template with placeholders.

## Conventions to look for
- Whatever a formatter/linter config enforces (`.editorconfig`, `.prettierrc`, `.rubocop.yml`, etc.).
- Naming regularities and error-handling patterns visible across exemplars.

## Review rule seeds
| ID | Rule | Severity | Auto-fixable |
| --- | --- | --- | --- |
| C1 | Violates the repo's own formatter/linter config | M | yes |
| S1 | Missing auth/validation on an externally-reachable entry point | H | no |
| T1 | New public unit without a test (if the repo has tests) | M | no |
