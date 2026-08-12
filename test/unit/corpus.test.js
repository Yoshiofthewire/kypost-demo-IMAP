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
