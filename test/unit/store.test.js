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

// SMTP does not require AUTH before MAIL, and the envelope is attacker-chosen.
// If it outranked the login, anyone could file mail — and fire a deliver-*
// trigger — into a mailbox they do not own. The previous test cannot catch a
// regression here: its envelope names nobody, so both orderings agree.
test('forAddress prefers the authenticated login over the envelope sender', () => {
  const alice = store.forUser('alice');
  const bob = store.forUser('bob');
  assert.notEqual(alice, bob, 'test needs two distinct personas');
  assert.equal(store.forAddress('bob@kypost-demo.local', 'alice'), alice);
});

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
