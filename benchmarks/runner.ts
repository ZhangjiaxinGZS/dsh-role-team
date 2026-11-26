import { fork } from 'node:child_process'
import { lstat, mkdir, mkdtemp, realpath, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { analyze } from './analyze.ts'
import { parseLogs } from './log-parser.ts'
import { flagshipCodex } from './drivers/local-host.ts'
import { scenarios, requiredCapabilities } from './scenarios/index.ts'
import {
  arms,
  safePath,
  syntheticMode,
  type AblationArm,
  type Capability,
  type LiveHostDriver,
  type LiveTrial,
  type Observation,
  type Preset,
  type ScenarioId,
  type TrialResult,
} from './types.ts'

type Event = { type: string; seq: number; time: number; data: Record<string, unknown> }
export async function simulateTrial(trial: LiveTrial): ReturnType<LiveHostDriver['runTrial']> {
  const { arm, scenario: s, workspace } = trial,
    team = arm !== 'single-agent'
  const workers = team ? s.roles.slice(1).map((r) => r.id) : ['lead']
  const logs = new Map<string, Event[]>()
  function emit(actor: string, type: string, data: Record<string, unknown>) {
    const rows = logs.get(actor) ?? []
    rows.push({ type, seq: rows.length, time: 1700000000000 + rows.length, data })
    logs.set(actor, rows)
  }
  const text = (s: string) => [{ type: 'text', text: s }]
  const messageId = (actor: string) => actor + '-msg-' + (logs.get(actor)?.length ?? 0)
  const stepOf = (actor: string) => logs.get(actor)?.findLast((e) => e.type === 'step/start')?.data.step ?? 1
  const modelSource = { kind: 'model', provider: 'fixture', model: 'deterministic' }
  const user = (actor: string, kind: string, body: string) =>
    emit(actor, 'user/message', {
      id: messageId(actor),
      role: 'user',
      source: { kind },
      content: text(body),
    })
  const obs: Observation[] = []
  const observe = (kind: Observation['kind'], step: number, actor: string, body: string) =>
    obs.push({ kind, step, actor, text: body })
  const put = (file: string, data: unknown) => writeFile(join(workspace, file), JSON.stringify(data))
  function call(actor: string, name: string, args: Record<string, unknown>) {
    const id = actor + '-' + (logs.get(actor)?.length ?? 0)
    const ptc = trial.preset === 'ptc'
    const tool = {
      type: 'tool-call',
      id,
      name: ptc ? 'run_code' : name,
      arguments: ptc
        ? JSON.stringify({
            code: 'return await tools.' + name + '(' + JSON.stringify(args) + ')',
            description: name,
          })
        : JSON.stringify(args),
    }
    const step = stepOf(actor)
    emit(actor, 'assistant/message', {
      turn: 1,
      step,
      stream: [],
      message: {
        id: messageId(actor),
        role: 'assistant',
        source: modelSource,
        content: [tool],
      },
    })
    emit(actor, 'tool/call', { turn: 1, step, callId: id, name: tool.name, arguments: tool.arguments })
    if (ptc) {
      const dispatch = { rootCallId: id, parentCallId: id, subCallId: id + '-1', name, arguments: args }
      emit(actor, 'tool/ptc-dispatch-start', dispatch)
      emit(actor, 'tool/ptc-dispatch', { ...dispatch, isError: false, content: text('ok') })
    }
    emit(actor, 'tool/result', {
      turn: 1,
      step,
      message: {
        id: messageId(actor),
        role: 'tool',
        source: { kind: 'tool', callId: id },
        toolCallId: id,
        content: text('ok'),
      },
    })
  }
  function reply(actor: string, body: string, input: number, cache: number) {
    emit(actor, 'assistant/message', {
      turn: 1,
      step: stepOf(actor),
      stream: [],
      message: { id: messageId(actor), role: 'assistant', source: modelSource, content: text(body) },
      usage: { inputTokens: input, outputTokens: body.length, cacheReadTokens: cache },
    })
  }
  user('lead', 'user', s.initialPrompt)
  // Toy tokenizer/cache: only an identical leading token sequence is reused.
  for (const actor of new Set(['lead', ...workers])) {
    let previous: string[] = [],
      seen = '',
      history: string[] = []
    for (let step = 1; step <= 4; step++) {
      const brief = step <= 2 ? 'initial' : 'revised'
      if (s.id === 'S4' && step === 4) {
        emit(actor, 'compaction/summary', { summary: text('incident decisions') })
        seen = ''
        history = ['summary']
      }
      const prefix = ['role', actor]
      if (arm === 'v0.2.0-prefix-brief') prefix.push(brief)
      prefix.push(...Array.from({ length: 64 }, (_, i) => 'static' + i))
      if (arm === 'v0.2.0-full' && brief !== seen) {
        user(actor, 'team-brief', brief)
        history.push(brief)
        seen = brief
      }
      emit(actor, 'step/start', { turn: 1, step })
      const tokens = [...prefix, ...history, 'step' + step]
      let hit = 0
      while (hit < previous.length && previous[hit] === tokens[hit]) hit++
      reply(actor, 'Checkpoint ' + step, tokens.length, hit)
      previous = tokens
      history.push('step' + step)
      call(actor, 'read_file', { path: 'release-policy.txt' })
    }
  }
  switch (s.id) {
    case 'S1':
      await put('delivery.json', {
        offer: 'Alpha',
        region: 'EU',
        budget: 80,
        retention: 7,
        latency: 120,
        export: 'CSV',
      })
      break
    case 'S2': {
      const question = 'Which audience, budget and deadline?'
      observe('question', 1, 'lead', question)
      reply('lead', question, 24, 16)
      user('lead', 'user', s.simulatedUser!(question))
      await put('delivery.json', { audience: 'operators', budget: '40 credits', deadline: 'Friday' })
      const answer = 'Deploy offline\n40 credits\nFriday deadline risk\nApprove pilot'
      observe('answer', 2, 'lead', answer)
      reply('lead', answer, 32, 16)
      break
    }
    case 'S3':
      for (const pivot of s.pivots!) {
        const step = pivot.progress * 10
        const instruction = s.simulatedUser!(String(pivot.progress * 100))
        observe('pivot', step, 'user', instruction)
        user('lead', 'user', instruction)
        for (const worker of workers) observe('work', step + 1, worker, instruction)
      }
      for (const file of ['producer.json', 'consumer.json'])
        await put(file, { contract: 'IF-17', transport: 'batch', encoding: 'ndjson' })
      break
    case 'S4':
      observe('compaction', 4, workers[0], 'summary committed')
      if (team) observe('reset', 5, workers[0], 'new generation')
      observe('work', 6, workers[0], 'R17 EU 7')
      await put('delivery.json', { key: 'R17', region: 'EU', rollbackDays: 7 })
      break
    case 'S5': {
      const facts = { network: 'MTU-1420', storage: 'TTL-7d', runtime: 'API-v3', audit: 'ZONE-EU' }
      if (team)
        for (const [id, fact] of Object.entries(facts)) {
          const assignment = 'Goal: inspect ' + id + '. Constraint: offline. Acceptance: signed fact.'
          observe('assignment', 1, id, assignment)
          call('lead', 'send_message', { to: id, message: assignment })
          const report =
            'Status: done. Conclusion: ' + fact + '. ' + 'Verified local observation. '.repeat(10)
          observe('report', 2, id, report)
          call(id, 'send_message', { to: 'lead', message: report })
          user('lead', 'agent-message', report)
          observe('board', 3, id, 'completed')
          call(id, 'team_task_update', { id, status: 'completed' })
          emit('lead', 'team/task', {
            version: 2,
            teamId: 'lead',
            task: {
              id,
              revision: 1,
              subject: id + ' inspection',
              description: assignment,
              ownerId: id,
              blockedBy: [],
              writeScopes: [],
              status: 'completed',
            },
          })
        }
      await put('delivery.json', facts)
      break
    }
    case 'S6':
      await put('t1.json', { region: 'east', ids: [1, 2, 3] })
      observe('stage1', 1, 'lead', 'accepted')
      if (team) {
        const lesson = 'Sort and deduplicate before cutover.'
        const memories = join(trial.roleStoreDir, workers[0], 'memories')
        await mkdir(memories, { recursive: true })
        await writeFile(
          join(memories, 'migration.md'),
          [
            '---',
            'id: migration',
            'title: Migration procedure',
            'scope: role_long_term',
            'createdAt: "2023-11-14T22:13:20Z"',
            '---',
            lesson,
          ].join('\n'),
        )
        call(workers[0], 'remember_experience', { title: 'Migration procedure', body: lesson })
        observe('experience', 2, workers[0], lesson)
      }
      user('lead', 'user', s.pivots![0].instruction)
      user('lead', 'user', s.simulatedUser!('T2'))
      await put('t2.json', { region: 'west', ids: [5, 6, 8] })
      observe('stage2', 3, 'lead', 'accepted')
      break
  }
  const traces = []
  for (const [actor, events] of logs) {
    const path = join(trial.traceDir, actor + '.jsonl')
    const header = {
      type: 'session',
      version: 4,
      id: actor,
      createdAt: 1700000000000,
      isSeeded: false,
      delegationDepth: actor === 'lead' ? 0 : 1,
    }
    await writeFile(path, [header, ...events].map((e) => JSON.stringify(e)).join('\n') + '\n')
    traces.push({
      path,
      leader: actor === 'lead',
      hasBrief: arm === 'v0.2.0-full' || arm === 'v0.2.0-prefix-brief',
    })
  }
  return { traces, observations: obs, workers }
}

interface Job {
  arm: AblationArm
  scenario: ScenarioId
  model: string
  preset: Preset
  repeat: number
  hostModule?: string
}
type TrialInput = Job & { root: string }
const inside = (root: string, p: string) => p === root || p.startsWith(root + sep)
async function runTrial(input: TrialInput): Promise<TrialResult> {
  const { root, hostModule, ...job } = input,
    scenario = scenarios[job.scenario]
  const [dshHome, roleStoreDir, workspace, traceDir] = ['dsh', 'roles', 'workspace', 'trace'].map((p) =>
    join(root, p),
  )
  for (const p of [dshHome, roleStoreDir, workspace, traceDir]) await mkdir(p, { recursive: true })
  await scenario.seedWorkspace(workspace)
  for (const role of scenario.roles) {
    const dir = join(roleStoreDir, role.id)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'role.md'),
      '---\nid: ' +
        role.id +
        '\nname: ' +
        JSON.stringify(role.name) +
        '\nsummary: ' +
        JSON.stringify(role.duty) +
        '\n---\n' +
        [role.duty, role.privateContext].filter(Boolean).join('\n') +
        '\n',
    )
  }
  const trial = { ...job, scenario, dshHome, roleStoreDir, workspace, traceDir }
  let run = simulateTrial
  if (hostModule) {
    const driver: LiveHostDriver = (await import(pathToFileURL(hostModule).href)).default
    if (!driver?.arms?.includes(job.arm) || typeof driver.runTrial !== 'function')
      throw new Error('Unsupported live arm: ' + job.arm)
    const missing = requiredCapabilities[job.scenario].filter(
      (c: Capability) => !driver.capabilities?.includes(c),
    )
    if (missing.length) throw new Error('Missing live capabilities: ' + missing.join(', '))
    run = (t) => driver.runTrial(t)
  }
  const result = await run(trial)
  if (!result.traces.some((t) => t.leader)) throw new Error('A leader trace is required')
  const traces = []
  const paths = new Set<string>()
  for (const t of result.traces) {
    const path = await realpath(t.path)
    if (!inside(traceDir, path) || paths.has(path)) throw new Error('Invalid or duplicate trace path')
    paths.add(path)
    traces.push({ ...t, text: await readFile(path, 'utf8') })
  }
  if (
    !traces.some(
      (t) =>
        t.leader &&
        t.text.split('\n').some((line) => {
          if (!line.trim()) return false
          const raw = JSON.parse(line)
          return (raw.event ?? raw).type === 'assistant/message'
        }),
    )
  )
    throw new Error('Missing leader model response')
  const verification = await scenario.verify({
    workspace,
    observations: result.observations,
    workers: result.workers,
  })
  return {
    ...job,
    ...(result.reasoningEfforts ? { reasoningEfforts: result.reasoningEfforts } : {}),
    mode: hostModule ? 'live' : syntheticMode,
    verification,
    metrics: parseLogs(traces),
  }
}

const localHost = fileURLToPath(new URL('./drivers/dsh-local-driver.ts', import.meta.url))
async function isolatedLive(input: TrialInput) {
  // Only benchmark-prefixed provider settings are forwarded. Configure model adapters in the driver.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(input.root, 'home'),
    CODEX_HOME: join(input.root, 'codex'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_HOME: join(input.root, 'dsh'),
    TMPDIR: input.root,
    XDG_CONFIG_HOME: join(input.root, 'config'),
    XDG_CACHE_HOME: join(input.root, 'cache'),
    XDG_DATA_HOME: join(input.root, 'data'),
  }
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('BENCH_')) env[k] = v
  const entry = fileURLToPath(import.meta.url)
  const child = fork(entry, ['--trial-worker'], {
    cwd: input.root,
    env,
    stdio: [
      'ignore',
      input.hostModule === localHost ? 'ignore' : 'inherit',
      input.hostModule === localHost ? 'ignore' : 'inherit',
      'ipc',
    ],
    execArgv: [],
  })
  return await new Promise<TrialResult>((resolve, reject) => {
    let value: TrialResult | undefined
    let failure: string | undefined
    const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60 * 1000)
    child.once('message', (message) => {
      if (typeof message === 'object' && message !== null && 'failure' in message)
        failure = String(message.failure)
      else value = message as TrialResult
    })
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 && value) resolve(value)
      else
        reject(
          new Error(failure ?? 'Isolated live host exited without a completed trial (exit ' + code + ')'),
        )
    })
    child.send(input)
  })
}

function selection<T extends string>(list: string | undefined, allowed: readonly T[]): T[] {
  const values = list === undefined ? [...allowed] : list.split(',')
  if (
    !values.length ||
    values.some((x) => !allowed.includes(x as T)) ||
    new Set(values).size !== values.length
  )
    throw new Error('Invalid selection: ' + values.join(','))
  return values as T[]
}
export async function run(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean' },
      live: { type: 'boolean' },
      resume: { type: 'boolean' },
      arms: { type: 'string' },
      scenarios: { type: 'string' },
      model: { type: 'string' },
      preset: { type: 'string', default: 'standard' },
      repeats: { type: 'string', default: '3' },
      out: { type: 'string' },
      'host-module': { type: 'string' },
    },
  })
  if (!!v.live === !!v['dry-run']) throw new Error('Select exactly one of --dry-run or --live')
  if (v.live && (!v['host-module'] || !v.model || !/^[^:\s]+:.+/.test(v.model)))
    throw new Error('--live requires --host-module and --model provider:model')
  if (!v.live && v['host-module']) throw new Error('--host-module requires --live')
  const hostModule = v.live ? await safePath(v['host-module']!) : undefined
  if (hostModule && !(await lstat(hostModule)).isFile()) throw new Error('Missing host module')
  const armsToRun = selection(v.arms, arms),
    ids = selection(v.scenarios, Object.keys(scenarios) as ScenarioId[])
  const repeats = Number(v.repeats)
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('Invalid --repeats')
  const preset = selection(v.preset, ['standard', 'ptc'] as const)
  if (preset.length !== 1) throw new Error('Select one preset per run')
  const out = await safePath(
    v.out ?? join('benchmarks/results', new Date().toISOString().replaceAll(':', '-')),
  )
  await mkdir(dirname(out), { recursive: true })
  const highEffort = hostModule === localHost && v.model === flagshipCodex
  const manifest = JSON.stringify({
    model: v.model,
    ...(highEffort && { reasoningEffort: 'high' }),
    preset: preset[0],
    repeats,
    scenarios: ids,
    arms: armsToRun,
    hostModule,
  })
  if (v.resume && !v.live) throw new Error('--resume requires --live')
  if (
    v.resume &&
    (await lstat(out).then(
      () => true,
      (e) => {
        if (e.code === 'ENOENT') return false
        throw e
      },
    ))
  ) {
    if ((await readFile(join(out, 'protocol.json'), 'utf8')) !== manifest)
      throw new Error('Different run protocol')
  } else {
    await mkdir(out)
    if (v.live) await writeFile(join(out, 'protocol.json'), manifest, { flag: 'wx' })
  }
  const trials = join(out, 'trials')
  await mkdir(trials, { recursive: !!v.resume })
  for (const scenario of ids)
    for (let repeat = 1; repeat <= repeats; repeat++)
      for (const arm of armsToRun) {
        const dest = join(trials, [scenario, arm, repeat].join('_'))
        if (v.resume) {
          try {
            const saved = JSON.parse(await readFile(await safePath(join(dest, 'metrics.json')), 'utf8'))
            if (
              saved.mode !== 'live' ||
              saved.model !== v.model ||
              saved.arm !== arm ||
              saved.preset !== preset[0] ||
              saved.scenario !== scenario ||
              saved.repeat !== repeat ||
              (highEffort &&
                (saved.reasoningEfforts?.length !== 1 || saved.reasoningEfforts[0] !== 'high')) ||
              !saved.metrics ||
              !saved.verification
            )
              throw new Error('Invalid completed trial')
            continue
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        const root = await mkdtemp(join(await safePath(tmpdir()), 'dsh-benchmark-'))
        try {
          const input = {
            root,
            arm,
            scenario,
            repeat,
            preset: preset[0],
            model: v.model ?? 'fixture:deterministic',
            hostModule,
          }
          const result = await (hostModule ? isolatedLive(input) : runTrial(input))
          const stage = await mkdtemp(join(out, '.trial-'))
          try {
            await writeFile(join(stage, 'metrics.json'), JSON.stringify(result, null, 2) + '\n')
            await rename(stage, dest)
          } finally {
            await rm(stage, { recursive: true, force: true })
          }
        } catch (error) {
          if (hostModule === localHost) {
            const reason = error instanceof Error ? error.message : 'Host failed'
            await writeFile(
              join(out, 'interruptions.jsonl'),
              JSON.stringify({ scenario, repeat, arm, reason, time: new Date().toISOString() }) + '\n',
              { flag: 'a', mode: 0o600 },
            )
          }
          throw error
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
  return analyze(out)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--trial-worker' && process.send) {
    process.once('message', async (input: TrialInput) => {
      try {
        process.send!(await runTrial(input))
        process.disconnect()
      } catch (error) {
        if (input.hostModule === localHost) {
          const { safeDiagnostic } = await import('./drivers/diagnostic.ts')
          process.send!({ failure: safeDiagnostic(error) })
        } else console.error(error instanceof Error ? error.message : 'Live trial failed')
        process.exitCode = 1
        process.disconnect()
      }
    })
  } else await run(process.argv.slice(2))
}
