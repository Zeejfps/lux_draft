import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Parse a persistence fixture. Returns `unknown`, freshly parsed on every call — the decoder's
 * input is hostile by definition, and no test may hand another test a mutated object.
 */
export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8'));
}
