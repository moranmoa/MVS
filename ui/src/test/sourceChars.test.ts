// No raw control or line-separator characters in the source. In a regex or
// string they must be written as escapes: a raw U+2028 is a line break to
// JavaScript and broke the build once (#546), while the tests still passed.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const DIRS = ['src', 'scripts'];
const EXT = /\.(ts|tsx|mjs|js|css|json)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : files(p);
    return EXT.test(name) ? [p] : [];
  });
}

/** Tab, LF and CR are fine; other C0 controls, DEL and U+2028/U+2029 are not. */
function isRaw(code: number): boolean {
  return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 0x7f || code === 0x2028 || code === 0x2029;
}

describe('source characters', () => {
  it('has no raw control or line-separator characters (write them as \\u escapes)', () => {
    const found: string[] = [];
    for (const dir of DIRS) {
      for (const file of files(join(ROOT, dir))) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const bad = [...line].find((c) => isRaw(c.codePointAt(0)!));
            if (bad) found.push(`${relative(ROOT, file)}:${i + 1} U+${bad.codePointAt(0)!.toString(16).padStart(4, '0')}`);
          });
      }
    }
    expect(found).toEqual([]);
  });
});
