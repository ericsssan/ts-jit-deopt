'use strict';

// The "cheap static layer" from Stage 6 of the article.
//
// These rules catch the LOCALLY-DECIDABLE subset of JIT-friendliness -- the
// shape-wreckers a linter can see from syntax alone. They do NOT (and cannot)
// catch cross-function megamorphism or runtime type instability; those are
// runtime facts, which is what ci/deopt-gate.js is for. Static lint + dynamic
// gate together cover both halves.

const tseslint = require('typescript-eslint');

// Shared rules applied to both JS and TS.
const jitRules = {
  'no-restricted-syntax': [
    'warn',
    {
      // `delete obj.prop` transitions the object to dictionary (hash-map) mode
      // -- slow, and permanent. Set to undefined/null instead.
      selector: "UnaryExpression[operator='delete']",
      message:
        'delete forces the object into dictionary mode (slow, permanent). Set the property to undefined/null instead.',
    },
    {
      // `with` defeats scope analysis and deoptimizes.
      selector: 'WithStatement',
      message: '`with` defeats scope analysis and deoptimizes the enclosing scope.',
    },
    {
      // Leaking the `arguments` object blocks optimization; use rest params.
      selector: "Identifier[name='arguments']",
      message: 'Leaking `arguments` blocks optimization. Use rest params (...args) instead.',
    },
  ],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'prefer-rest-params': 'warn',
  'no-param-reassign': ['warn', { props: true }],
};

module.exports = [
  { ignores: ['node_modules/**', '**/*.cpuprofile', '**/*.v8.log'] },

  // Plain JS (CommonJS) files.
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2023 },
    rules: jitRules,
  },

  // TypeScript files: the same shape rules, plus "no `any`" -- because `any`
  // and casts are exactly what let runtime types drift from declared ones,
  // which is what triggers deopts. Honoring types == keeping speculation valid.
  ...tseslint.config({
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      ...jitRules,
      '@typescript-eslint/no-explicit-any': 'error',
    },
  }),
];
