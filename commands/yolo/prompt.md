# ultracode — YOLO toggle (yolo)

This command does exactly one thing: read or flip **YOLO mode** for one primary ultracode session, through
one immediate hub call, then report the result and stop. It never runs pipeline work, never spawns agents,
and never touches `~/.ultracode` itself — the `ultracode_yolo_set` / `ultracode_yolo_status` tools are the
only interface (they travel over the MCP shim's HTTP transport to the hub daemon, which persists the state
in machine state and notifies every other participant through the message queue).

YOLO is the user's standing permission for **fully autonomous resolution during the implementation phases**:
with it on, the orchestrator and every child of the session — subagents, and hub-listen workers on other
harnesses — finish the approved plan unattended instead of parking on a review-cap question, the closing
gate, or a random formatting failure. It applies only **after** the plan is approved. It never waives spec or
plan approval, fact-check `PASS`es, or `BLOCKER` security findings.

If any hub tool answers "hub is not reachable", relay that to the user and stop — starting or repairing the
hub is theirs to do, not yours.

## Step 1 — Parse the request

`{{arguments}}` starts with one of `on`, `off`, or `status`; anything after that word is a free-text note to
record with the toggle (e.g. "finish D2 overnight"). No argument means `status`. Anything else: say the three
accepted forms and stop.

## Step 2 — Resolve the target session

- **This conversation already holds a hub registration** (an earlier `/ultracode:orchestrate`
  or `/ultracode:hub-listen` step registered it): reuse that `session_key`/`session_secret`
  and its session dir — the target is this session.
- **Otherwise** call `ultracode_session_query` with this repo's root (`$PWD`). Exactly one session listed →
  that is the target (the user is toggling the run they have going). Several → present them with
  **{{tool_ask_user}}** and let the user pick. None → the target is this session itself: derive its dir from
  the standard formula (`$PWD/{{runtime_dir}}/session/ultracode-session-{{session_id_expr}}`, `mkdir -p` it)
  so the toggle is already recorded when `/ultracode:orchestrate` starts here later.

## Step 3 — Execute, immediately

**`status`** → call `ultracode_yolo_status` with the target's `session_dir` (no registration needed). Report
and stop.

**`on` / `off`** → the setter requires a registered **participant**, so first, if this session is not yet
registered: `ultracode_session_register` with `harness`, this session's real session id (if
{{session_id_expr}} resolves to the `no-session-id` fallback, stop and tell the user — the hub refuses
anonymous registrations), `repo_roots` (`$PWD`), and `session_dir` = the target session's dir. If the target
dir is not this session's own derived dir, also `ultracode_session_adopt` it — adoption is what authorizes
this session to toggle a session it did not create. Then call `ultracode_yolo_set` with `enabled`
(`on` → true, `off` → false) and the note, plus `session_dir` when targeting an adopted session. That one
call is the whole toggle: the hub persists the state (keyed by the primary session, machine-level — not per
repo) and notifies every other registered participant through the message queue, waking parked listeners so
they apply the mode from their next task.

## Step 4 — Report and stop

Tell the user, briefly:

- The session's YOLO state now (and who last set it, for `status`), plus the `notified`/`woken` counts from
  the toggle — those are the orchestrator sessions and hub-listen workers that just learned about it.
- **On enable**: unattended runs will now auto-resolve implementation-phase friction — an extended
  review-loop budget instead of an approval question (and past it, the orchestrator itself resolves the open
  findings before one verification pass, rather than skipping ahead with a broken phase), recommended
  defaults at the closing gate, and genuinely blocked phases recorded while only **independent** work
  continues — and the completion report will list every finding, question, or stage that was deferred to
  the user. Spec approval, plan approval, fact-check, and `BLOCKER` security findings are unchanged. Flip
  back anytime with `/ultracode:yolo off`.
- **On disable**: the next spawn onward returns to interactive gating; anything a YOLO run already deferred
  is still listed in its reports.

Then finish the turn. Do not start orchestrating, claim tasks, or re-check the status you just set.

## Hard rules

1. **Only the user flips YOLO.** This command exists because they invoked it; never call `ultracode_yolo_set`
   from any other context on your own initiative, and never to get past a gate.
2. **One call, no polling.** The set/status call is immediate and complete — never follow it with heartbeats,
   re-reads, or a wait.
3. **Never operate the hub's machinery.** Its daemon, its `~/.ultracode` state (including the YOLO state
   files), and its bearer token are tool-owned; a hand-authored write there would forge the user's own
   permission switch, which is exactly what the write guards deny.
