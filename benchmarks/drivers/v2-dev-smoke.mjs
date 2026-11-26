import { fork } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogue } from '../v2/scenarios.ts'
import { auditDigest, blocks, defaultLimits, scenarioLimits, stepLimits, mainArms, redact } from '../v2/protocol.ts'
import { blindPacket, interpret, blindId, blindSample, preferencePackets } from '../v2/review.ts'
import { reportV2, renderV2 } from '../v2/report.ts'
import { safeDiagnostic } from './diagnostic.ts'

const agent={provider:'deepseek-account',model:'deepseek-flash'}
const judge={provider:'openai-codex',model:'gpt-6.2-astra'}
const temperature='provider-default (stripped by openai-codex)'
const flags=process.argv.slice(process.argv[2]==='worker'?3:2)
if(flags.length>1 || flags.some(f=>!['--pilot','--l2-check'].includes(f)))throw Error('Expected --pilot, --l2-check, or no flag')
const l2Check=flags.includes('--l2-check')
const selected=l2Check?['L2']:flags.includes('--pilot')?['S1','G1','L2']:null
const phase=l2Check?'live-l2-check':selected?'live-pilot':'live-dev'
const scenarios=catalogue.filter(s=>s.split==='dev' && (!selected || selected.includes(s.id)))
const matrixFor=seed=>blocks(scenarios,1,seed).filter(job=>!selected || mainArms.includes(job.arm))
const out=fileURLToPath(new URL('../results/v2.1-'+(selected?phase:'live-dev-deepseek-flash')+'/',import.meta.url))
const file=(name)=>join(out,name)
const save=async(name,data)=>{
  await writeFile(file(name+'.tmp'), typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{mode:0o600})
  await rename(file(name+'.tmp'),file(name))
}
async function worker(job){
  const {withLocalHost}=await import('./local-host.ts')
  const {runIsolatedV2}=await import('./v2-host.ts')
  const {independentCoding,independentPreference}=await import('./v2-judges.ts')
  const root=process.cwd(), workspace=join(root,'work'),roleStore=join(root,'roles')
  const paths={workspace,roleStoreDir:roleStore,traceDir:join(root,'traces'),dshHome:join(root,'dsh')}
  for(const dir of Object.values(paths))await mkdir(dir,{mode:0o700})
  const scenario=scenarios.find(s=>s.id===job.scenario)
  if(!scenario || (selected && !mainArms.includes(job.arm)))throw Error('Job outside selected Dev matrix')
  return withLocalHost({...paths,arm:job.arm,model:'deepseek-account:deepseek-flash',preset:'standard'},async ctx=>{
    if(job.pairs){
      const pairs=[]
      for(const p of job.pairs)pairs.push({left:p.left.id,right:p.right.id,winner:await independentPreference(ctx,agent.provider,judge,p.left.text,p.right.text,p.task,AbortSignal.timeout(120000))})
      return {pairs}
    }
    const trial=await runIsolatedV2(ctx,{...job,scenario},{workspace,roleStore},agent,judge,scenarioLimits(scenario))
    trial.events=auditDigest(trial.events)
    trial.finalText=redact(trial.finalText)
    const rejectedBallots=[]
    let coding=null, judgeError=null
    try{
      const c=await independentCoding(ctx,agent.provider,judge,blindPacket(trial),AbortSignal.timeout(120000),rejectedBallots)
      interpret(trial,c)
      coding=c
    }catch(e){judgeError=safeDiagnostic(e)}
    return {trial,coding,judgeError,rejectedBallots}
  },true)
}
async function isolated(job){
  const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-benchmark-')))
  try{
    const env={PATH:process.env.PATH,HOME:join(root,'home'),CODEX_HOME:join(root,'codex'),DSH_HOME:join(root,'dsh'),TMPDIR:root,DSH_TELEMETRY_DISABLED:'1',XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_CACHE_HOME:join(root,'cache')}
    for(const k of ['BENCH_HOST_ANCHOR','BENCH_CODEX_PACKAGE','BENCH_V010_PACKAGE','BENCH_V020_PACKAGE'])env[k]=process.env[k]
    return await new Promise((resolve,reject)=>{
      const child=fork(fileURLToPath(import.meta.url),['worker',...flags],{cwd:root,env,execArgv:[],stdio:['ignore','ignore','ignore','ipc']})
      const timer=setTimeout(()=>child.kill('SIGKILL'),20*60000)
      let result
      child.on('message',m=>{result=m})
      child.once('error',reject)
      child.once('exit',()=>{clearTimeout(timer);result?.ok?resolve(result.value):reject(Error(result?.failure??'Worker exited without result'))})
      child.send(job)
    })
  }finally{await rm(root,{recursive:true,force:true})}
}
async function main(){
  await mkdir(out,{recursive:true,mode:0o700})
  await mkdir(file('audit'),{recursive:true,mode:0o700})
  let protocol
  try { protocol=JSON.parse(await readFile(file('protocol.json'),'utf8')) } catch(e) {
    if(e.code!=='ENOENT')throw e
    const seed='v2-dev-smoke-1'
    const matrix=matrixFor(seed).map(j=>({...j,scenario:j.scenario.id}))
    protocol={seed,split:'dev',repeats:1,agent:'deepseek-account:deepseek-flash',reasoningEffort:'high',judge:'openai-codex:gpt-6.2-astra',matrix}
  }
  const expected=matrixFor(protocol.seed)
  if(selected && (scenarios.length!==selected.length || expected.length!==selected.length*mainArms.length))throw Error('Invalid selected scope')
  if(protocol.matrix.length!==expected.length||expected.some((j,i)=>j.scenario.id!==protocol.matrix[i].scenario||j.arm!==protocol.matrix[i].arm||protocol.matrix[i].repeat!==1))throw Error('Invalid Dev matrix')
  delete protocol.requiredTemperature
  Object.assign(protocol,{temperature,version:'2.1',phase,mode:'live',limits:defaultLimits,stepLimits})
  protocol.reservation='admit while settled weighted cost < maxWeightedCostUnits; cancel on observed usage, steps or wall time'
  await save('protocol.json',protocol)
  await save('report.md','# Benchmark v2.1 · Dev 真机冒烟\n\n运行中。temperature: '+temperature+'。\n')
  await mkdir(file('trials'),{recursive:true,mode:0o700})
  const trials=[], coding={},detail=[], errors=[]
  for(const job of protocol.matrix){
    const path='trials/'+job.scenario+'_'+job.arm+'.json'
    let r
    try{r=JSON.parse(await readFile(file(path),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
    if(!r){
      console.log('Starting',job.scenario,job.arm)
      try{r=await isolated(job)}catch(e){errors.push({scenario:job.scenario,arm:job.arm,failure:e.message});await save('audit/interruptions.json',errors);console.log('Interrupted',e.message);break}
      await save(path,r)
    }
    const t=r.trial;trials.push(t)
    if(t.nonce!==job.nonce||t.scenario!==job.scenario||t.arm!==job.arm||t.split!=='dev')throw Error('Unexpected saved trial')
    if(r.coding)coding[blindId(t)]=r.coding
    detail.push({scenario:t.scenario,arm:t.arm,status:t.status,pass:t.verification.artifactPass,steps:t.steps,agentWallMs:t.clock.agentWallMs,judgeError:r.judgeError})
    console.log('Measured',JSON.stringify(detail.at(-1)))
    if(r.judgeError&&/401|403|429|UNAUTHORIZED|RATE_LIMITED/.test(r.judgeError))break
  }
  const ballots=preferencePackets(trials)
  let pairs=[]
  if(ballots.length)try{({pairs}=await isolated({...protocol.matrix.find(j=>j.scenario==='G3'),arm:'single-agent',pairs:ballots}))}catch(e){errors.push({stage:'pairwise judge',failure:e.message})}
  const summary=reportV2(trials,1,{coding,pairs},{scenarios,repeats:1,mode:'live',arms:selected?mainArms:undefined})
  await save('audit/human-review.json',trials.filter(t=>blindSample(trials).includes(blindId(t))).map(blindPacket))
  await save('audit/pairs.json',pairs)
  await save('summary.json',{mode:'live',temperature,planned:expected.length,completed:trials.length,detail,errors,...summary})
  const body=renderV2(summary,1).split('\n').slice(4).join('\n')
  await save('report.md','# Benchmark v2.1 · Dev 真机冒烟\n\n完成 '+trials.length+'/'+expected.length+' 个试次。temperature: '+temperature+'。\n\n'+errors.map(e=>'中断 '+JSON.stringify(e)).join('\n')+'\n\n'+body)
}
if(process.argv[2]==='worker'&&process.send){
 process.once('message',async j=>{let m;try{m={ok:true,value:await worker(j)}}catch(e){m={failure:safeDiagnostic(e)}}process.send(m,()=>process.exit(m.ok?0:1))})
}else await main()
