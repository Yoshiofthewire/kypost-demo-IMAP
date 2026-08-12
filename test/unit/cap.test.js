import test from 'node:test';
import assert from 'node:assert/strict';

// MAX_PERSONAS is read once, when store.js is evaluated, so every case here
// sets the environment first and then imports. The query string defeats the
// module cache when a case needs a second, differently configured copy.
const CAP = 6;
process.env.MAX_PERSONAS = String(CAP);
const { store, PERSONAS } = await import('../../src/store.js');

test('logins are refused once the cap is reached', () => {
  assert.equal(store.personas.size, PERSONAS.length, 'seeded personas count towards the cap');
  for (let i = store.personas.size; i < CAP; i++) {
    assert.ok(store.forUser(`capfill-${i}`), `capfill-${i} should have been created`);
  }
  assert.equal(store.personas.size, CAP);
  assert.equal(store.forUser('one-too-many'), null);
  assert.equal(store.personas.size, CAP, 'a refused login must not grow the map');
});

test('an existing persona still resolves at the ceiling', () => {
  assert.equal(store.personas.size, CAP);
  assert.equal(store.forUser('alice').key, 'alice');
  assert.equal(store.forUser('capfill-3').key, 'capfill-3');
});

test('a non-numeric MAX_PERSONAS fails startup instead of removing the cap', async () => {
  for (const bad of ['abc', '0', '-5', '12abc']) {
    process.env.MAX_PERSONAS = bad;
    await assert.rejects(
      import(`../../src/store.js?bad=${encodeURIComponent(bad)}`),
      (e) => e.message.includes('MAX_PERSONAS'),
      `MAX_PERSONAS=${bad} must be refused`,
    );
  }
  process.env.MAX_PERSONAS = String(CAP);
});
