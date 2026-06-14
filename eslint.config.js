import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'web/**'] },
  ...tseslint.configs.recommended,
);
