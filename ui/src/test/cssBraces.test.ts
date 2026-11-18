// app.css grows by appended blocks and merges; a dropped "}" silently nests every
// later rule under the wrong selector (it happened after a merge). This keeps the
// file well-formed: braces balance, and a rule written at column 0 opens at the top
// level (rules inside @media and the like are indented).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const STYLES = join(__dirname, '..', 'styles');

/** Comments and strings blanked out, so braces inside them don't count; line numbers kept. */
function code(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => ' '.repeat(m.length));
}

/** Problems found: a top-level rule opened inside another block, a "}" too many, or an unclosed block at the end. */
export function cssProblems(css: string): string[] {
  const problems: string[] = [];
  let depth = 0;
  code(css)
    .split('\n')
    .forEach((line, i) => {
      if (depth > 0 && /^[^\s}]/.test(line) && line.includes('{')) problems.push(`line ${i + 1}: "${line.trim()}" opens inside another block (a missing "}" above?)`);
      for (const c of line) {
        if (c === '{') depth++;
        else if (c === '}' && --depth < 0) {
          problems.push(`line ${i + 1}: "}" closes nothing`);
          depth = 0;
        }
      }
    });
  if (depth > 0) problems.push(`${depth} block(s) never closed`);
  return problems;
}

describe('stylesheets are well-formed', () => {
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
    it(`${file}: balanced braces, no rule nested by accident`, () => {
      expect(cssProblems(readFileSync(join(STYLES, file), 'utf8'))).toEqual([]);
    });
  }

  it('the check itself finds a dropped brace, an extra one, and an unclosed block', () => {
    expect(cssProblems('.a {\n  color: red;\n}\n\n@media (x) {\n  .b {\n    color: red;\n  }\n}\n')).toEqual([]);
    expect(cssProblems('.a {\n  color: red;\n\n.b {\n  color: blue;\n}\n')[0]).toMatch(/line 4: "\.b \{" opens inside another block/);
    expect(cssProblems('.a {\n}\n}\n')).toEqual(['line 3: "}" closes nothing']);
    expect(cssProblems('/* { */ .a { content: "}"; }\n')).toEqual([]);
  });
});
