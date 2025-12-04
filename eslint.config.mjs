// ESLint 9 flat config format
// Note: This file is kept for future migration to flat config
// Currently using .eslintrc.json for compatibility

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '*.config.js',
      '*.config.mjs',
      'scripts/**',
      'prisma/**',
    ],
  },
];

