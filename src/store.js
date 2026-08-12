// In-memory mailbox and address-book state. Nothing is persisted: a restart or
// a reset returns every persona to its seed (spec section 2, "Stateless
// Persistence").

import { SEED, FOLDERS, seedMessages, vcardFor } from './seed.js';
import { createHash, randomUUID } from 'node:crypto';

export const PERSONAS = Object.keys(SEED);

// KyPost Server picks the persona and hands it over as the login username. We
// only map that name onto a seeded mailbox; we never invent a persona from an
// arbitrary string beyond this table (spec section 4A, "Persona Ownership").
//
// Exact match on the local part, not a substring search: "bob@alice-corp.test"
// contains "alice" and used to resolve to her mailbox while SMTP filed the same
// session's Sent copy under bob. One rule, used by both.
export function resolvePersona(nameOrAddress) {
  const local = String(nameOrAddress || '').split('@')[0].trim().toLowerCase();
  return PERSONAS.includes(local) ? local : PERSONAS[0];
}

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

function buildPersona(key) {
  const seed = SEED[key];
  const box = {
    key,
    address: seed.address,
    displayName: seed.displayName,
    folders: new Map(FOLDERS.map((f) => [f, newMailbox(f)])),
    contacts: new Map(),
    ctag: 1,
  };
  for (const m of seedMessages(key)) addMessage(box, m.folder, m.raw, m.flags, m.date);
  for (const c of seed.contacts) {
    const vcard = vcardFor(c);
    box.contacts.set(c.uid, { uid: c.uid, vcard, etag: etagOf(vcard) });
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

  forUser(username) {
    return this.get(resolvePersona(username));
  }

  // Mail arriving over SMTP is filed against whoever the envelope says sent it,
  // falling back to the authenticated login.
  forAddress(address, fallbackUser) {
    const local = String(address || '').split('@')[0].toLowerCase();
    return PERSONAS.includes(local) ? this.get(local) : this.forUser(fallbackUser);
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
