import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';

/**
 * Import boundaries for the Studio modularization (docs/plans/studio-modularization.md).
 *
 * Target layout:
 *   src/floorplan/  domain-agnostic editor core
 *   src/modules/    one directory per registered module (codec.ts + commands.ts eager, runtime.ts lazy)
 *   src/app/        Studio shell — may import from anywhere
 *
 * These directories are created incrementally by phases 1–6; until then the rules
 * below are inert. Nothing here needs to change as code moves in, except adding a
 * new module id to MODULE_IDS.
 */
const MODULE_IDS = ['lighting', 'flooring'];

const boundaryZones = [
  {
    target: './src/floorplan',
    from: './src/modules',
    message: 'floorplan/ is domain-agnostic and may not import from modules/.',
  },
  {
    target: './src/floorplan',
    from: './src/app',
    message: 'floorplan/ is domain-agnostic and may not import from app/.',
  },
  ...MODULE_IDS.flatMap((target) =>
    MODULE_IDS.filter((from) => from !== target).map((from) => ({
      target: `./src/modules/${target}`,
      from: `./src/modules/${from}`,
      message: `modules/${target} may not import from modules/${from}; modules are independent.`,
    }))
  ),
];

const EAGER_MODULE_ENTRYPOINTS = ['src/modules/*/codec.ts', 'src/modules/*/commands.ts'];

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        __APP_VERSION__: 'readonly',
      },
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
      },
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'build/', '.svelte-kit/', 'package/', '*.config.js'],
  },
  {
    rules: {
      // Customize rules as needed
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Resolved-path boundaries. Catches sibling-relative imports (`../flooring/x`)
    // that a specifier-string rule cannot distinguish from a local subdirectory.
    files: ['src/**/*.ts', 'src/**/*.svelte'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        node: { extensions: ['.ts', '.js', '.mjs', '.svelte', '.json'] },
      },
    },
    rules: {
      'import/no-restricted-paths': [
        'error',
        { basePath: import.meta.dirname, zones: boundaryZones },
      ],
    },
  },
  {
    // Specifier-string backstop for the floorplan boundary: applies even when the
    // import target cannot be resolved (e.g. a `*.svelte` component).
    files: ['src/floorplan/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**', '**/app/**'],
              message: 'floorplan/ is domain-agnostic and may not import from modules/ or app/.',
            },
          ],
        },
      ],
    },
  },
  {
    // Invariant 7: codecs and command tables load eagerly, so they must stay free of
    // the lazy runtime, THREE, and Svelte components.
    files: EAGER_MODULE_ENTRYPOINTS,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'three',
              message: 'codec.ts / commands.ts load eagerly; keep THREE in runtime.ts.',
            },
          ],
          patterns: [
            {
              group: [
                'three/*',
                '**/*.svelte',
                './runtime',
                './runtime.ts',
                '**/runtime',
                '**/runtime.ts',
              ],
              message:
                'codec.ts / commands.ts load eagerly; they may not import runtime.ts, three, or Svelte components.',
            },
          ],
        },
      ],
    },
  }
);
