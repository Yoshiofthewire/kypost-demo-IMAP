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
