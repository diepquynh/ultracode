# Philosophy

## Backstory

Every classic software-lifecycle problem has a classic fix: a code review, a QA pass, a design sign-off, a
second pair of eyes. Those fixes were built for teams. They assume an engineer who did not write the code can
review it, a tester who is not you, and an organization that enforces the steps so none get quietly skipped
at 11pm.

Working solo, or as one person carrying four projects, you inherit every problem and none of the headcount.
Discipline is the first thing to go, because nothing outside your own willpower holds the gate.

Ultracode gives each of those roles to a dedicated agent with a clean context and one job, plus an
orchestrator that runs them in order and does not let you skip the hard steps:

| Classic problem | How it bites when you work solo | The pipeline's answer |
| --- | --- | --- |
| Jumping to code before you understand the problem | No one challenges a wrong assumption before it is 400 lines deep | `explore` runs a grounded research pass first |
| A component nobody remembered | You are the single person in charge of all of it, so what you overlook is what breaks. Overlooking is a capacity problem, not a discipline problem | The scouted inventory lists the components, so routing does not depend on memory. `explore` breaks the request into atomic testable criteria |
| No design phase, so the architecture drifts | You are the architect, at 11pm, with no one to sanity-check the approach | `plan` returns a phased strategy with risks and success criteria, held for your approval |
| Nobody checks the plan before it becomes instructions | You approve your own spec, so a wrong assumption in it comes back as broken code | `fact-check` verifies every concrete claim a spec or plan makes against the repo before either reaches its approval gate |
| One change that has to land in five places | You mirror it four times and forget the fifth. The big changes, where forgetting costs most, are the ones too big to hold in your head | The spec records what each deliverable provides and consumes. Every plan phase carries its deliverable, its repo, and its dependencies, so the fifth edit is a phase with an owner, not something you have to remember |
| No code review | You cannot objectively review code you wrote an hour ago | `code-reviewer` checks every change against your repo's rules and loops until clean |
| Testing as an afterthought, cut under deadline | No QA net. Tests are the first thing dropped when you are the only one shipping | `execution-path-analyzer` enumerates the branches, then `write-test` covers one path per test. What gets skipped is decided at planning time, in writing, and only for phases with no branch to cover |
| Defects found late cost the most | A bug that surfaces three features later is one you alone still own | Per-phase review gates catch mistakes before they compound |
| Documentation debt | "I'll remember how this works" until six months later you do not | `module-documentation` refreshes the area references as the final step |
| The lesson you already learned once | The constraint that bit you in March bites again in September, because it was never written where a future session would look | Agents record repo-scoped lessons to a durable memory store and recall them before working in an area, and again after a failure with the error text as the query |
| Drift from your own conventions | No teammate says "we don't do it that way here" | Every stage routes off your repo's scouted conventions, so new code matches the old |

These are the problems the V-Model and every process after it were built to fix. Every one of those fixes
assumed a team.

## The missing guardrails

There is a hole in the table above. An orchestrator that holds a gate in prose is still a model reading a
sentence about a gate. That is the 11pm discipline problem again, one layer down. It holds right until there
is a plausible reason not to.

So the rules that matter do not live in a prompt. They are `PreToolUse` hooks that deny the tool call. A
model can talk itself past a sentence. It cannot talk itself past a denied tool call. One rule is a budget
rather than a safety rule: the review-loop cap. That one asks you instead of refusing. The harness prompts,
and the extra pass runs only if you say so.

| Rule | Enforced by |
| --- | --- |
| The spec is approved before `plan` runs. The plan is approved before `implement` runs | `pipeline-gate.js` |
| No approval is recorded without a `fact-check` `PASS` | the `ultracode_gate` MCP tool |
| A `BLOCKER` security finding cannot be waived, by the orchestrator or by you | `security-block.js` |
| Each leaf agent writes only inside its work `Repo root:` plus the primary session dir for reports. Phase path lists are hints, not allowlists | `spawn-scope.js` records the work repo and phase hints. `scope-guard.js` and `bash-scope-guard.js` hold the roots |
| Spec and plan files are never hand-edited. A change re-spawns the agent that owns the file | `artifact-guard.js` |
| The review loop stops auto-iterating at 3 passes. A 4th pass is offered to you, not taken | `review-cap.js` |
| A subagent that has failed its build 5 times in a row is refused the 6th and must hand back `STUCK:` | `build-streak.js` counts. `build-streak-gate.js` refuses |

That last rule came from counting. Across 912 recorded subagent runs, 15 of them (1.6%) hit a streak of four
or more consecutive build failures. Together those 15 burned 315M cache-read tokens, which was 10.7% of the
whole corpus's spend. The worst failed 14 times in a row over 237 tool calls, then kept going for 27 more.
Nothing in the pipeline noticed at the time. A loop nobody is counting spends your tokens on nothing.

This is also what makes the cheap tiers usable. The weaker the model you route `implement` to, the less of
the process can survive inside its prompt. So the process lives outside the prompt, and the model's job
narrows to the part it is good at. Because every handoff is a file in the session directory, what each agent
was told and what it returned stays open to inspection afterwards.

## The process the headcount was for

Ultracode runs that process for a single person. The orchestrator is the senior who walks the work through
each stage. The hooks are the organization that does not let a stage be quietly skipped at 11pm. The fan-out
gives every role a fresh, focused context instead of one tired brain wearing seven hats.

You do not get more headcount. You get the process the headcount was for.
