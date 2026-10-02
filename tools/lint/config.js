// ESLint flat config for the Sheer frontend (TypeScript + React 19).
//
// This file lives in the `tools/lint` workspace on purpose: typescript-eslint needs the classic TypeScript JS API
// (peer range <6.1), which the TypeScript 7 compiler at the repo root no longer ships. The workspace pins a private
// TypeScript 6 for the parser only; type checking is still done by the root `tsc` (TypeScript 7).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * The ways to put a string into the page as markup (SECURITY C2). A PDF's strings are untrusted: they are rendered as text only,
 * so none of these is allowed, however it is spelled. Each pattern covers the dot form (`el.innerHTML`), the string form
 * (`el['innerHTML']`, also as a template literal without substitutions) and an optional call (`el?.insertAdjacentHTML()`).
 * `tools/lint/config.test.ts` lints a snippet of every spelling.
 */
const HTML_SETTERS = /^(innerHTML|outerHTML)$/.source;
const HTML_METHODS = /^(insertAdjacentHTML|setHTMLUnsafe|parseHTMLUnsafe|createContextualFragment)$/.source;
const DOCUMENT_WRITES = /^write(ln)?$/.source;
const DOCUMENT_OBJECTS = /^(document|ownerDocument|contentDocument)$/.source;

/** An ESQuery condition: the member is named by `pattern`, as `a.name` or as `a['name']` (`a[name]` is a variable, not a name). */
const named = (pattern) =>
  `:matches([computed=false][property.name=/${pattern}/], [property.value=/${pattern}/], [property.quasis.0.value.cooked=/${pattern}/])`;
/** The same for the left side of an assignment. */
const assignedTo = (pattern) =>
  `:matches([left.computed=false][left.property.name=/${pattern}/], [left.property.value=/${pattern}/], [left.property.quasis.0.value.cooked=/${pattern}/])`;

const HTML_SINKS = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML is forbidden: render untrusted strings as text only.',
  },
  {
    selector: `AssignmentExpression${assignedTo(HTML_SETTERS)}`,
    message: 'innerHTML/outerHTML assignment is forbidden: render untrusted strings as text only.',
  },
  {
    selector: `MemberExpression${named(HTML_METHODS)}`,
    message:
      'insertAdjacentHTML, setHTMLUnsafe, parseHTMLUnsafe and createContextualFragment are forbidden: render untrusted strings as text only.',
  },
  {
    selector: "Identifier[name='DOMParser'], MemberExpression[property.value='DOMParser']",
    message: 'DOMParser is forbidden: it turns a string into markup. Render untrusted strings as text only.',
  },
  {
    selector: `MemberExpression:matches([object.name=/${DOCUMENT_OBJECTS}/], [object.property.name=/${DOCUMENT_OBJECTS}/])${named(DOCUMENT_WRITES)}`,
    message: 'document.write is forbidden: render untrusted strings as text only.',
  },
];

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'node_modules/', 'src-tauri/', 'tests/', 'assets/', 'docs/']),
  {
    files: ['**/*.{js,ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // ORCHESTRATOR_PROMPT 13.6: no dynamic code, no HTML injection. PDF strings are untrusted text.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': ['error', ...HTML_SINKS],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
);
