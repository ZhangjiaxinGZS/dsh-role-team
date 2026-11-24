import type { Context } from '@deepseek-ai/cordis'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { UserTextNodeProps, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Ui } from '../ui.js'

const source = 'role-team-member'
const teamSession = /^rt-(root|child)-/
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'role-team-member': { label: string }
  }
}

function mention(label: string, runId: string, seatId: string) {
  const escaped = label.replace(/[\\[\]]/gu, '\\$&').replace(/[\r\n]+/gu, ' ')
  return `@[${escaped}](role-team:${runId}/${seatId})`
}

export const memberRule: UserTextRule<typeof source> = {
  id: source,
  order: 5,
  match(text, from) {
    const token = /@\[((?:\\[\\\[\]]|[^\\\[\]\r\n])+)\]\(role-team:[\w-]+\/[\w-]+\)/gu
    token.lastIndex = from
    const m = token.exec(text)
    if (m) return { id: source, start: m.index, end: token.lastIndex, data: { label: m[1].replace(/\\([\\\[\]])/gu, '$1') } }
  },
}

function MemberChip({ node, raw, sessionId }: UserTextNodeProps<typeof source>) {
  return teamSession.test(sessionId)
    ? <ReferenceChip appearance="session" title={node.data.label} label={'@' + node.data.label} />
    : <>{raw}</>
}

export function memberSource(call: Ui['call'], t: Ui['t']): InputTriggerSource {
  return {
    trigger: '@', name: source, order: -10, showGroupTitle: false,
    async candidates({ sessionId }, { query, signal, quoted, drilled }) {
      if (signal.aborted || drilled || quoted || !teamSession.test(sessionId)) return []
      const team = await call('teamMentionRoster', { sessionId })
      if (!team || signal.aborted || !team.members.length) return []
      const everyone = t('mentionEveryone')
      const names = new Set([everyone])
      const repeated = new Set<string>()
      for (const { name } of team.members) {
        if (names.has(name)) repeated.add(name)
        names.add(name)
      }
      const rows = team.members.map(m => ({
        label: repeated.has(m.name) ? m.name + ' · ' + m.address : m.name,
        description: [m.leader ? t('leader') : '', m.duty].filter(Boolean).join(' · '),
        seatId: m.seatId, address: m.address,
      }))
      rows.push({ label: everyone, seatId: 'all', address: 'all', description: '' })
      const filter = query.trim().toLowerCase()
      return rows.filter(r => [r.label, r.address, r.description].some(s => s.toLowerCase().includes(filter)))
        .map(r => ({ name: r.label, section: t('mentionGroup'), description: r.description, icon: 'session',
          value: mention(r.label, team.runId, r.seatId) }))
    },
    onPick({ candidate }) {
      if (candidate.value) return { insert: { source, ref: candidate.value,
        label: '@' + candidate.name, appearance: 'session', clipboardText: candidate.value } }
    },
    codec: { clipboardText: ref => ref, serialize: async ref => ref },
  }
}

export function registerTeamMentions(ctx: Context, call: Ui['call'], t: Ui['t']) {
  ctx.effect(() => ctx.inputTriggers.registerSource(memberSource(call, t)))
  ctx.uiConversation.userText.register(memberRule)
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: source,
  }, MemberChip))
}
