import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, __SIGIL_VERSION__: 'readonly', __SIGIL_COMMIT__: 'readonly', __SIGIL_BUILD__: 'readonly' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Pragmatic for this codebase: warn (not error) on the common frictions so
      // `lint` is useful without a 200-item wall on day one.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // This is a terminal app — ANSI/SGR parsing regexes contain \x1b, \x07,
      // etc. by necessity; the control-char rule is a false positive here.
      'no-control-regex': 'off',
    },
  },
  // Test files: allow devDeps + looser rules.
  { files: ['src/**/*.test.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
