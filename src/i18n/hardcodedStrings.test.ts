import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { catalogs } from './catalog';

/**
 * No user-visible English text may be hardcoded in src/features and src/components (the showcase and the tests aside):
 * every text comes from a catalog through `t(...)`. The scan parses the sources and looks at the places where text
 * reaches the user: JSX text, JSX attributes that carry a name or a description (`aria-label`, `title`, `label`, ...),
 * string literals in `{...}` as JSX children, and object properties of the same kind (`label: '...'` in a toolbar entry).
 *
 * The parser is TypeScript 6 from the `tools/lint` workspace: the root compiler (TypeScript 7) has no JS API.
 */
type TypeScript = typeof import('../../tools/lint/node_modules/typescript');
type Node = import('../../tools/lint/node_modules/typescript').Node;

const lintRequire = createRequire(fileURLToPath(new URL('../../tools/lint/package.json', import.meta.url)));
const ts = lintRequire('typescript') as TypeScript;

const SRC = fileURLToPath(new URL('..', import.meta.url));
const SCANNED = ['features', 'components', 'actions', 'stores', 'lib'];
const TEXT_NAME = /(label|title|alt|placeholder|description|tooltip|note|text|message|caption|hint|legend|summary)$/i;
/** Names that look like text and are not: an `aria-` token list, a key binding. */
const NOT_TEXT = new Set(['aria-keyshortcuts', 'aria-labelledby', 'aria-describedby', 'aria-errormessage']);
const LETTER = /\p{L}/u;
/** Tables of Tailwind classes, whose `text` property is a size and a colour, not a text. */
const CLASS_TABLES = new Set(['components/controlStyles.ts property text']);

/** A catalog key passed as data (`label: 'leftPanel.tab.thumbnails'`) is translated later; it is not English text. */
const isCatalogKey = (text: string): boolean =>
  Object.hasOwn(catalogs.en, text) || Object.hasOwn(catalogs.en, `${text}.other`);

interface Hit {
  line: number;
  kind: string;
  text: string;
}

function propertyName(name: Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** The text of a literal that is only text: `'a'`, `"a"` and `` `a` `` without substitutions. */
function literalText(node: Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head, ...node.templateSpans.map((span) => span.literal)].map((part) => part.text).join(' ');
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return literalText(node.expression);
  return undefined;
}

function isTextName(name: string | undefined): boolean {
  return name !== undefined && !NOT_TEXT.has(name.toLowerCase()) && TEXT_NAME.test(name);
}

/** Every hardcoded user-visible text in `source`, with its line. */
function findHardcodedText(source: string, fileName = 'file.tsx'): Hit[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const hits: Hit[] = [];
  const add = (node: Node, what: string, text: string) => {
    if (LETTER.test(text))
      hits.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        kind: what,
        text: text.trim(),
      });
  };
  const visit = (node: Node): void => {
    if (ts.isJsxText(node)) add(node, 'JSX text', node.text);
    else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const text = node.expression === undefined ? undefined : literalText(node.expression);
      if (text !== undefined) add(node, 'JSX string child', text);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(file);
      const value = node.initializer;
      const text =
        value === undefined
          ? undefined
          : ts.isJsxExpression(value)
            ? value.expression && literalText(value.expression)
            : literalText(value);
      if (text !== undefined && isTextName(name)) add(node, `attribute ${name}`, text);
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      const text = literalText(node.initializer);
      if (text !== undefined && isTextName(name)) add(node, `property ${name ?? ''}`, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'showcase' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('findHardcodedText', () => {
  it('finds JSX text, text attributes, string children and text properties', () => {
    const source = [
      'export const A = () => (',
      '  <div className="panel" role="region" aria-label="Documents" title={\'Close\'}>',
      '    Open a PDF',
      "    {'Hello'}",
      '    <Button label={`Save`} variant="primary">Go</Button>',
      '  </div>',
      ');',
      "export const entries = [{ id: 'open', label: 'Open…', description: 'Opens a file' }];",
    ].join('\n');
    expect(findHardcodedText(source).map((hit) => `${hit.line} ${hit.kind}: ${hit.text}`)).toEqual([
      '2 attribute aria-label: Documents',
      '2 attribute title: Close',
      '3 JSX text: Open a PDF',
      '4 JSX string child: Hello',
      '5 attribute label: Save',
      '5 JSX text: Go',
      '8 property label: Open…',
      '8 property description: Opens a file',
    ]);
  });

  it('accepts translated text, identifiers, symbols and attributes that are not text', () => {
    const source = [
      'export const B = ({ t, n }) => (',
      '  <div className="rounded-md" role="toolbar" id="main" data-testid="x" aria-keyshortcuts="Control+O" aria-label={t(\'toolbar.label\')}>',
      "    <span>{t('status.page', { page: n, total: 3 })}</span>",
      '    <span>·</span> <span>/</span> <span>{n}</span> <span>…</span>',
      '    <Button label={label} variant="plain">{`${n}`}</Button>',
      '  </div>',
      ');',
      "export const e = { id: 'open', label: t('x'), key: 'Escape', variant: 'plain', ariaLabel: label };",
    ].join('\n');
    expect(findHardcodedText(source)).toEqual([]);
  });

  it('does not stop at nested elements and arrow functions', () => {
    const source =
      'export const C = ({ items }) => <ul>{items.map((i) => <li key={i} aria-label="Item">Entry {i}</li>)}</ul>;';
    expect(findHardcodedText(source).map((hit) => hit.text)).toEqual(['Item', 'Entry']);
  });
});

describe('the UI sources', () => {
  const files = SCANNED.flatMap((directory) => sourceFiles(join(SRC, directory)));

  it('the scan sees the shell and the components, and leaves the showcase and the tests out', () => {
    const names = files.map((file) => relative(SRC, file).split(sep).join('/'));
    expect(names).toContain('features/shell/Banner.tsx');
    expect(names).toContain('components/IconButton.tsx');
    expect(names).toContain('features/modes/useSlots.tsx');
    expect(names.filter((name) => name.includes('showcase') || /\.test\./.test(name))).toEqual([]);
  });

  it('no user-visible English text is hardcoded: it all comes from t(...)', () => {
    const found = files.flatMap((file) => {
      const name = relative(SRC, file).split(sep).join('/');
      return findHardcodedText(readFileSync(file, 'utf8'), file)
        .filter((hit) => !isCatalogKey(hit.text) && !CLASS_TABLES.has(`${name} ${hit.kind}`))
        .map((hit) => `${name}:${hit.line} ${hit.kind}: ${hit.text}`);
    });
    expect(found).toEqual([]);
  });
});
