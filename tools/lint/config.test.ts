import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * The HTML-sink rule of `config.js` (SECURITY C2): every way to turn a string into markup is reported, in every spelling, and
 * reading the same properties is not. The snippets are linted as the app's own source files, with the real config.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: fileURLToPath(new URL('./config.js', import.meta.url)) });

/** The messages of the sink rule (and of a parse error) the real config gives to `code`, as if it were a file in `src/`. */
async function lint(code: string, file = 'probe.ts'): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}src/${file}` });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === null || message.ruleId === 'no-restricted-syntax')
    .map((message) => `${message.ruleId ?? 'parse error'}: ${message.message}`);
}

const SINK = 'no-restricted-syntax: ';

describe('the HTML-sink lint rule', () => {
  describe('reports an assignment of markup', () => {
    for (const property of ['innerHTML', 'outerHTML']) {
      for (const [spelling, code] of [
        ['the dot form', `el.${property} = text;`],
        ['a compound assignment', `el.${property} += text;`],
        ['a string key', `el['${property}'] = text;`],
        ['a double-quoted key', `el["${property}"] = text;`],
        ['a template-literal key', `el[\`${property}\`] = text;`],
        ['a type assertion', `(el as HTMLElement).${property} = text;`],
        ['a non-null element', `el!.${property} = text;`],
        ['a chain', `this.root.children[0].${property} = text;`],
      ] as const) {
        it(`${property}: ${spelling}`, async () => {
          const messages = await lint(code);
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatch(new RegExp(`^${SINK}innerHTML/outerHTML assignment is forbidden`));
        });
      }
    }
  });

  describe('reports a method that parses markup', () => {
    for (const method of ['insertAdjacentHTML', 'setHTMLUnsafe', 'parseHTMLUnsafe', 'createContextualFragment']) {
      for (const [spelling, code] of [
        ['a call', `el.${method}('beforeend', text);`],
        ['a string key', `el['${method}']('beforeend', text);`],
        ['an optional call', `el?.${method}('beforeend', text);`],
        ['a reference that is called later', `const run = el.${method}; run.call(el, text);`],
        ['a call on the document', `document.${method}(text);`],
      ] as const) {
        it(`${method}: ${spelling}`, async () => {
          const messages = await lint(code);
          expect(messages.length).toBeGreaterThanOrEqual(1);
          expect(messages[0]).toContain(
            `${SINK}insertAdjacentHTML, setHTMLUnsafe, parseHTMLUnsafe and createContextualFragment`,
          );
        });
      }
    }
  });

  describe('reports the DOMParser', () => {
    for (const [spelling, code] of [
      ['a new parser', "new DOMParser().parseFromString(text, 'text/html');"],
      ['a parser from window', 'new window.DOMParser();'],
      ['a parser from globalThis, by string', "new globalThis['DOMParser']();"],
      ['an alias', 'const Parser = DOMParser; new Parser();'],
    ] as const) {
      it(spelling, async () => {
        const messages = await lint(code);
        expect(messages.length).toBeGreaterThanOrEqual(1);
        expect(messages[0]).toContain(`${SINK}DOMParser is forbidden`);
      });
    }
  });

  describe('reports document.write and document.writeln', () => {
    for (const [spelling, code] of [
      ['write', 'document.write(text);'],
      ['writeln', 'document.writeln(text);'],
      ['a string key', "document['write'](text);"],
      ['window.document', 'window.document.write(text);'],
      ['the owner document of an element', 'el.ownerDocument.write(text);'],
      ['the document of a frame', 'frame.contentDocument.writeln(text);'],
    ] as const) {
      it(spelling, async () => {
        const messages = await lint(code);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toBe(`${SINK}document.write is forbidden: render untrusted strings as text only.`);
      });
    }
  });

  it('reports dangerouslySetInnerHTML in JSX', async () => {
    const messages = await lint(
      'export const A = () => <div dangerouslySetInnerHTML={{ __html: text }} />;',
      'probe.tsx',
    );
    expect(messages).toEqual([`${SINK}dangerouslySetInnerHTML is forbidden: render untrusted strings as text only.`]);
  });

  describe('lets the safe code through', () => {
    for (const [what, code] of [
      ['text content', 'el.textContent = text;'],
      ['reading innerHTML', 'const html = el.innerHTML; log(el.outerHTML);'],
      ['a variable that is named like a property', 'const name = "x"; el[name] = text; el[innerHTML] = text;'],
      [
        'an element that is built from nodes',
        "const b = document.createElement('b'); b.append(text); el.replaceChildren(b);",
      ],
      ['a method of another object that writes', 'stream.write(text); logger.writeln(text);'],
      ['a document method that is not a write', "document.querySelector('write'); document.getElementById('x');"],
      ['the word as a string only', "const note = 'DOMParser and innerHTML are not used';"],
    ] as const) {
      it(what, async () => {
        expect(await lint(code)).toEqual([]);
      });
    }
  });
});
