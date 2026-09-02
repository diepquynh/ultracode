# Tested models

These are field notes, not benchmarks. They describe how the pipeline behaved per role and per model in real
sessions. Names resolve to whatever your Claude Code, Grok Build, or Codex backend serves, so treat these as
starting points for your own `models` block in `repo-profile.json`. The generated Grok defaults are `grok-4.5`
for the fast, balanced, advanced, and frontier tiers.

## Orchestrator

- **Opus 4.8/5.** The default choice. It pushes back hard when you give it false instructions, and it is the
  best senior to have around when a subagent gets stuck.
- **Grok 4.5.** Trained on Cursor's data, so it is almost fully compatible with the orchestrating workflow.
  The exception is backgrounded subagents: it tends to poll for subagent results instead of using Claude
  Code's notification system (Cursor polls too). Polling burns tokens on unnecessary tool calls, and hard
  rules stop helping once the main session context passes about 200k.
- **DeepSeek V4 Pro.** A cheaper Opus alternative, but it leans toward obeying a new instruction over
  fact-checking it. Hopefully the V4 Pro GA release fixes that.
- **DeepSeek V4 Flash 0731.** The fastest and cheapest orchestrator here. Its knowledge is weak on very
  complex problems, but it fact-checks new requests better than V4 Pro, with little to no hallucination past
  200k of context.

## Explorer / Planner

- **Opus 4.8/5.** Also the default. Exploration leans hard on deep domain knowledge, which is its strength.
  Its plans come out a little too verbose on instructions.
- **Sonnet 4.6/5.** The most balanced pick for exploration and planning, and very good at code scouting.
- **Grok 4.5.** Best at source-code exploration, though weak on domain understanding unless you hand it
  documents. Planning is very good and gives the clearest instructions. Its writing style is very close to
  Cursor's Plan mode.

## Implementer / Test writer

- **Opus 4.8/5.** Best as orchestrator, worst as implementer relative to its cheaper alternatives. Given
  plenty of phase context it still fact-checks logical tasks unnecessarily, which burns extra tool calls.
- **Grok 4.5.** The best Opus alternative for logical execution, even on the most complex tasks. Very good on
  UI work, and good at following instructions and using tools.
- **Sonnet 4.6/5.** Sometimes very good, sometimes overthinks and misses skill instructions. The worst choice
  for complex implementation past 200k of context, which is also why it is not used as an orchestrator.
- **DeepSeek V4 Pro.** Fast and good at following instructions, the best of these as a plain subagent, but
  weak on UI tasks and on debugging problems like missing dependencies.
- **DeepSeek V4 Flash 0731.** The fastest and cheapest of everything above. Its pre-0731 release hallucinated
  a lot even on simple tasks. The 0731 release fixed that.
- **GPT-5.6 Luna.** Near the cheapest, and very good as an implementer. A $20 ChatGPT Plus subscription gives
  you basically unlimited GPT-5.6 Luna tokens per week. Untested for frontend development.
- **MiniMax M3.** To get any work out of it you have to be very specific with your instructions, which is
  where Ultracode helps. Too short an instruction and it does essentially nothing. When it does work, it
  follows the instructions very well and writes good code. Untested for frontend development.

## Code reviewing

- **Opus 4.8/5 and Sonnet 4.6/5.** This is their strength: the most tokens burned and the most honest
  reviews. They even surface existing production bugs, which is technically outside the review scope but is
  sometimes the thing standing between a user and a purchase you never knew was broken.
- **DeepSeek V4 Pro / V4 Flash 0731.** Obeying instructions is their nature, so classic code review is no
  problem, and they do flag production bugs. They do not go as deep on library analysis as Sonnet or Opus.
