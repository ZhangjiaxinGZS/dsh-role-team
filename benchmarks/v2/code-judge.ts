import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { projectSources, type Project } from './engineering.ts'
const require = createRequire(import.meta.url)
const cli = require.resolve('vitest/package.json').replace(/package\.json$/, 'vitest.mjs')
const modules = require.resolve('typescript/package.json').split('/typescript/package.json')[0]

// Only declared submission modules enter the compiler. Project configs, plugins,
// package scripts and test files supplied by the participant are never loaded.
export async function gradeProject(
  p: Project,
  sources: Record<string, string>,
  stage: number,
): Promise<Record<string, boolean>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'role-team-judge-')))
  const src = join(root, 'src'),
    bin = join(root, 'bin'),
    judge = join(root, 'judge')
  const cases = p.cases.filter((c) => (c.stage ?? p.changes.length) === stage)
  if (!cases.length) throw Error('No acceptance cases for stage')
  const checks: Record<string, boolean> = Object.fromEntries(
    ['compile', ...cases.map((c) => c.name)].map((k) => [k, false]),
  )
  try {
    for (const path of [src, bin, judge]) await mkdir(path)
    const names = Object.keys(projectSources(p))
    for (const name of names) {
      if (typeof sources[name] !== 'string' || Buffer.byteLength(sources[name]) > 128_000) return checks
      await writeFile(join(src, name), sources[name])
    }
    // No ambient Node types and no imports outside the declared TS modules.
    const opts: ts.CompilerOptions = {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      outDir: bin,
      types: [],
      lib: ['lib.es2022.d.ts'],
      skipLibCheck: true,
      noEmitOnError: true,
    }
    const allowed = new Set(names.map((n) => join(src, n)))
    const lib = dirname(ts.getDefaultLibFilePath(opts))
    const permitted = (name: string) =>
      allowed.has(resolve(name)) ||
      (dirname(resolve(name)) === lib && /^lib[.\w-]*\.d\.ts$/.test(basename(name)))
    const host = ts.createCompilerHost(opts)
    const { readFile: readSource, fileExists: exists } = host
    host.readFile = (name) => (permitted(name) ? readSource(name) : undefined)
    host.fileExists = (name) => permitted(name) && exists(name)
    const program = ts.createProgram([...allowed], opts, host)
    if (
      program.getSourceFiles().some((f) => !allowed.has(f.fileName) && !program.isSourceFileDefaultLibrary(f))
    )
      return checks
    if (ts.getPreEmitDiagnostics(program).length || program.emit().emitSkipped) return checks
    checks.compile = true
    const driver = join(bin, 'invoke.cjs')
    await writeFile(
      driver,
      `const fs=require('node:fs'); const rows=JSON.parse(fs.readFileSync(0,'utf8')); const value=require('./index.js').run(rows); process.stdout.write(JSON.stringify(value));`,
    )
    const spec = join(judge, 'acceptance.test.mjs')
    await writeFile(
      spec,
      `import {it,expect} from 'vitest';import {spawnSync} from 'node:child_process';
const cases=` +
        JSON.stringify(cases) +
        `;
for(const c of cases)it(c.name,()=>{
 const r=spawnSync(process.execPath,['--permission','--allow-fs-read='+` +
        JSON.stringify(bin) +
        `,` +
        JSON.stringify(driver) +
        `],{cwd:` +
        JSON.stringify(bin) +
        `,env:{},input:JSON.stringify(c.input),encoding:'utf8',timeout:3000,maxBuffer:262144});
 expect(r.status).toBe(0);expect(JSON.parse(r.stdout)).toEqual(c.expected);
});`,
    )
    await symlink(modules, join(root, 'node_modules'), 'dir')
    await chmod(spec, 0o444)
    await chmod(judge, 0o555)
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'run',
        '--root',
        judge,
        '--no-cache',
        '--reporter=json',
        '--outputFile',
        join(root, 'result.json'),
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, CI: '1' },
        encoding: 'utf8',
        timeout: 35_000,
        maxBuffer: 512_000,
      },
    )
    if (result.error || result.status == null) throw Error('External Vitest worker failed to finish')
    const report = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
    const assertions = report.testResults.flatMap((r: { assertionResults: unknown[] }) => r.assertionResults)
    if (assertions.length !== cases.length) throw Error('Incomplete external acceptance suite')
    for (const a of assertions) checks[a.title] = a.status === 'passed'
    return checks
  } finally {
    await chmod(judge, 0o755).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}
