# Tested models

Field notes, not benchmarks — this is what the pipeline actually felt like per role, per model. Names resolve
to whatever your Claude Code, Grok Build, or Codex backend serves, so treat these as starting points for your
own `models` block in `repo-profile.json`. Generated Grok defaults are `grok-4.6` for fast, balanced, and
advanced.

## Orchestrator

- **Opus 4.8/5** — the prime default. It'll kick your butt if you give it false instructions, and it's the best
  senior to have around when a subagent gets stuck.
- **Grok 4.5** — trained on Cursor's data, so it's almost fully compatible with the orchestrating workflow
  except for backgrounded subagents: it tends to *poll* for subagent results instead of using Claude Code's
  notification system (Cursor polls too). Polling burns tokens on unnecessary tool calls, and hard rules stop
  helping once the main session context passes ~200k.
- **DeepSeek V4 Pro** — a cheaper Opus alternative, but it leans toward obeying the request over fact-checking
  it when a new instruction arrives. Hopefully the V4 Pro GA release fixes that.
- **DeepSeek V4 Flash 0731** — fastest and cheapest orchestrator here. Its knowledge base isn't great on
  super-complex problems, but it fact-checks new requests better than V4 Pro, with little to no hallucination
  past 200k of context.

## Explorer / Planner

- **Opus 4.8/5** — also the prime default. Exploration leans hard on deep domain knowledge, which is its
  strength; planning comes out a little too verbose on instructions.
- **Sonnet 4.6/5** — the most balanced pick for exploration and planning, and very good at code scouting.
- **Grok 4.5** — best at source-code exploration, though weak on domain understanding unless you hand it
  documents. Planning is very good and gives the clearest instructions (its writing style feels suspiciously
  close to Cursor's Plan mode).

## Implementer / Test writer

- **Opus 4.8/5** — best as orchestrator, worst as implementer relative to its cheaper alternatives. Given plenty
  of phase context it still fact-checks logical tasks unnecessarily, which burns extra tool calls.
- **Grok 4.5** — the best Opus alternative for logical execution, even the most complex tasks. Very good on
  UI work, and good at following instructions and using tools.
- **Sonnet 4.6/5** — sometimes very good, sometimes overthinks and misses skill instructions. Worst choice for
  complex implementation past 200k of context (same reason it isn't used as an orchestrator).
- **DeepSeek V4 Pro** — fast and good at following instructions, the best of these as a plain subagent, but weak
  on UI tasks and on debugging problems like missing dependencies.
- **DeepSeek V4 Flash 0731** — fastest and cheapest of everything above. Its pre-0731 release hallucinated a lot
  even on simple tasks; 0731 fixed that.
- **GPT-5.6 Luna** - near-cheapest model, very good as an implementer. For $20 ChatGPT Plus subscription, you
  get basically unlimited GPT-5.6 Luna tokens per week. Untested for frontend development.
- **MiniMax M3** - for this guy to even do work, you have to be very specific with your instructions, which is
  what Ultracode comes in handy. Too short and it will essentially not do anything at all, but when it does, it
  also follows the instructions very well and good codes. Untested for frontend development.

## Code reviewing

- **Opus 4.8/5 and Sonnet 4.6/5** — this is their playground: the most tokens burned and the most honest
  reviews. They'll even surface existing production bugs — technically outside the review scope, but sometimes
  the thing standing between a user and a purchase you never knew was broken.
- **DeepSeek V4 Pro / V4 Flash 0731** — obeying instructions is their nature, so classic code review is no
  problem, and they do flag production bugs. They don't go as deep on library analysis as Sonnet or Opus.
