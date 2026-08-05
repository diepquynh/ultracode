# Agents

Every agent is registered under the plugin's `ultracode:` namespace, so its **`subagent_type` is the prefixed
name** — `ultracode:explore`, not `explore`. The prefix keeps `explore` and `plan` from colliding with Claude
Code's built-in `Explore` and `Plan` agents, which are not ultracode agents and do not follow this pipeline.
Spawn the names below verbatim.

| Agent (`subagent_type`) | Role |
| --- | --- |
| `ultracode:initializer` | Detect stack → scout patterns (parallel) → propose → generate skills (parallel) + inventory. |
| `ultracode:explore` | Research a topic; write a grounded research document plus a criteria document breaking the request into atomic testable criteria. |
| `ultracode:generate-spec` | Merge the criteria and research into one SDD spec file (EARS + Given/When/Then), with its deliverables in build order and its provided/consumed contracts. |
| `ultracode:plan` | Design a phased, verifiable implementation plan from the spec file alone — one agent per request. |
| `ultracode:implement` | Write code per a plan/phase; report changes; escalate via HANDOFF/STUCK. |
| `ultracode:code-reviewer` | Review changes against the repo's Review Rule Set; emit JSON findings. |
| `ultracode:execution-path-analyzer` | Enumerate execution paths per function to drive test writing. |
| `ultracode:write-test` | Write one test per new execution path, using the repo's test framework. |
| `ultracode:module-documentation` | Update area references under `skills/module-hub/references/`. |
| `ultracode:prompt-generation` | Author/edit prompts, skills, and agent files via the meta-author standard. |

The prefix comes from the plugin loader, which registers each agent as `{plugin}:{frontmatter name}`. Agent
files therefore keep a **bare** `name:` in their front matter — writing `name: ultracode:explore` would register
it as `ultracode:ultracode:explore`. The same holds for `repo-profile.json`'s `models` keys, which stay bare.

## Re-using existing skills

Re-running `/init-kit` — or running it the first time in a repo that already ships hand-authored skills — does
**not** clobber what's there. During **detect** the initializer discovers every skill already under
`.claude/skills/`. In **propose** each is marked `status: existing` and, by default, **re-used as-is**: kept
on disk and registered in `INVENTORY.md`, never regenerated.

At the approval gate you can override per skill and force a **regenerate** to refresh a stale one from the
current code. Bespoke skills the team wrote — ones that map to no scouted component type (say a `deploy` or
`db-migration` skill) — are folded into the routing inventory too, so the pipeline can load them.

The upshot: re-scans are idempotent — your manual edits to a skill survive, and only the skills you explicitly
ask to (re)generate are rewritten.
