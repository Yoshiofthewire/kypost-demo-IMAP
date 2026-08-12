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
