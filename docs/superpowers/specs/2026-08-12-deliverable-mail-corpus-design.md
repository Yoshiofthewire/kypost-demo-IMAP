# Deliverable mail corpus and injection — design

Date: 2026-08-12
Status: approved, not yet implemented

## Problem

Nothing can arrive in a mailbox after boot. `src/smtp.js` files every accepted
message into the sending persona's `Sent Items` and drops it; `src/seed.js`
fills the mailboxes once at start. There is no new-mail event anywhere in the
demo.

KyPost Server detects new mail on a poller tick and fans out a notification
from there. With a mailbox frozen at seed state, that path cannot be reached.
A reviewer holding the phone never sees a notification, because the demo has
no way to produce one.

A second, separate defect blocks running more than one tester. `resolvePersona`
(`src/store.js:19`) resolves any unrecognised username to `PERSONAS[0]`, so
thirty logins share Alice's single mailbox and read, flag and delete each
other's mail.

## Goals

- A person demoing the app, or reviewing it for an app store, can make mail
  arrive using only the app itself.
- Mail also arrives on its own, so a reviewer who does nothing still sees a
  notification.
- The corpus covers well-formed mail, valid crypto, broken crypto and
  malformed MIME.
- 25–30 concurrent testers each get their own mailbox.

## Non-goals

- No relay, no MX lookup, no recipient routing in `src/smtp.js`. The black hole
  stays unconditional.
- No phishing or spam content. "Bad" here means malformed or broken, not
  malicious. A demo account under app-store review should not contain
  simulated attacks.
- No persistence. Injected mail lives in memory and dies with a reset or a
  restart.

## Trigger surface

`src/deliver.js` matches on the lowercased local part of any recipient and
ignores the domain, so `Deliver-Crypto-Bad@ANYTHING` and
`deliver-crypto-bad@kypost-demo.local` behave the same. `store.forAddress`
(`src/store.js:151`) already lowercases the local part; this follows it.

| Address | Delivers | Exercises |
|---|---|---|
| `deliver-mail@` | One ordinary well-formed message | Poller sees new mail, notification fires |
| `deliver-crypto-good@` | Valid signature, valid encrypted message, well-formed `Autocrypt:` header | `pgpmail`, `autocrypt_harvest.go` success paths |
| `deliver-crypto-bad@` | Broken signature, unknown-key signature, truncated armor, garbage Autocrypt keydata | The same code's error paths |
| `deliver-mime-bad@` | Unclosed boundary, bogus charset, deep nesting, broken base64 | Parser robustness |
| `deliver-batch@` | One of each of the above | "Show me everything" in one tap |

Every trigger delivers to the **sending persona's own INBOX**. Mail it from
Alice, Alice receives it. No cross-persona routing and nothing to configure —
the notification lands on the device already in the reviewer's hand.

Each trigger delivers **one** message, chosen round-robin from its category, so
tapping the same trigger repeatedly walks through that category's cases rather
than repeating one. `deliver-batch@` is the exception: it delivers one message
from each category in a single burst.

Several triggers on one message fire once each. A message addressed to both a
trigger and an ordinary address still fires the trigger, and the ordinary
address is still black-holed.

The `deliver-` prefix reads as an instruction to the demo rather than as a
person, so it is not mistaken for a persona.

Enabled by default, no configuration. The demo publishes no mail ports, the
application allowlist rejects unknown peers before the TLS handshake, and
injection only ever writes canned corpus bytes into a sandbox persona's own
INBOX. It destroys nothing and reaches nothing real, so it does not need the
gate that `/admin/reset` has.

## Corpus

```
corpus/
  manifest.json
  plain-ordinary.eml
  plain-threaded.eml
  crypto-signed-valid.eml
  crypto-autocrypt-valid.eml
  crypto-sig-broken.eml
  crypto-armor-truncated.eml
  crypto-autocrypt-garbage.eml
  mime-boundary-unclosed.eml
  mime-charset-bogus.eml
  mime-base64-broken.eml
```

`manifest.json` is a flat array. Each entry names a file, its category, and
what KyPost is expected to do with it:

```json
{ "file": "crypto-sig-broken.eml",
  "category": "crypto-bad",
  "expect": "signature verification fails; message renders with a warning, not an error page" }
```

`expect` is documentation, not an assertion. It tells a reviewer or a future
test whether the demo is behaving. Adding a case means dropping in an `.eml`
and adding three lines — no code change.

Storing real `.eml` bytes on disk is what makes the malformed cases work: CRLF
and broken boundaries survive exactly as authored, with no template engine in
between.

### Rewritten on every injection

**`Message-ID`.** `addMessageDeduped` (`src/store.js:113`) de-duplicates on
`Message-ID` — the mechanism that keeps `Sent` and `Sent Items` a single tray.
Injecting a corpus file twice with its stored ID would silently drop the
second copy. Each delivery gets a fresh ID.

**`Date` and `INTERNALDATE`.** Both set to the moment of delivery. A message
dated when the `.eml` was authored sorts to the bottom and does not read as
new, which defeats the purpose. `INTERNALDATE` matters twice over: `go-imap`
hard-errors when it fails to parse one.

Everything else is delivered byte-for-byte.

## Dynamic personas

`store.forUser(name)` creates a persona on first sight, cloned from the seed
template, and caches it. `alice`, `bob` and `charlie` keep their bespoke seeds;
any other username gets a clone.

**Only IMAP LOGIN creates a persona.** Never an SMTP envelope.
`store.forAddress` resolves the authenticated login first and consults the
envelope sender only when the session never authenticated, so `MAIL FROM`
cannot conjure a mailbox, and neither can it reach one it does not own now that
every login has a mailbox of its own. Mailbox creation stays tied to an
authenticated login.

**`reset()` rebuilds dynamic personas in place; it does not delete them.** The
comment at `src/store.js:128` records why: a live session holds its persona
reference for the life of the connection, and KyPost Server keeps one open
indefinitely. Deleting a dynamic persona on reset would leave its open session
reading and writing an orphaned mailbox — the bug that comment was written
about. Dynamic personas get the same `Object.assign` treatment as seeded ones.

**Usernames are validated and capped.** Lowercased, `[a-z0-9._-]`,
length-limited, with a `MAX_PERSONAS` ceiling (default 100) on dynamically
created mailboxes. A server that accepts any login and allocates a seeded
mailbox per name is a memory-growth vector; a client looping through random
usernames would consume memory without bound. Past the cap, LOGIN is refused
rather than falling back to a shared mailbox — silently sharing is the defect
being fixed.

**Cloned mail is addressed to its owner.** The seed's `To:` headers say
`alice@kypost-demo.local`; on clone for `user17` they are rewritten to
`user17@kypost-demo.local`. Otherwise every tester sees mail addressed to
Alice, and recipient matching in KyPost sees the wrong address.

## Drip

`src/deliver.js` keeps one timer per live persona, firing at a random interval
between 15 and 30 minutes, staggered so thirty testers do not receive
notifications in the same second. Timers exist only for personas that exist —
someone has logged in — so an idle server delivers nothing.

Each tick delivers one message: 70% from the `plain` category, 30% from the
rest. Ambient mail should look like mail, with the broken cases as occasional
texture rather than half the inbox.

`DRIP_SECONDS` overrides the interval so the acceptance suite does not wait
fifteen minutes.

## Wiring

| File | Change |
|---|---|
| `src/deliver.js` | new — loads corpus, owns trigger table and drip timers, rewrites `Message-ID` and `Date`, calls `addMessageDeduped` |
| `src/smtp.js` | `deliver()` calls an injected `onAccepted({persona, rcpts})` after filing and dropping |
| `src/store.js` | `forUser` creates on first sight with validation and cap; `reset` rebuilds dynamic personas in place; clone rewrites `To:` |
| `src/index.js` | loads corpus at boot, passes `onAccepted` to the SMTP session, starts drip timers |
| `corpus/` | new — `.eml` files and `manifest.json` |

### Why the callback, and not a check inside `smtp.js`

AGENTS.md: *"No relay path in `src/smtp.js`. Accepting, filing into `Sent Items`
and dropping is the whole contract."* A magic address is recipient-dependent
behaviour, which is what that file must not contain.

With the callback, `src/smtp.js` gains four lines and still does not branch on
recipients, look them up, or change what it does with the payload. The black
hole stays unconditional: every message is filed and dropped regardless of
address. Corpus delivery is a separate event that a delivery happens to
trigger, and the invariant stays literally true.

An `if (rcpts.includes(TRIGGER))` inside `deliver()` was rejected: it makes the
black hole conditional, and a later reader cannot distinguish "check for a
trigger" from "relay" by reading the code.

## Error handling

The corpus is validated at boot: every manifest entry resolves to a real file,
every category is known, and every `.eml` parses far enough to find its
headers. A bad corpus is a startup failure naming the offending file — the same
posture as refusing to start with a weak reset token.

An unrecognised `deliver-*` address delivers nothing and is logged. The message
is still black-holed, unchanged.

Past `MAX_PERSONAS`, LOGIN returns `NO`.

## Verification

New tests in `test/acceptance/`:

- A trigger delivers to the sender's own INBOX; `DELIVER-Crypto-Bad@Whatever.Example`
  works, proving case and domain insensitivity
- The `Sent Items` copy still happens when a trigger fires — the black hole is
  unconditional
- Firing the same trigger twice yields two INBOX messages, not one, proving
  `Message-ID` regeneration
- `go-imap` parses `INTERNALDATE` for every corpus message
- Two different logins get two different mailboxes; a delete in one is
  invisible in the other
- A cloned persona's seed mail is addressed to that persona, not to Alice
- Login past `MAX_PERSONAS` is refused rather than sharing a mailbox
- `/admin/reset` reseeds a dynamic persona and stays visible to that persona's
  already-open session
- Corpus manifest integrity, as a plain unit check
- With `DRIP_SECONDS=1`, a logged-in persona receives ambient mail

## Known limitation

IDLE is advertised (`src/imap.js:12`) and stubbed (`src/imap.js:631`): it
records the tag, prints `+ idling`, and swallows input until `DONE`, without
ever sending an untagged `EXISTS`. A client sitting in IDLE will not learn
about injected mail until it polls.

This design does not fix that. KyPost Server polls on an interval, so the
notification path works without it. A client that depends on IMAP push will
not see injected mail promptly. Tracked separately as `ponytail:` in
`src/imap.js`; the upgrade path is a per-folder listener that sends untagged
`EXISTS`, `EXPUNGE` and `FETCH` to idling sessions, plus the same updates on
NOOP.
