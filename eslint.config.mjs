import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  // Type-aware strict rules: no unsafe any, no unhandled promises, no needless conditions or
  // assertions, exhaustive template and arithmetic types.
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['*.mjs', '*.mts'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      // Numbers in messages and keys are fine; objects and unknowns are still rejected.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests assert on values they just created; a failed non-null assertion is a failed test.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // supertest types HTTP response bodies as any: tests read JSON the API sent and assert on it.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
