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
