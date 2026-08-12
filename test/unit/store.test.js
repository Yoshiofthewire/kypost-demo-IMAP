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
