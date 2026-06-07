'use strict';

module.exports = [
  { ignores: ['node_modules/**', 'examples/**', '**/*.v8.log', '**/*.cpuprofile'] },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { ecmaVersion: 2023 },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
];
