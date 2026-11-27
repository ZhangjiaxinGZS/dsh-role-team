import { defineConfig } from 'tsdown'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

export default defineConfig([
  {
    entry: { host: 'src/host/index.ts', shared: 'src/shared/index.ts', remote: 'src/shared/remote.ts' },
    format: 'esm',
    platform: 'node',
    dts: false,
    clean: false,
    external: [/^@deepseek-ai\//],
    outExtensions: () => ({ js: '.js' }),
    plugins: [
      {
        name: 'lower-standard-remote-decorators',
        transform(source, id) {
          if (!id.endsWith('/src/host/index.ts')) return
          return ts.transpileModule(source, {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
              verbatimModuleSyntax: true,
            },
          }).outputText
        },
      },
    ],
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    external: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      'zod',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    noExternal: [
      'diff',
      /^yaml/,
      '@deepseek-ai/dsh-agent-preset-registry/display',
      /^@deepseek-ai\/dsh-typert-protocol/,
    ],
    inputOptions: {
      moduleTypes: { '.css': 'text' },
      resolve: {
        alias: {
          yaml: fileURLToPath(new URL('./browser/index.js', import.meta.resolve('yaml/package.json'))),
        },
      },
    },
    outExtensions: () => ({ js: '.js' }),
    outputOptions: {
      banner:
        "window.__ModuleLoader__.load({ id: 'dsh-role-team', factory(require) { const exports = {}; const module = { exports };",
      footer: 'return module.exports; } });',
    },
  },
])
