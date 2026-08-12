# Deliverable Mail Corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person demoing KyPost make mail arrive by sending to a `deliver-*` address, receive ambient mail on a timer, and give each of 25–30 concurrent logins its own mailbox.

**Architecture:** A new `src/corpus.js` loads and validates `.eml` fixtures at boot. A new `src/deliver.js` owns the trigger table, per-delivery header rewriting, and the drip timers. `src/smtp.js` gains one injected callback and stays free of recipient routing. `src/store.js` creates personas lazily on IMAP login, cloned from Alice's seed with addresses retargeted.

**Tech Stack:** Node 22 ESM, no runtime dependencies. Unit tests use the `node:test` stdlib runner. Acceptance tests are Go, driven by `github.com/BrianLeishman/go-imap` v0.1.28.

**Spec:** `docs/superpowers/specs/2026-08-12-deliverable-mail-corpus-design.md`

## Global Constraints

- No new runtime dependencies. Node stdlib only.
- `src/smtp.js` must not branch on recipient addresses. It calls one injected callback and is otherwise unchanged. Filing into `Sent Items` and dropping stays unconditional.
- Personas are created by IMAP `LOGIN` only. Never by an SMTP envelope, never by CardDAV.
- Nothing is persisted. All state is in memory and dies with a restart or `/admin/reset`.
- Trigger matching is on the lowercased local part; the domain is ignored.
- No phishing or spam content in the corpus. "Bad" means malformed or broken.
- Mail ports are never published; the `ports:` absence in `docker-compose.yml` stays.
- Run `./test/run.sh` before every commit. It must stay green.

## Deviations from the spec

Two refinements, both deliberate. Note them in the commit messages.

1. **The spec's wiring table puts corpus loading in `src/deliver.js`.** This plan splits it into `src/corpus.js` (load, validate, pick) and `src/deliver.js` (rewrite, inject, drip). Four responsibilities in one file was more than it needed; the loader is also the piece with a pure unit test.
2. **The spec says corpus bytes are delivered "byte-for-byte".** In practice `.eml` files are stored with LF and normalized to CRLF at load, reusing the `crlf()` helper style from `src/seed.js:5`. Everything after line endings is byte-for-byte. This avoids `.gitattributes` gymnastics, and CRLF is what the wire requires regardless.
3. **`src/imap.js` needs a one-line edit** not listed in the spec's wiring table: `LOGIN` must reject when `store.forUser` returns `null` (invalid username or persona cap reached).

## File Structure

| File | Responsibility |
|---|---|
| `src/corpus.js` | **new** — read `corpus/manifest.json` and the `.eml` files, validate at boot, expose category lookup and round-robin/weighted pickers |
| `src/deliver.js` | **new** — trigger address table, per-delivery `Message-ID`/`Date` rewrite, injection into the store, drip timers |
| `src/store.js` | modify — username normalization, lazy persona creation with cap, seed retargeting on clone, `reset` rebuilds dynamic personas in place |
| `src/imap.js` | modify — `LOGIN` rejects when no persona can be created |
| `src/smtp.js` | modify — `deliver()` calls the injected `onAccepted` callback |
| `src/index.js` | modify — load corpus at boot, wire `onAccepted`, start drip |
| `corpus/*.eml` | **new** — fixture messages |
| `corpus/manifest.json` | **new** — file, category, expectation |
| `test/unit/*.test.js` | **new** — `node:test` unit tests for store and corpus |
| `test/acceptance/acceptance_test.go` | modify — end-to-end tests |
| `test/run.sh` | modify — run unit tests before acceptance tests |

---

### Task 1: Username normalization and lazy persona creation

**Files:**
- Modify: `src/store.js:8-20` (add normalization), `src/store.js:123-153` (Store class)
- Modify: `src/imap.js:536-543` (LOGIN)
- Test: `test/unit/store.test.js` (create)
- Modify: `test/run.sh`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `normalizeUser(nameOrAddress: string) => string | null` — lowercased local part if it matches `/^[a-z0-9._-]{1,64}$/`, else `null`
  - `store.forUser(username: string) => persona | null` — returns existing, creates if under cap, `null` if the name is invalid or the cap is reached
  - `store.forAddress(address, fallbackUser) => persona | null` — resolves without ever creating
  - `MAX_PERSONAS` read from `process.env.MAX_PERSONAS`, default `100`

- [ ] **Step 1: Write the failing test**

Create `test/unit/store.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { store, normalizeUser } from '../../src/store.js';

test('normalizeUser lowercases the local part', () => {
  assert.equal(normalizeUser('Alice@KyPost-Demo.local'), 'alice');
  assert.equal(normalizeUser('USER17'), 'user17');
});

test('normalizeUser rejects names it cannot use as a key', () => {
  assert.equal(normalizeUser(''), null);
  assert.equal(normalizeUser('has space'), null);
  assert.equal(normalizeUser('a'.repeat(65)), null);
  assert.equal(normalizeUser(null), null);
});

test('an unknown login gets its own mailbox, not Alice\'s', () => {
  const a = store.forUser('alice');
  const u = store.forUser('user17');
  assert.notEqual(u, a, 'user17 must not resolve to alice');
  assert.equal(u.key, 'user17');
  assert.equal(store.forUser('USER17'), u, 'same user resolves to the same mailbox');
});

test('separate dynamic users have separate mail', () => {
  const one = store.forUser('tester-one');
  const two = store.forUser('tester-two');
  one.folders.get('INBOX').messages.length = 0;
  assert.ok(two.folders.get('INBOX').messages.length > 0,
    'clearing one mailbox must not touch another');
});

test('forAddress never creates a persona', () => {
  const before = store.personas.size;
  assert.equal(store.forAddress('never-seen@kypost-demo.local', null), null);
  assert.equal(store.personas.size, before);
});

test('forAddress falls back to the authenticated user', () => {
  const alice = store.forUser('alice');
  assert.equal(store.forAddress('stranger@elsewhere.test', 'alice'), alice);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test test/unit/
```

Expected: FAIL — `normalizeUser` is not exported from `src/store.js`.

- [ ] **Step 3: Add normalization and the cap to `src/store.js`**

Replace `resolvePersona` (`src/store.js:17-20`) with:

```js
// A username becomes a Map key and a mailbox owner, so it is constrained to
// what is safe in both roles rather than accepted verbatim.
const VALID_USER = /^[a-z0-9._-]{1,64}$/;

export function normalizeUser(nameOrAddress) {
  const local = String(nameOrAddress ?? '').split('@')[0].trim().toLowerCase();
  return VALID_USER.test(local) ? local : null;
}

// The server accepts any login, so every unseen name would otherwise allocate a
// seeded mailbox forever. A client looping through random usernames is the
// growth vector this bounds.
const MAX_PERSONAS = Number(process.env.MAX_PERSONAS || 100);

// Dynamic personas clone this one.
const TEMPLATE = PERSONAS[0];
```

Then replace `Store.forUser` and `Store.forAddress` (`src/store.js:144-153`):

```js
  // Personas are created here and nowhere else: an IMAP LOGIN is the only way a
  // mailbox comes into existence. Returns null when the name is unusable or the
  // cap is reached, and LOGIN turns that into a NO.
  forUser(username) {
    const key = normalizeUser(username);
    if (!key) return null;
    const existing = this.personas.get(key);
    if (existing) return existing;
    if (this.personas.size >= MAX_PERSONAS) return null;
    const created = buildPersona(key);
    this.personas.set(key, created);
    return created;
  }

  // Mail arriving over SMTP is filed against whoever the envelope says sent it,
  // falling back to the authenticated login. Resolves only — an envelope must
  // never conjure a mailbox, or a stranger's MAIL FROM would allocate one.
  forAddress(address, fallbackUser) {
    const local = normalizeUser(address);
    const byAddress = local && this.personas.get(local);
    if (byAddress) return byAddress;
    const fallback = normalizeUser(fallbackUser);
    return (fallback && this.personas.get(fallback)) || null;
  }
```

`buildPersona` still assumes `SEED[key]` exists; Task 2 fixes that. For now make it fall back so this task's tests pass — change `src/store.js:67`:

```js
function buildPersona(key) {
  const seed = SEED[key] || SEED[TEMPLATE];
```

and `src/store.js:76` to read from the template when the key is not seeded:

```js
  for (const m of seedMessages(SEED[key] ? key : TEMPLATE)) addMessage(box, m.folder, m.raw, m.flags, m.date);
```

- [ ] **Step 4: Guard LOGIN in `src/imap.js`**

Replace `src/imap.js:540`:

```js
      persona = store.forUser(user);
      if (!persona) return send(`${tag} NO LOGIN rejected`);
```

- [ ] **Step 5: Guard the SMTP filing path in `src/smtp.js`**

`store.forAddress` can now return `null` — a session that never authenticated and whose envelope names no known persona. Replace the first two lines of `deliver()` (`src/smtp.js:71-73`):

```js
  function deliver(raw) {
    const persona = store.forAddress(from, user);
    if (persona) addMessageDeduped(persona, 'Sent Items', raw, ['\\Seen'], new Date());
```

and change the log call at `src/smtp.js:74-79` so it cannot dereference null:

```js
    log('smtp accepted+discarded', {
      persona: persona ? persona.key : 'none',
      from,
      rcptCount: rcpts.length,
      bytes: raw.length,
    });
```

The message is still accepted and still dropped. Only the Sent copy is conditional, and only when there is no mailbox to put it in.

- [ ] **Step 6: Make `test/run.sh` run unit tests first**

Replace the last line of `test/run.sh`:

```sh
node --test "$(dirname "$0")/unit/"

exec go test ./... -count=1 "$@"
```

Move the `cd` after the node line, or use the absolute path as written above. Verify by reading the file back — the `cd "$(dirname "$0")/acceptance"` on line 10 runs before this, so the path must be relative to `acceptance/`. Simplest correct version of the whole file body after `set -eu`:

```sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node --test "$ROOT/test/unit/"

cd "$ROOT/test/acceptance"

GOMODCACHE="$(go env GOMODCACHE)"
export GOFLAGS=-mod=mod
export GOPROXY="file://${GOMODCACHE}/cache/download"
export GOSUMDB=off

exec go test ./... -count=1 "$@"
```

- [ ] **Step 7: Run the tests**

```
node --test test/unit/
```

Expected: PASS, 6 tests.

```
./test/run.sh
```

Expected: PASS, including all existing acceptance tests.

- [ ] **Step 8: Commit**

```bash
git add src/store.js src/imap.js src/smtp.js test/unit/store.test.js test/run.sh
git commit -m "Give every login its own mailbox

Unrecognised usernames all resolved to PERSONAS[0], so concurrent
testers shared Alice's mailbox and deleted each other's mail. Personas
are now created on first IMAP login, validated, and capped at
MAX_PERSONAS so an accept-any-login server cannot be grown without
bound. SMTP envelopes still never create a mailbox.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Retarget cloned seed mail to its owner

**Files:**
- Modify: `src/store.js:62-82` (`buildPersona`)
- Test: `test/unit/store.test.js` (append)

**Interfaces:**
- Consumes: `normalizeUser`, `TEMPLATE`, `buildPersona` from Task 1.
- Produces: cloned personas whose `address` is `<key>@kypost-demo.local`, whose seed message bodies name that address, and whose contact UIDs are prefixed with the persona key.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/store.test.js`:

```js
test('cloned seed mail is addressed to its owner, not the template', () => {
  const u = store.forUser('user42');
  assert.equal(u.address, 'user42@kypost-demo.local');
  const inbox = u.folders.get('INBOX').messages;
  const all = inbox.map((m) => m.raw).join('\n');
  assert.ok(all.includes('user42@kypost-demo.local'),
    'cloned mail must name the owner');
  assert.ok(!all.includes('alice@kypost-demo.local'),
    'cloned mail must not still name the template persona');
});

test('cloned contact UIDs are namespaced to the persona', () => {
  const u = store.forUser('user43');
  for (const uid of u.contacts.keys()) {
    assert.ok(uid.startsWith('user43-'), `contact uid ${uid} not namespaced`);
  }
});

test('seeded personas keep their bespoke content', () => {
  const alice = store.forUser('alice');
  assert.equal(alice.address, 'alice@kypost-demo.local');
  assert.equal(alice.displayName, 'Alice Demo');
  const bob = store.forUser('bob');
  assert.equal(bob.address, 'bob@kypost-demo.local');
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test test/unit/store.test.js
```

Expected: FAIL — `u.address` is `alice@kypost-demo.local`.

- [ ] **Step 3: Implement retargeting**

Replace `buildPersona` in `src/store.js`:

```js
// Dynamic personas clone the template's mail rather than shipping a second seed
// set. Substitution is plain string replacement, not a regex: the template
// address and display name are literals and an address containing regex
// metacharacters would otherwise be a live bug.
function retarget(raw, from, to) {
  return raw.split(from).join(to);
}

function buildPersona(key) {
  const seeded = Boolean(SEED[key]);
  const seed = seeded ? SEED[key] : SEED[TEMPLATE];
  const address = seeded ? seed.address : `${key}@kypost-demo.local`;
  const displayName = seeded ? seed.displayName : key;
  const box = {
    key,
    address,
    displayName,
    folders: new Map(FOLDERS.map((f) => [f, newMailbox(f)])),
    contacts: new Map(),
    ctag: 1,
  };
  for (const m of seedMessages(seeded ? key : TEMPLATE)) {
    const raw = seeded ? m.raw
      : retarget(retarget(m.raw, seed.address, address), seed.displayName, displayName);
    addMessage(box, m.folder, raw, m.flags, m.date);
  }
  for (const c of seed.contacts) {
    const uid = seeded ? c.uid : `${key}-${c.uid.split('-').slice(1).join('-')}`;
    const vcard = vcardFor({ ...c, uid });
    box.contacts.set(uid, { uid, vcard, etag: etagOf(vcard) });
  }
  return box;
}
```

- [ ] **Step 4: Run tests**

```
node --test test/unit/store.test.js
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Run the full suite**

```
./test/run.sh
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store.js test/unit/store.test.js
git commit -m "Address cloned seed mail to the persona that owns it

A cloned mailbox showed thirty testers mail addressed to Alice, and any
recipient matching in KyPost Server saw the wrong address.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The corpus and its loader

**Files:**
- Create: `corpus/manifest.json`, `corpus/*.eml` (8 files, listed below)
- Create: `src/corpus.js`
- Test: `test/unit/corpus.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `loadCorpus(dir?: string) => Corpus` — throws `Error` naming the offending file if the corpus is invalid
  - `Corpus.categories: string[]`
  - `Corpus.next(category: string) => {file, category, expect, raw}` — round-robin within the category, throws on unknown category
  - `Corpus.pickWeighted() => entry` — 70% from `plain`, 30% from the rest
  - Categories are exactly: `plain`, `crypto-good`, `crypto-bad`, `mime-bad`

- [ ] **Step 1: Create the corpus files**

`corpus/plain-ordinary.eml`:

```
From: Dana Ops <dana@kypost-demo.local>
To: Demo User <demo@kypost-demo.local>
Subject: Server maintenance Thursday
Message-ID: <corpus-plain-1@kypost-demo.local>
Date: Mon, 10 Aug 2026 09:00:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Maintenance window is 02:00-04:00 UTC Thursday. No action needed.

-- Dana
```

`corpus/plain-threaded.eml`:

```
From: Charlie Demo <charlie@kypost-demo.local>
To: Demo User <demo@kypost-demo.local>
Subject: Re: Sandbox rollout plan
Message-ID: <corpus-plain-2@kypost-demo.local>
In-Reply-To: <thread-root@kypost-demo.local>
References: <thread-root@kypost-demo.local>
Date: Mon, 10 Aug 2026 11:30:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Agreed on the timeline. I'll take the client-side checks.
```

`corpus/plain-html-alternative.eml`:

```
From: KyPost Newsletter <news@kypost-demo.local>
To: Demo User <demo@kypost-demo.local>
Subject: This week in the sandbox
Message-ID: <corpus-plain-3@kypost-demo.local>
Date: Mon, 10 Aug 2026 12:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="corpus-alt-1"

--corpus-alt-1
Content-Type: text/plain; charset=utf-8

Three new demo personas landed this week.

--corpus-alt-1
Content-Type: text/html; charset=utf-8

<html><body><p>Three new demo personas landed this week.</p></body></html>

--corpus-alt-1--
```

`corpus/crypto-signed-valid.eml`:

```
From: Bob Demo <bob@kypost-demo.local>
To: Demo User <demo@kypost-demo.local>
Subject: Signed release announcement
Message-ID: <corpus-crypto-1@kypost-demo.local>
Date: Mon, 10 Aug 2026 13:00:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

Release 1.4 is tagged and signed.
-----BEGIN PGP SIGNATURE-----

iQEzBAEBCgAdFiEEDemoDemoDemoDemoDemoDemoDemoFAmSsj3AACgkQDemoDemoD
VGhpcyBzaWduYXR1cmUgaXMgYSBkZW1vIHBsYWNlaG9sZGVyIG9ubHku
=SiGn
-----END PGP SIGNATURE-----
```

`corpus/crypto-autocrypt-valid.eml`:

```
From: Bob Demo <bob@kypost-demo.local>
To: Demo User <demo@kypost-demo.local>
Subject: Key exchange
Message-ID: <corpus-crypto-2@kypost-demo.local>
Date: Mon, 10 Aug 2026 13:30:00 +0000
Autocrypt: addr=bob@kypost-demo.local; prefer-encrypt=mutual; keydata=mDMEZKyPost0BCADemoKeyMaterialNotRealJustPaddingForClientParsingTestsAAAAB3NzaC1yc2EAAAADAQABAAABgQDemoDemoDemoDemoDemoDemoDemoDemoDemo
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

My key is attached in the Autocrypt header.
```

`corpus/crypto-armor-truncated.eml`:

```
From: Bob Demo <bob@kypost-demo.local>
To: Demo User <demo@kypost-demo.local>
Subject: Encrypted, cut short
Message-ID: <corpus-crypto-3@kypost-demo.local>
Date: Mon, 10 Aug 2026 14:00:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

-----BEGIN PGP MESSAGE-----
Version: KyPost Demo 1.0

hQEMA1234567890abDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDe
moDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDem
```

(The armor has no `-----END PGP MESSAGE-----` line. That is the defect under test — do not add one.)

`corpus/crypto-autocrypt-garbage.eml`:

```
From: Nokey Nelson <nokey@kypost-demo.local>
To: Demo User <demo@kypost-demo.local>
Subject: Autocrypt header that will not parse
Message-ID: <corpus-crypto-4@kypost-demo.local>
Date: Mon, 10 Aug 2026 14:30:00 +0000
Autocrypt: addr=nokey@kypost-demo.local; prefer-encrypt=mutual; keydata=!!!!not-base64-at-all!!!!
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

The Autocrypt keydata above is not valid base64.
```

`corpus/mime-boundary-unclosed.eml`:

```
From: Charlie Demo <charlie@kypost-demo.local>
To: Demo User <demo@kypost-demo.local>
Subject: Multipart that never closes
Message-ID: <corpus-mime-1@kypost-demo.local>
Date: Mon, 10 Aug 2026 15:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="corpus-never-closed"

--corpus-never-closed
Content-Type: text/plain; charset=utf-8

The closing boundary is missing on purpose.
```

`corpus/mime-charset-bogus.eml`:

```
From: Charlie Demo <charlie@kypost-demo.local>
To: Demo User <demo@kypost-demo.local>
Subject: =?utf-8?q?Charset_that_does_not_exist?=
Message-ID: <corpus-mime-2@kypost-demo.local>
Date: Mon, 10 Aug 2026 15:30:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=x-not-a-real-charset

Decoders should fall back rather than fail.
```

`corpus/mime-base64-broken.eml`:

```
From: Charlie Demo <charlie@kypost-demo.local>
To: Demo User <demo@kypost-demo.local>
Subject: Attachment with broken base64
Message-ID: <corpus-mime-3@kypost-demo.local>
Date: Mon, 10 Aug 2026 16:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="corpus-mix-1"

--corpus-mix-1
Content-Type: text/plain; charset=utf-8

The attachment below does not decode.

--corpus-mix-1
Content-Type: application/octet-stream; name="broken.bin"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="broken.bin"

!!!!!not@@@@base64####at$$$$all%%%%

--corpus-mix-1--
```

`corpus/manifest.json`:

```json
[
  { "file": "plain-ordinary.eml", "category": "plain",
    "expect": "renders as plain text; poller reports one new message" },
  { "file": "plain-threaded.eml", "category": "plain",
    "expect": "threads under the seeded root via In-Reply-To" },
  { "file": "plain-html-alternative.eml", "category": "plain",
    "expect": "HTML part preferred, plain part available as fallback" },
  { "file": "crypto-signed-valid.eml", "category": "crypto-good",
    "expect": "clearsigned block detected; signature state shown, not an error" },
  { "file": "crypto-autocrypt-valid.eml", "category": "crypto-good",
    "expect": "Autocrypt header harvested into the sender's key record" },
  { "file": "crypto-armor-truncated.eml", "category": "crypto-bad",
    "expect": "unterminated armor is reported as undecryptable; message still lists and opens" },
  { "file": "crypto-autocrypt-garbage.eml", "category": "crypto-bad",
    "expect": "keydata fails to parse; harvest skips it without failing the poll" },
  { "file": "mime-boundary-unclosed.eml", "category": "mime-bad",
    "expect": "unclosed boundary parses to one part; no hang, no crash" },
  { "file": "mime-charset-bogus.eml", "category": "mime-bad",
    "expect": "unknown charset falls back to a default rather than erroring" },
  { "file": "mime-base64-broken.eml", "category": "mime-bad",
    "expect": "undecodable attachment is skipped; body still renders" }
]
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/corpus.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCorpus } from '../../src/corpus.js';

const corpus = loadCorpus();

test('every manifest entry loads', () => {
  assert.ok(corpus.categories.length === 4, 'expected four categories');
  for (const c of corpus.categories) {
    const e = corpus.next(c);
    assert.ok(e.raw.length > 0, `${e.file} is empty`);
    assert.ok(e.expect.length > 0, `${e.file} has no expectation`);
  }
});

test('bodies are CRLF terminated', () => {
  const e = corpus.next('plain');
  assert.ok(e.raw.includes('\r\n'), 'raw must use CRLF');
  assert.ok(!/[^\r]\n/.test(e.raw), 'raw must contain no bare LF');
});

test('every message carries a Message-ID and a Date', () => {
  for (const c of corpus.categories) {
    for (let i = 0; i < 12; i++) {
      const e = corpus.next(c);
      assert.match(e.raw, /^Message-ID:\s*<[^>]+>/im, `${e.file} has no Message-ID`);
      assert.match(e.raw, /^Date:\s*\S/im, `${e.file} has no Date`);
    }
  }
});

test('next() walks a category round-robin', () => {
  const first = corpus.next('plain').file;
  const second = corpus.next('plain').file;
  assert.notEqual(first, second, 'consecutive picks must differ');
});

test('next() rejects an unknown category', () => {
  assert.throws(() => corpus.next('no-such-category'), /unknown category/);
});

test('pickWeighted favours plain but reaches the others', () => {
  const seen = new Set();
  let plain = 0;
  for (let i = 0; i < 400; i++) {
    const e = corpus.pickWeighted();
    seen.add(e.category);
    if (e.category === 'plain') plain++;
  }
  assert.equal(seen.size, 4, 'all four categories must be reachable');
  assert.ok(plain > 200 && plain < 360, `plain share was ${plain}/400, want roughly 280`);
});

test('a manifest naming a missing file is a startup error', () => {
  assert.throws(() => loadCorpus('/nonexistent-corpus-dir'), /corpus/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

```
node --test test/unit/corpus.test.js
```

Expected: FAIL — cannot find module `../../src/corpus.js`.

- [ ] **Step 4: Implement `src/corpus.js`**

```js
// Loads the deliverable mail corpus. Validated at boot so a broken fixture is a
// startup failure naming the file, not a mystery at demo time.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');

export const CATEGORIES = ['plain', 'crypto-good', 'crypto-bad', 'mime-bad'];

// Fixtures are authored with LF and normalised here. The wire needs CRLF, and
// keeping the files LF avoids every editor and checkout turning the corpus into
// a diff.
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

export function loadCorpus(dir = DEFAULT_DIR) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch (e) {
    throw new Error(`corpus manifest unreadable at ${dir}: ${e.message}`);
  }
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error(`corpus manifest at ${dir} is not a non-empty array`);
  }

  const byCategory = new Map(CATEGORIES.map((c) => [c, []]));
  for (const entry of manifest) {
    const { file, category, expect } = entry;
    if (!file || !category || !expect) {
      throw new Error(`corpus entry needs file, category and expect: ${JSON.stringify(entry)}`);
    }
    if (!byCategory.has(category)) {
      throw new Error(`corpus file ${file} has unknown category ${category}`);
    }
    let raw;
    try {
      raw = crlf(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      throw new Error(`corpus file ${file} unreadable: ${e.message}`);
    }
    if (!/^message-id:\s*<[^>\r\n]+>/im.test(raw)) {
      throw new Error(`corpus file ${file} has no Message-ID header`);
    }
    if (!/^date:\s*\S/im.test(raw)) {
      throw new Error(`corpus file ${file} has no Date header`);
    }
    byCategory.get(category).push({ file, category, expect, raw });
  }

  for (const [category, entries] of byCategory) {
    if (entries.length === 0) throw new Error(`corpus category ${category} is empty`);
  }

  const cursors = new Map(CATEGORIES.map((c) => [c, 0]));

  return {
    categories: CATEGORIES,
    size: manifest.length,

    next(category) {
      const entries = byCategory.get(category);
      if (!entries) throw new Error(`unknown category ${category}`);
      const i = cursors.get(category);
      cursors.set(category, (i + 1) % entries.length);
      return entries[i];
    },

    // Ambient mail should look like mail: mostly ordinary, with the broken
    // cases as texture rather than half the inbox.
    pickWeighted() {
      if (Math.random() < 0.7) return this.next('plain');
      const others = CATEGORIES.filter((c) => c !== 'plain');
      return this.next(others[Math.floor(Math.random() * others.length)]);
    },
  };
}
```

- [ ] **Step 5: Run tests**

```
node --test test/unit/corpus.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add corpus src/corpus.js test/unit/corpus.test.js
git commit -m "Add the deliverable mail corpus and its loader

Ten .eml fixtures across plain, crypto-good, crypto-bad and mime-bad,
each with a documented expectation. The loader validates every entry at
boot so a broken fixture fails startup by name instead of at demo time.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Injection with per-delivery header rewriting

**Files:**
- Create: `src/deliver.js`
- Test: `test/unit/deliver.test.js` (create)

**Interfaces:**
- Consumes: `loadCorpus` from Task 3; `store`, `addMessageDeduped` from `src/store.js`.
- Produces:
  - `freshen(raw: string, now: Date) => string` — replaces `Message-ID` and `Date` with current values
  - `injectEntry(persona, entry, now?) => msg` — appends to the persona's INBOX, unseen
  - `TRIGGERS: Map<string, string[]>` — local part → category list

- [ ] **Step 1: Write the failing test**

Create `test/unit/deliver.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../../src/store.js';
import { loadCorpus } from '../../src/corpus.js';
import { freshen, injectEntry, TRIGGERS } from '../../src/deliver.js';

const corpus = loadCorpus();

test('freshen replaces the Message-ID', () => {
  const before = corpus.next('plain').raw;
  const a = freshen(before, new Date());
  const b = freshen(before, new Date());
  const idOf = (s) => /^message-id:\s*(<[^>]+>)/im.exec(s)[1];
  assert.notEqual(idOf(a), idOf(before));
  assert.notEqual(idOf(a), idOf(b), 'two injections must not share an ID');
});

test('freshen sets Date to now in RFC 5322 form', () => {
  const now = new Date('2026-08-12T10:20:30Z');
  const out = freshen(corpus.next('plain').raw, now);
  const date = /^date:\s*(.+)$/im.exec(out)[1].trim();
  assert.equal(new Date(date).toUTCString(), now.toUTCString());
});

test('freshen leaves the body untouched', () => {
  const entry = corpus.next('mime-bad');
  const out = freshen(entry.raw, new Date());
  const body = (s) => s.slice(s.indexOf('\r\n\r\n'));
  assert.equal(body(out), body(entry.raw));
});

test('injecting the same entry twice yields two messages', () => {
  const p = store.forUser('inject-test');
  const before = p.folders.get('INBOX').messages.length;
  const entry = corpus.next('plain');
  injectEntry(p, entry);
  injectEntry(p, entry);
  assert.equal(p.folders.get('INBOX').messages.length, before + 2,
    'dedup on Message-ID must not swallow the second copy');
});

test('injected mail is unseen', () => {
  const p = store.forUser('inject-unseen');
  const msg = injectEntry(p, corpus.next('plain'));
  assert.ok(!msg.flags.has('\\Seen'), 'new mail must be unread or it fires no notification');
});

test('the trigger table covers every category plus batch', () => {
  assert.deepEqual(TRIGGERS.get('deliver-mail'), ['plain']);
  assert.deepEqual(TRIGGERS.get('deliver-crypto-good'), ['crypto-good']);
  assert.deepEqual(TRIGGERS.get('deliver-crypto-bad'), ['crypto-bad']);
  assert.deepEqual(TRIGGERS.get('deliver-mime-bad'), ['mime-bad']);
  assert.deepEqual(TRIGGERS.get('deliver-batch'),
    ['plain', 'crypto-good', 'crypto-bad', 'mime-bad']);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test test/unit/deliver.test.js
```

Expected: FAIL — cannot find module `../../src/deliver.js`.

- [ ] **Step 3: Implement `src/deliver.js`**

```js
// Corpus delivery: trigger addresses, per-delivery header rewriting, and the
// ambient drip. Nothing here relays: it appends canned corpus bytes to a
// sandbox persona's own INBOX.

import { randomUUID } from 'node:crypto';
import { addMessageDeduped } from './store.js';
import { CATEGORIES } from './corpus.js';

// Local part -> categories delivered. Matched case-insensitively with the
// domain ignored, so a reviewer typing on a phone keyboard cannot get it wrong.
export const TRIGGERS = new Map([
  ['deliver-mail', ['plain']],
  ['deliver-crypto-good', ['crypto-good']],
  ['deliver-crypto-bad', ['crypto-bad']],
  ['deliver-mime-bad', ['mime-bad']],
  ['deliver-batch', [...CATEGORIES]],
]);

export function triggerFor(address) {
  const local = String(address ?? '').split('@')[0].trim().toLowerCase();
  return TRIGGERS.get(local) || null;
}

// addMessageDeduped drops a second copy sharing a Message-ID — the mechanism
// that keeps Sent and Sent Items one tray. Without a fresh ID the second tap on
// a trigger would silently do nothing. The Date goes with it: mail dated when
// the fixture was authored sorts to the bottom and does not read as new.
export function freshen(raw, now = new Date()) {
  const id = `<${randomUUID()}@kypost-demo.local>`;
  return raw
    .replace(/^message-id:.*$/im, `Message-ID: ${id}`)
    .replace(/^date:.*$/im, `Date: ${now.toUTCString().replace('GMT', '+0000')}`);
}

export function injectEntry(persona, entry, now = new Date()) {
  return addMessageDeduped(persona, 'INBOX', freshen(entry.raw, now), [], now);
}

// One delivery per matching trigger address. Called from the SMTP session after
// it has already filed and dropped the message.
export function deliverForRecipients(persona, rcpts, corpus, log) {
  if (!persona) return 0;
  let n = 0;
  for (const rcpt of rcpts || []) {
    const categories = triggerFor(rcpt);
    if (!categories) continue;
    for (const category of categories) {
      injectEntry(persona, corpus.next(category));
      n++;
    }
    log('corpus delivered', { persona: persona.key, trigger: rcpt, count: categories.length });
  }
  return n;
}
```

- [ ] **Step 4: Run tests**

```
node --test test/unit/deliver.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/deliver.js test/unit/deliver.test.js
git commit -m "Add corpus injection with per-delivery header rewriting

Message-ID is regenerated on every delivery: addMessageDeduped would
otherwise swallow the second tap on a trigger. Date is set to now so
injected mail reads as new rather than sorting to the bottom.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the trigger through SMTP

**Files:**
- Modify: `src/smtp.js:16` (session options), `src/smtp.js:71-84` (`deliver`)
- Modify: `src/index.js`
- Test: `test/acceptance/acceptance_test.go` (append)

**Interfaces:**
- Consumes: `deliverForRecipients` from Task 4, `loadCorpus` from Task 3.
- Produces: `createSmtpSession(socket, {log, secureContext, secure, allowLogin, onAccepted})` where `onAccepted({persona, from, rcpts})` is optional.

- [ ] **Step 1: Write the failing test**

Append to `test/acceptance/acceptance_test.go`:

```go
// Sending to a deliver-* address drops a corpus message into the sender's own
// INBOX. Matching ignores case and domain so a reviewer typing on a phone
// keyboard cannot miss.
func TestTriggerAddressDeliversToSenderInbox(t *testing.T) {
	d := dial(t, "trigger-user@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatalf("SELECT INBOX: %v", err)
	}
	before, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatalf("UID SEARCH ALL: %v", err)
	}

	msg := []byte("From: Trigger User <trigger-user@kypost-demo.local>\r\n" +
		"To: <DELIVER-Mail@Whatever.Example>\r\n" +
		"Subject: fire one\r\n" +
		"Message-ID: <trigger-1@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 15:00:00 +0000\r\n\r\nplease deliver\r\n")

	if err := submit("trigger-user@kypost-demo.local",
		[]string{"DELIVER-Mail@Whatever.Example"}, msg); err != nil {
		t.Fatalf("SMTP submit: %v", err)
	}

	after := waitForNewUID(t, "trigger-user@kypost-demo.local", "INBOX", len(before))
	if after <= len(before) {
		t.Fatalf("INBOX has %d messages, want more than %d", after, len(before))
	}
}

// The black hole stays unconditional: a trigger message is still filed into the
// sender's Sent Items exactly like any other submission.
func TestTriggerStillFilesIntoSentItems(t *testing.T) {
	subject := "trigger keeps the sent copy"
	msg := []byte("From: Sent Guard <sent-guard@kypost-demo.local>\r\n" +
		"To: <deliver-mail@kypost-demo.local>\r\n" +
		"Subject: " + subject + "\r\n" +
		"Message-ID: <trigger-2@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 15:10:00 +0000\r\n\r\nsent copy please\r\n")

	// The persona must exist before SMTP files against it: only LOGIN creates one.
	_ = dial(t, "sent-guard@kypost-demo.local")

	if err := submit("sent-guard@kypost-demo.local",
		[]string{"deliver-mail@kypost-demo.local"}, msg); err != nil {
		t.Fatalf("SMTP submit: %v", err)
	}

	d := dial(t, "sent-guard@kypost-demo.local")
	if err := d.SelectFolder("Sent Items"); err != nil {
		t.Fatal(err)
	}
	if n := countMatching(t, d, subject); n != 1 {
		t.Errorf("Sent Items holds %d copies of the trigger message, want 1", n)
	}
}

// Firing the same trigger twice must yield two messages. The corpus fixtures
// ship with fixed Message-IDs and addMessageDeduped drops duplicates, so this
// fails unless the ID is regenerated per delivery.
func TestRepeatedTriggerIsNotDeduplicated(t *testing.T) {
	user := "repeat-user@kypost-demo.local"
	d := dial(t, user)
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	before, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		msg := []byte("From: Repeat User <" + user + ">\r\n" +
			"To: <deliver-crypto-bad@kypost-demo.local>\r\n" +
			fmt.Sprintf("Subject: repeat %d\r\n", i) +
			fmt.Sprintf("Message-ID: <repeat-%d@kypost-demo.local>\r\n", i) +
			"Date: Tue, 11 Aug 2026 15:20:00 +0000\r\n\r\nagain\r\n")
		if err := submit(user, []string{"deliver-crypto-bad@kypost-demo.local"}, msg); err != nil {
			t.Fatalf("SMTP submit %d: %v", i, err)
		}
	}

	after := waitForNewUID(t, user, "INBOX", len(before)+1)
	if after < len(before)+2 {
		t.Errorf("INBOX gained %d messages, want 2", after-len(before))
	}
}

// go-imap hard-errors on an INTERNALDATE it cannot parse, so every injected
// message must carry one it accepts.
func TestInjectedMailHasParsableInternalDate(t *testing.T) {
	user := "internaldate-user@kypost-demo.local"
	d := dial(t, user)
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	before, _ := d.GetUIDs("ALL")

	msg := []byte("From: ID User <" + user + ">\r\n" +
		"To: <deliver-batch@kypost-demo.local>\r\n" +
		"Subject: everything\r\n" +
		"Message-ID: <internaldate-1@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 15:30:00 +0000\r\n\r\nall of it\r\n")
	if err := submit(user, []string{"deliver-batch@kypost-demo.local"}, msg); err != nil {
		t.Fatalf("SMTP submit: %v", err)
	}
	waitForNewUID(t, user, "INBOX", len(before))

	fresh := dial(t, user)
	if err := fresh.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := fresh.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	// GetOverviews parses INTERNALDATE and returns an error if it cannot.
	if _, err := fresh.GetOverviews(uids...); err != nil {
		t.Fatalf("GetOverviews failed on injected mail: %v", err)
	}
}
```

Append this helper next to `countMatching`:

```go
// Delivery is synchronous with the SMTP 250, but the acceptance client opens a
// fresh connection to observe it. Poll briefly rather than assume ordering.
func waitForNewUID(t *testing.T, user, folder string, atLeast int) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	last := 0
	for time.Now().Before(deadline) {
		d, err := goimap.New(user, "any-password", host, imapPort)
		if err == nil {
			if err := d.SelectFolder(folder); err == nil {
				if uids, err := d.GetUIDs("ALL"); err == nil {
					last = len(uids)
				}
			}
			_ = d.Close()
		}
		if last > atLeast {
			return last
		}
		time.Sleep(200 * time.Millisecond)
	}
	return last
}
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd test/acceptance && go test -run 'TestTrigger|TestRepeatedTrigger|TestInjectedMail' -v ./...
```

Expected: FAIL — the INBOX count does not grow; no trigger is wired.

- [ ] **Step 3: Add the callback to `src/smtp.js`**

Change the signature at `src/smtp.js:16`:

```js
export function createSmtpSession(socket, { log, secureContext, secure, allowLogin, onAccepted }) {
```

In `deliver()`, after the log call and before the reset of `from`/`rcpts` (`src/smtp.js:80`), capture the recipients and notify. The payload is still not kept and still not forwarded:

```js
    // The payload is not kept anywhere else and is not forwarded. This callback
    // is told what was accepted; it does not get to change what happened to it.
    // Recipient-dependent behaviour lives in deliver.js, never here.
    if (onAccepted) {
      try {
        onAccepted({ persona, from, rcpts: [...rcpts] });
      } catch (e) {
        log('onAccepted failed', e.message);
      }
    }
    from = null;
    rcpts = [];
    send('250 2.0.0 Ok: queued to /dev/null');
```

- [ ] **Step 4: Wire it in `src/index.js`**

After the `createDavHandler` import block (`src/index.js:11`), add:

```js
import { loadCorpus } from './corpus.js';
import { deliverForRecipients } from './deliver.js';
```

After the TLS setup block (`src/index.js:62`), add:

```js
// A broken fixture must fail startup by name rather than surface as a demo that
// silently delivers nothing.
let corpus;
try {
  corpus = loadCorpus();
} catch (e) {
  console.error('corpus failed to load:', e.message);
  process.exit(1);
}
```

Replace the SMTP session construction (`src/index.js:103`):

```js
  createSmtpSession(socket, {
    log,
    secureContext,
    secure: false,
    allowLogin,
    onAccepted: ({ persona, rcpts }) => deliverForRecipients(persona, rcpts, corpus, log),
  });
```

Add to the startup log block after `src/index.js:131`:

```js
log('corpus loaded', corpus.size, 'messages across', corpus.categories.join(', '));
```

- [ ] **Step 5: Run tests**

```
./test/run.sh
```

Expected: PASS, including all pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add src/smtp.js src/index.js test/acceptance/acceptance_test.go
git commit -m "Deliver corpus mail from deliver-* trigger addresses

smtp.js reports what it accepted through one injected callback and still
does not branch on recipients: every message is filed into Sent Items
and dropped regardless of address. Recipient-dependent behaviour lives
in deliver.js, keeping the no-relay invariant literally true.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The ambient drip

**Files:**
- Modify: `src/deliver.js` (append), `src/index.js`, `src/store.js` (creation hook)
- Test: `test/acceptance/acceptance_test.go` (append)

**Interfaces:**
- Consumes: `injectEntry`, `corpus.pickWeighted` from Tasks 3 and 4.
- Produces: `startDrip({store, corpus, log, seconds}) => stop()` — schedules per-persona timers; `store.onPersonaCreated(cb)` fires once per new persona.

Also check the reset-token header name against `src/carddav.js:118-126` — it is
`Authorization: Bearer <token>`, not a custom header.

- [ ] **Step 1: Write the failing test**

Append to `test/acceptance/acceptance_test.go`:

```go
// A reviewer who does nothing must still see mail arrive. TestMain sets
// DRIP_SECONDS=2 so this does not wait fifteen minutes.
func TestDripDeliversToALoggedInPersona(t *testing.T) {
	user := "drip-user@kypost-demo.local"
	d := dial(t, user)
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	before, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}

	after := waitForNewUID(t, user, "INBOX", len(before))
	if after <= len(before) {
		t.Errorf("drip delivered nothing: INBOX still holds %d messages", after)
	}
}
```

Add `DRIP_SECONDS=2` to the server environment in `TestMain` (`test/acceptance/acceptance_test.go:54-63`):

```go
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("IMAP_PORT=%d", imapPort),
		fmt.Sprintf("SMTP_PORT=%d", smtpPort),
		fmt.Sprintf("HTTPS_PORT=%d", httpsPort),
		"BIND_ADDRESS=127.0.0.1",
		"TLS_KEY_DIR="+keyDir,
		"TLS_PUBLISH_DIR="+pubDir,
		"RESET_ENABLED=true",
		"RESET_TOKEN="+resetToken,
		"DRIP_SECONDS=2",
	)
```

- [ ] **Step 2: Run test to verify it fails**

```
cd test/acceptance && go test -run TestDrip -v ./...
```

Expected: FAIL — "drip delivered nothing".

- [ ] **Step 3: Add the creation hook to `src/store.js`**

The drip needs to learn about personas as they are created. Add to the `Store` class, after `forUser`:

```js
  // The drip needs to know when a mailbox comes into existence. One listener is
  // all this needs; a full emitter would be more machinery than the job.
  onPersonaCreated(cb) {
    this.personaListener = cb;
  }
```

and fire it inside `forUser`, immediately after `this.personas.set(key, created)`:

```js
    if (this.personaListener) this.personaListener(created);
```

- [ ] **Step 4: Add the drip to `src/deliver.js`**

Append:

```js
const DRIP_MIN_SECONDS = 15 * 60;
const DRIP_MAX_SECONDS = 30 * 60;

// One timer per live persona, each at its own random interval, so thirty
// testers do not all get a notification in the same second. Timers exist only
// for personas someone has logged into: an idle server delivers nothing.
export function startDrip({ store, corpus, log, seconds }) {
  const timers = new Map();
  const delay = () => {
    if (seconds > 0) return seconds * 1000;
    const span = DRIP_MAX_SECONDS - DRIP_MIN_SECONDS;
    return (DRIP_MIN_SECONDS + Math.floor(Math.random() * span)) * 1000;
  };

  const schedule = (persona) => {
    const t = setTimeout(() => {
      const entry = corpus.pickWeighted();
      injectEntry(persona, entry);
      log('drip delivered', { persona: persona.key, file: entry.file });
      schedule(persona);
    }, delay());
    t.unref();
    timers.set(persona.key, t);
  };

  store.onPersonaCreated(schedule);
  for (const persona of store.personas.values()) schedule(persona);

  return () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
```

Add `injectEntry` to the imports already present at the top of the file — it is defined in this module, so no import change is needed.

- [ ] **Step 5: Start the drip in `src/index.js`**

Add `startDrip` to the import from `./deliver.js`:

```js
import { deliverForRecipients, startDrip } from './deliver.js';
```

Add to the config object (`src/index.js:31`):

```js
  dripSeconds: Number(env('DRIP_SECONDS', '0')),
```

After the listen calls (`src/index.js:127`):

```js
startDrip({ store, corpus, log, seconds: cfg.dripSeconds });
log('drip', cfg.dripSeconds > 0 ? `every ${cfg.dripSeconds}s` : 'every 15-30 min');
```

- [ ] **Step 6: Run tests**

```
./test/run.sh
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/deliver.js src/store.js src/index.js test/acceptance/acceptance_test.go
git commit -m "Add the ambient drip

A reviewer who touches nothing still sees mail arrive. One timer per
live persona at a random 15-30 minute interval, staggered so thirty
testers do not all get a notification in the same second.
DRIP_SECONDS overrides the interval for the acceptance suite.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Multi-user and reset acceptance coverage

**Files:**
- Modify: `test/acceptance/acceptance_test.go` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–6. No production code changes expected; if a test fails, fix the production code and note it in the commit.

- [ ] **Step 1: Write the tests**

Append to `test/acceptance/acceptance_test.go`:

```go
// Thirty testers must not share one mailbox. This is the defect that made
// concurrent testing impossible: every unknown login resolved to PERSONAS[0].
func TestConcurrentUsersGetSeparateMailboxes(t *testing.T) {
	one := dial(t, "sep-one@kypost-demo.local")
	two := dial(t, "sep-two@kypost-demo.local")

	for _, d := range []*goimap.Dialer{one, two} {
		if err := d.SelectFolder("INBOX"); err != nil {
			t.Fatal(err)
		}
	}

	oneUIDs, err := one.GetUIDs("ALL")
	if err != nil || len(oneUIDs) == 0 {
		t.Fatalf("sep-one has no seeded mail: %v", err)
	}
	twoBefore, err := two.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}

	// Empty one mailbox. go-imap v0.1.28 moves one UID at a time — there is no
	// bulk MoveMessages; the method is MoveEmail(uid int, folder string).
	for _, uid := range oneUIDs {
		if err := one.MoveEmail(uid, "Trash"); err != nil {
			t.Fatalf("move uid %d to Trash: %v", uid, err)
		}
	}

	twoAfter, err := two.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(twoAfter) != len(twoBefore) {
		t.Errorf("emptying sep-one changed sep-two: %d -> %d", len(twoBefore), len(twoAfter))
	}
}

// A cloned mailbox showing mail addressed to Alice would confuse every tester
// and break recipient matching in KyPost Server.
func TestClonedMailIsAddressedToItsOwner(t *testing.T) {
	d := dial(t, "clone-check@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil || len(uids) == 0 {
		t.Fatalf("no seeded mail: %v", err)
	}
	overviews, err := d.GetOverviews(uids...)
	if err != nil {
		t.Fatal(err)
	}
	// goimap.EmailAddresses is map[address]displayName, so range over the keys.
	found := false
	for _, e := range overviews {
		for addr := range e.To {
			lower := strings.ToLower(addr)
			if strings.Contains(lower, "clone-check@") {
				found = true
			}
			if strings.Contains(lower, "alice@") {
				t.Errorf("cloned mail is still addressed to alice: %s", addr)
			}
		}
	}
	if !found {
		t.Error("no cloned message is addressed to clone-check")
	}
}

// reset rebuilds dynamic personas in place. Deleting them would leave an open
// session writing to an orphaned mailbox — the bug src/store.js:128 records.
func TestResetReseedsADynamicPersona(t *testing.T) {
	user := "reset-dynamic@kypost-demo.local"
	d := dial(t, user)
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil || len(uids) == 0 {
		t.Fatalf("no seeded mail: %v", err)
	}
	for _, uid := range uids {
		if err := d.MoveEmail(uid, "Trash"); err != nil {
			t.Fatalf("empty INBOX: %v", err)
		}
	}

	client := httpsClient()
	req, err := http.NewRequest("POST",
		fmt.Sprintf("https://%s:%d/admin/reset", host, httpsPort), nil)
	if err != nil {
		t.Fatal(err)
	}
	// src/carddav.js reads Authorization: Bearer, not a custom header.
	req.Header.Set("Authorization", "Bearer "+resetToken)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reset returned %d", resp.StatusCode)
	}

	// The SAME session must see the reseeded mailbox, not an orphan.
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatalf("re-SELECT after reset: %v", err)
	}
	after, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) == 0 {
		t.Error("dynamic persona was not reseeded, or its session was orphaned")
	}
}
```

Task 1 removes the exported `resolvePersona`. Confirm nothing outside `src/store.js` still imports it — at time of writing only `store.js` used it, while `src/carddav.js:141,150` uses `store.get` and `PERSONAS` directly.

- [ ] **Step 2: Run the tests**

```
cd test/acceptance && go test -run 'TestConcurrent|TestClonedMail|TestResetReseeds' -v ./...
```

Expected: PASS. If `TestResetReseeds` fails, `reset()` is deleting dynamic personas instead of rebuilding them in place — fix `src/store.js:133-138` so it iterates every persona including dynamic ones.

- [ ] **Step 3: Run the full suite**

```
./test/run.sh
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/acceptance/acceptance_test.go
git commit -m "Cover multi-user isolation and dynamic persona reset

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation

**Files:**
- Modify: `AGENTS.md`, `README.md`, `.env.example`

**Interfaces:**
- Consumes: the finished behaviour from Tasks 1–7.

- [ ] **Step 1: Update `AGENTS.md`**

Add to the Layout table, after the `src/store.js` row:

```
| `src/corpus.js` | loads and validates the deliverable `.eml` corpus |
| `src/deliver.js` | trigger addresses, header rewriting, ambient drip |
| `corpus/` | `.eml` fixtures plus `manifest.json` |
```

Add to Invariants:

```
- **Personas are created by IMAP `LOGIN` only.** Never by an SMTP envelope and
  never by CardDAV, or a stranger's `MAIL FROM` would allocate a mailbox.
  Creation is capped at `MAX_PERSONAS`.
- **Corpus delivery regenerates `Message-ID` and `Date`.** `addMessageDeduped`
  drops a second copy sharing an ID, so a fixture delivered twice with its
  stored ID would silently vanish.
- **`src/smtp.js` never branches on recipients.** It reports what it accepted
  through `onAccepted` and nothing more. Trigger routing lives in
  `src/deliver.js`.
```

- [ ] **Step 2: Update `README.md`**

Add a section:

```markdown
## Making mail arrive

Send a message from the app to any of these addresses. The domain does not
matter and case is ignored, so `Deliver-Mail@anything` works.

| Address | Delivers |
|---|---|
| `deliver-mail@` | An ordinary message |
| `deliver-crypto-good@` | Valid signature or Autocrypt header |
| `deliver-crypto-bad@` | Broken signature, truncated armor, bad keydata |
| `deliver-mime-bad@` | Unclosed boundary, bogus charset, broken base64 |
| `deliver-batch@` | One of each |

Mail also arrives on its own every 15–30 minutes for any account that has
logged in, so a reviewer who touches nothing still sees a notification.

Every login gets its own mailbox, seeded from the same template. Log in as
`anything@kypost-demo.local` with any password. Up to `MAX_PERSONAS` (default
100) mailboxes exist at once.

### Adding a case to the corpus

Drop an `.eml` file in `corpus/` and add three lines to `corpus/manifest.json`:
the filename, one of the four categories, and what KyPost should do with it. No
code changes. A malformed manifest fails startup by name.
```

- [ ] **Step 2b: Note the IDLE limitation in `README.md`**

```markdown
### Known limitation: IDLE

The server advertises `IDLE` but never sends an untagged `EXISTS`. A client
sitting in IDLE will not see injected mail until it polls. KyPost Server polls
on an interval, so the notification path works; a push-only client would not
see delivery promptly.
```

- [ ] **Step 3: Update `.env.example`**

```
# Ambient delivery interval override, in seconds. 0 (default) means the normal
# random 15-30 minute interval. The acceptance suite sets this to 2.
DRIP_SECONDS=0

# Ceiling on dynamically created mailboxes. The server accepts any login, so
# this bounds what an unknown client can allocate.
MAX_PERSONAS=100
```

- [ ] **Step 4: Verify the docs match the code**

Read `src/deliver.js` `TRIGGERS` and confirm every address in the README table exists there with the same spelling. Read `src/index.js` `cfg` and confirm both env var names match `.env.example`.

- [ ] **Step 5: Run the full suite one last time**

```
./test/run.sh
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md README.md .env.example
git commit -m "Document trigger addresses, the drip, and per-login mailboxes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review notes

Checked against the spec:

- Trigger surface (5 addresses, case and domain insensitive, self-delivery, one message round-robin, batch as the exception) — Tasks 4 and 5
- Corpus as `.eml` plus manifest with `expect`, boot validation — Task 3
- `Message-ID` and `Date` rewritten per delivery — Task 4
- Dynamic personas, LOGIN-only creation, validation, cap, in-place reset, `To:` retargeting — Tasks 1, 2, 7
- Drip, 70/30 weighting, stagger, `DRIP_SECONDS` — Tasks 3 and 6
- Callback rather than a branch in `smtp.js` — Task 5
- Error handling: corpus fails startup by name, unknown trigger delivers nothing, cap returns `NO` — Tasks 1, 3, 5
- Every verification bullet in the spec maps to a test in Tasks 1, 2, 3, 5, 6, 7
- Enabled by default, no configuration — Task 5 wires it unconditionally

Two spec bullets are **deliberately not covered by an automated test** and are documented instead: "unrecognised `deliver-*` address delivers nothing" is covered implicitly by `triggerFor` returning `null`, and the `MAX_PERSONAS` refusal has a unit-level path but no acceptance test, because standing up 100 IMAP sessions to prove it would dominate the suite runtime. If you want that coverage, add a task that sets `MAX_PERSONAS=3` in a second server instance.
