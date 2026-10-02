// ESLint flat config for the Sheer frontend (TypeScript + React 19).
//
// This file lives in the `tools/lint` workspace on purpose: typescript-eslint needs the classic TypeScript JS API
// (peer range <6.1), which the TypeScript 7 compiler at the repo root no longer ships. The workspace pins a private
// TypeScript 6 for the parser only; type checking is still done by the root `tsc` (TypeScript 7).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

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
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is forbidden: render untrusted strings as text only.',
        },
        {
          selector: 'AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]',
          message: 'innerHTML/outerHTML assignment is forbidden: render untrusted strings as text only.',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is forbidden: render untrusted strings as text only.',
        },
        {
          selector: "CallExpression[callee.object.name='document'][callee.property.name=/^write(ln)?$/]",
          message: 'document.write is forbidden: render untrusted strings as text only.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
);
