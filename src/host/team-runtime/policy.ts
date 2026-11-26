import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { IndexRecord, LeaderPolicy } from '../../shared/index.js'
import { delegationTemplate } from '../../shared/policy.js'
import { digest } from '../role-store/markdown.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-policy': {
      kind: 'team-policy'
      form: 'notice'
      summary: string
      policyHash: string
      mode: LeaderPolicy['mode']
    }
  }
}

export function policyNotice(run: IndexRecord<'team_runs'>, seenHash: string | null | undefined) {
  const { mode, customText } = run.leaderPolicy ?? { mode: 'delegate' }
  const locale = run.locale ?? 'zh'
  const rules = mode === 'delegate' ? delegationTemplate[locale]
    : mode === 'custom' ? customText?.trim()
    : locale === 'en' ? 'Collaborate freely. Delegate only when the user explicitly @mentions a member or you judge that collaboration is needed.'
    : '按自由协作模式工作，仅在用户明确 @ 点名成员或你判断有必要时派发任务。'
  if (!rules) return null
  const priority = locale === 'en' ? 'The user’s latest direct instruction always takes precedence.' : '用户最新直接指令始终优先。'
  const text = rules + '\n' + priority
  const policyHash = digest(mode + '\n' + text)
  if (policyHash === seenHash) return null
  return createUserMessage({
    source: { kind: 'team-policy', form: 'notice', mode, policyHash,
      summary: locale === 'en' ? 'Leader collaboration policy synced' : '已同步队长协作策略' },
    content: [{ type: 'text', text: `<team-leader-policy mode="${mode}">\n${text}\n</team-leader-policy>` }],
  })
}
