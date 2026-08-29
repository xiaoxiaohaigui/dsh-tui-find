import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The plugin's NodeNext builds import sibling modules as `.js`; vitest must
  // resolve those onto the .ts/.tsx sources.
  resolve: {
    extensionAlias: { '.js': ['.tsx', '.ts', '.js'] },
  },
  oxc: {
    // Vitest 4 transpiles with oxc (esbuild options are ignored). JSX must
    // compile against the HOST package's jsx-runtime with development off —
    // the dev-only jsx-dev-runtime twin is not exported by the published
    // package. (Mount-integration tests import dist/ anyway; this guards
    // any future source-level JSX tests.)
    jsx: {
      development: false,
      importSource: '@deepseek-harness-tui/dsh-tui',
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
