import antfu from '@antfu/eslint-config';
import globals from 'globals';

export default antfu({
  stylistic: {
    semi: true,
  },

  ignores: ['README.md', '*.yaml', '*.yml'],

  languageOptions: {
    globals: {
      ...globals.node,
      Bun: 'readonly',
    },
  },

  rules: {
    'node/prefer-global/process': ['error', 'always'],
    'ts/no-use-before-define': ['error', { allowNamedExports: true, functions: false }],
    'curly': ['error', 'all'],
    'vitest/consistent-test-it': ['error', { fn: 'test' }],
    'ts/consistent-type-definitions': ['error', 'type'],
    'style/brace-style': ['error', '1tbs', { allowSingleLine: false }],
    'unused-imports/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    }],
  },
});
