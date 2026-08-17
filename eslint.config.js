// @ts-check
import { FlatCompat } from '@eslint/eslintrc';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { base, ignores } from './packages/config/eslint/base.js';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default tseslint.config(
  ...base,

  // Type-aware TypeScript linting everywhere, using `projectService` so
  // each file is checked against the nearest tsconfig.json without this
  // file having to enumerate every package/app's project path by hand
  // (typescript-eslint v8; see https://typescript-eslint.io/packages/parser/#projectservice).
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Nest and Next both rely on structural/decorator patterns that
      // trip a few stylistic type-checked rules without adding real
      // safety; disabled deliberately, not by default.
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Node.js runtime globals for everything that isn't the browser app.
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts', 'packages/**/*.ts', 'prisma/**/*.ts'],
    ignores,
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Playwright's webServer runs this as a plain Node script (see its
  // own doc comment) — apps/web has no TS-loader devDependency to run a
  // .ts file standalone, and it's outside the apps/web browser-globals
  // block above (which only matches .ts/.tsx) since it's plain JS.
  {
    files: ['apps/web/e2e/**/*.mjs'],
    ignores,
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Repo-root standalone Node scripts (Phase 18's bundle-secret scan)
  // and apps/web's own next.config.mjs — plain `.mjs`, run directly by
  // Node, outside every other globals-defining block above (which only
  // match `.ts` files or `apps/api`/`apps/worker`/`packages`/`prisma`).
  {
    files: ['scripts/**/*.mjs', 'apps/web/next.config.mjs'],
    ignores,
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // apps/web: browser globals + Next.js's own recommended rules
  // (accessibility, hooks correctness, image/link usage), bridged from
  // its legacy .eslintrc-shaped config via FlatCompat.
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    ignores,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  ...compat.extends('next/core-web-vitals').map((config) => ({
    ...config,
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
  })),
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    ignores,
    rules: {
      // We use the App Router exclusively; there is no pages/ directory
      // and never will be, so this check is not applicable.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  // Test files: relax a couple of rules that fight legitimate test
  // patterns (constructing minimal fakes, intentionally-invalid input
  // for negative-path assertions) without weakening them anywhere else.
  {
    files: ['**/*.test.ts', '**/test/**/*.ts', '**/e2e/**/*.ts'],
    ignores,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Counter design-system token adoption (UI Build Gap Report): raw
  // Tailwind slate/amber/red/gray classes are banned in every file
  // that's been migrated onto the token system (apps/web/src/app/
  // globals.css's own doc comment explains why) — semantic ink-*/
  // brand-*/fresh/warn/error classes only. Scoped to migrated files
  // only, not all of apps/web/**, since the migration is deliberately
  // incremental (page by page) and turning this on repo-wide before
  // every page is migrated would fail `pnpm lint` on untouched pages
  // for a gap this rule can't fix by itself. Extend this `files` list
  // as each additional page migrates.
  {
    files: [
      'apps/web/src/components/**/*.tsx',
      'apps/web/src/app/r/[slug]/restaurant-ordering-view.tsx',
      'apps/web/src/app/r/[slug]/checkout/page.tsx',
      'apps/web/src/app/orders/[orderNumber]/page.tsx',
      'apps/web/src/app/restaurant/orders/page.tsx',
      'apps/web/src/app/restaurant/menu/page.tsx',
      'apps/web/src/app/restaurant/layout.tsx',
      'apps/web/src/app/restaurant/staff/page.tsx',
      'apps/web/src/app/account/page.tsx',
      'apps/web/src/app/admin/layout.tsx',
    ],
    ignores,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/\\b(slate|amber|red|gray|zinc|neutral|stone|yellow|orange|green|blue|indigo|purple|pink)-[0-9]+\\b/]",
          message:
            'Use a Counter token class (ink-*/brand-*/fresh/warn/error, see globals.css) instead of a raw Tailwind color class.',
        },
      ],
    },
  },

  // Plain config/build scripts (this file, tailwind/postcss/playwright
  // configs, next.config.mjs): not part of the type-checked project
  // graph, and don't need to be.
  {
    files: ['*.config.{js,mjs,ts}', '**/*.config.{js,mjs,ts}'],
    ignores,
    ...tseslint.configs.disableTypeChecked,
  },
);
