# Follow-ups from the deliverable mail corpus branch

Findings that survived the final whole-branch review and its fix wave. None
block merge; all were adjudicated and parked deliberately rather than dropped.

## Done

**`store.forAddress`'s precedence change had no test.** Closed in 2abcca2:
`test/unit/store.test.js` now asserts `forAddress('bob@kypost-demo.local',
'alice')` returns alice. Confirmed non-vacuous by temporarily restoring the
envelope-first ordering — the new test fails alone, while the pre-existing
"falls back to the authenticated user" test passes under both orderings, which
is why the regression would otherwise have gone unnoticed.

## Smaller

**`forAddress`'s comment overstates the guarantee.** It says the envelope is
consulted "only when the session never authenticated". The branch is also taken
when the session authenticated with a name `normalizeUser` rejects — `allowLogin`
accepts any printable string, `normalizeUser` only `[a-z0-9._-]`. Given
universal authentication this grants nothing an attacker could not get by
logging in as the target, so it is a wording mismatch, not a hole.

**`DRIP_SECONDS` is clamped at the low end only.** `Math.max(1, …)` stops
`DRIP_SECONDS=0.05` from making a 50 ms per-persona loop, but a value above
`2^31-1` milliseconds wraps: Node warns `TimeoutOverflowWarning` and sets the
delay to 1 ms, producing the same hot loop from the other direction.
`Math.min(2 ** 31 - 1, …)` on the computed delay finishes the job.

**`README.md` overstates what the cap refuses.** "Once the cap is reached
further logins are refused for the life of the process" — logins to mailboxes
that already exist still succeed; only new names are refused. `test/unit/cap.test.js`
asserts exactly that, so the doc disagrees with the tested behaviour. "further
logins under new names" fixes it.

**`MAX_PERSONAS` is parsed in `src/store.js`, not with the rest of the config.**
Every other env var is parsed in `src/index.js`, which can `console.error` and
`exit(1)` cleanly. Because `store.js` is evaluated during ESM's static import
phase, a bad value surfaces as a stack trace instead. It fails closed and the
first `Error:` line names the variable and the value, so it is actionable —
but moving the parse into `index.js` and passing the number in would put all
config in one place and turn the cap test into a plain function call.

## Deferred from task reviews

- Nothing asserts the four deliberately broken corpus fixtures still contain
  their defects, so an editor pass that "fixes" one would silently remove the
  thing under test.
- `test/unit/corpus.test.js`'s weighting assertion is roughly nine sigma wide;
  it would not catch a regression from 70/30 to 55/45.
- `TestConcurrentUsersGetSeparateMailboxes` compares UID counts rather than UID
  sets, so an equal-and-opposite change would slip past.
- `store.onPersonaCreated` is a single-listener slot; a second consumer would
  silently clobber the drip's listener.
- `test/run.sh` globs unit tests because directory-form `node --test` fails on
  this machine's Node build; it errors if the directory ever empties.

## Known limitation, documented not fixed

IDLE is advertised and stubbed. A client sitting in IDLE does not learn about
injected mail until it polls. KyPost Server polls on an interval, so the
notification path works; a push-only client would not see delivery promptly.
The upgrade path is a per-folder listener sending untagged `EXISTS`, `EXPUNGE`
and `FETCH` to idling sessions, plus the same updates on NOOP.
