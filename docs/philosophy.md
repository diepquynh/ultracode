# The team you don't have

Every classic SDLC pain has a classic fix — a code review, a QA pass, a design sign-off, a second pair of
eyes. The catch is that those fixes were built *for teams*. They assume an engineer who didn't write the code
can review it, a tester who isn't you, and an org that enforces the steps so none get quietly skipped at 11pm.

Solo — or one person carrying four projects, which is the same thing with worse deadlines — you inherit every
pain and none of the headcount. Discipline is the first thing to go, because nothing outside your own willpower
is holding the gate.

Ultracode gives each of those roles to a dedicated agent — a clean context, one job — and an orchestrator that
runs them in order and won't let you skip the hard steps:

| Classic SDLC pain | Solo, it bites like this | The pipeline's answer |
| --- | --- | --- |
| Jumping to code before you understand the problem | No one to challenge a wrong assumption before it's 400 lines deep | `explore` runs a grounded research pass first |
| A component nobody remembered | You're the single PIC for all of it, so what you overlook is what breaks — and overlooking is not a discipline problem, it's a capacity one | the scouted inventory enumerates the components so routing doesn't run on recall, and `explore` breaks the request into atomic testable criteria |
| No design phase, so the architecture drifts | You're the architect, at 11pm, with no one to sanity-check the approach | `plan` returns a phased strategy with risks and success criteria, held for your approval |
| Nobody checks the plan before it becomes instructions | You approve your own spec, so a wrong assumption in it is one you'll only meet again as broken code | `fact-check` verifies every concrete claim a spec or plan makes against the repo before either reaches its approval gate |
| One change that has to land in five places | You mirror it four times and forget the fifth — and the big changes, where forgetting costs most, are exactly the ones too big to hold in your head | the spec records what each deliverable provides and consumes, and every plan phase carries its deliverable, its repo, and its dependency set — so the fifth edit is a phase with an owner, not something you have to remember |
| No code review — the one a solo dev can't fake | You can't objectively review code you wrote an hour ago | `code-reviewer` gates every change against *your* repo's rules, looping until clean |
| Testing as an afterthought, cut under deadline | No QA net; tests are the first thing dropped when you're the only one shipping | `execution-path-analyzer` enumerates the branches, then `write-test` covers one path per test — coverage becomes systematic, not optional. What gets skipped is decided at planning time, in writing, and only for phases with no branch to cover — not at 11pm by whoever is tired |
| Defects found late cost the most to fix | A bug surfacing three features later is one you alone still own | per-phase review gates catch mistakes before they compound downstream |
| Documentation debt | "I'll remember how this works" — until six months later you don't | `module-documentation` refreshes the area references automatically as the final step |
| The lesson you already learned once | The constraint that bit you in March bites again in September, because it never got written anywhere a future session would look | agents record repo-scoped lessons to a durable memory store, and recall them before working an area — and again, with the error text as the query, after a failure |
| Drift from your own conventions | No teammate to say "we don't do it that way here" | every stage routes off your repo's scouted conventions, so new code matches the old |

These are the pains the V-Model and every process after it were built to fix — and every one of those fixes
assumed a team.

## A gate nobody enforces isn't a gate

There's a hole in the table above, and it's worth naming: an orchestrator that holds a gate *in prose* is still
a model reading a sentence about a gate. That's your 11pm discipline problem again, one layer down — it holds
right until there's a plausible reason not to.

So the rules that matter don't live in a prompt. They're `PreToolUse` hooks that deny the call outright. A model
can talk itself past a sentence; it can't talk itself past a denied tool call.

| Rule | Enforced by |
| --- | --- |
| The spec is approved before `plan` runs; the plan is approved before `implement` does | `pipeline-gate.js` |
| No approval is recorded at all without a `fact-check` `PASS` | the `ultracode_gate` MCP tool |
| A `BLOCKER` security finding can't be waived — not by the orchestrator, not by you | `security-block.js` |
| Each subagent writes only inside the scope its own plan phase declared, shell writes included | `spawn-scope.js` records it; `scope-guard.js` and `bash-scope-guard.js` hold it |
| Spec and plan files are never hand-edited — a change re-spawns the agent that owns the file | `artifact-guard.js` |
| The review loop caps at 3 iterations instead of spinning | `review-cap.js` |
| A subagent that has failed its build 5 times running is refused the 6th and must hand back `STUCK:` | `build-streak.js` counts; `build-streak-gate.js` refuses |

That last one came out of counting rather than taste. Across 912 recorded subagent runs, 15 of them — 1.6% —
hit a streak of four or more consecutive build failures, and together those 15 burned 315M cache-read tokens:
10.7% of the entire corpus's spend. The worst failed 14 times in a row over 237 tool calls, then kept going for
27 more. Nothing in the pipeline noticed at the time. Your tokens are an asset, and a loop nobody is counting spends them on
nothing.

This is also what makes the cheap tiers usable at all. The weaker the model you route `implement` to, the less
of the process can survive inside its prompt — so the process lives outside it, and the model's job narrows to
the part it's actually good at. And because every handoff is a file in the session directory, what each agent
was told and what it returned stays open to inspection afterwards, rather than something you take on faith.

## The process the headcount was for

Ultracode runs that process for a single person. The orchestrator is the senior who walks the work through each
stage; the hooks are the org that won't let a stage be quietly skipped at 11pm; and the fan-out hands every role
a fresh, focused context instead of one tired brain wearing seven hats.

You don't get more headcount — you get the process the headcount was for.
