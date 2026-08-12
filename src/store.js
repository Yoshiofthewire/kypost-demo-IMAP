// In-memory mailbox and address-book state. Nothing is persisted: a restart or
// a reset returns every persona to its seed (spec section 2, "Stateless
// Persistence").

import { SEED, FOLDERS, seedMessages, vcardFor } from './seed.js';
import { createHash, randomUUID } from 'node:crypto';

export const PERSONAS = Object.keys(SEED);

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

// Clients disagree about where "Sent" lives. KyPost Server's SaveSent tries
// "Sent" first and would otherwise create a second, half-empty folder next to
// the one SMTP writes into, so every name that means the same tray is folded
// here — one lookup all callers route through.
const ALIASES = new Map(
  Object.entries({
    'inbox': 'INBOX',
    'sent': 'Sent Items',
    'sent items': 'Sent Items',
    'sent messages': 'Sent Items',
    'inbox/sent': 'Sent Items',
    'inbox.sent': 'Sent Items',
    'inbox/sent items': 'Sent Items',
    'inbox.sent items': 'Sent Items',
    'drafts': 'Drafts',
    'inbox/drafts': 'Drafts',
    'inbox.drafts': 'Drafts',
    'trash': 'Trash',
    'deleted items': 'Trash',
    'deleted messages': 'Trash',
    'inbox/trash': 'Trash',
    'inbox.trash': 'Trash',
    'archive': 'Archive',
    'all mail': 'Archive',
    'inbox/archive': 'Archive',
    'inbox.archive': 'Archive',
  })
);

export function canonFolder(name) {
  const raw = String(name || '').trim();
  return ALIASES.get(raw.toLowerCase()) || raw;
}

// A mailbox name arrives from the wire and is echoed into responses. Anything
// that could break the line-oriented protocol is refused rather than escaped.
export function validFolderName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\r\n\0"%*]/.test(name);
}

function newMailbox(name) {
  return { name, uidValidity: 1, uidNext: 1, messages: [] };
}

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

export function etagOf(body) {
  return '"' + createHash('sha1').update(body).digest('hex') + '"';
}

export function addMessage(persona, folderName, raw, flags = [], date = new Date()) {
  const name = canonFolder(folderName);
  let box = persona.folders.get(name);
  if (!box) {
    box = newMailbox(name);
    persona.folders.set(name, box);
  }
  const msg = {
    uid: box.uidNext++,
    flags: new Set(flags),
    date,
    raw: Buffer.isBuffer(raw) ? raw.toString('binary') : raw,
  };
  box.messages.push(msg);
  return msg;
}

// SMTP pushes a copy into Sent Items and KyPost Server APPENDs its own copy of
// the same message. Both are required behaviour, so the tray de-duplicates on
// Message-ID instead of showing the user the same mail twice.
export function messageId(raw) {
  const m = /^message-id:\s*(<[^>\r\n]*>)/im.exec(raw.slice(0, 8192));
  return m ? m[1].toLowerCase() : null;
}

export function addMessageDeduped(persona, folderName, raw, flags = [], date = new Date()) {
  const id = messageId(raw);
  if (id) {
    const box = persona.folders.get(canonFolder(folderName));
    const dup = box && box.messages.find((m) => messageId(m.raw) === id);
    if (dup) return dup;
  }
  return addMessage(persona, folderName, raw, flags, date);
}

class Store {
  constructor() {
    this.reset();
  }

  // Rebuilds each persona IN PLACE. A live IMAP session holds a reference to
  // its persona for the life of the connection, and KyPost Server keeps one
  // open indefinitely — swapping in fresh objects left that session reading and
  // writing an orphaned mailbox, so the reset appeared to succeed while doing
  // nothing for the only client that mattered.
  reset() {
    if (!this.personas) this.personas = new Map(PERSONAS.map((p) => [p, buildPersona(p)]));
    else for (const [key, existing] of this.personas) Object.assign(existing, buildPersona(key));
    this.resetCount = (this.resetCount || 0) + 1;
    return this.resetCount;
  }

  get(personaKey) {
    return this.personas.get(personaKey);
  }

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
    if (this.personaListener) this.personaListener(created);
    return created;
  }

  // The drip needs to know when a mailbox comes into existence. One listener is
  // all this needs; a full emitter would be more machinery than the job.
  onPersonaCreated(cb) {
    this.personaListener = cb;
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

  putContact(persona, uid, vcard) {
    const etag = etagOf(vcard);
    persona.contacts.set(uid, { uid, vcard, etag });
    persona.ctag++;
    return etag;
  }

  deleteContact(persona, uid) {
    const had = persona.contacts.delete(uid);
    if (had) persona.ctag++;
    return had;
  }
}

export const store = new Store();
export const newUid = () => randomUUID();
