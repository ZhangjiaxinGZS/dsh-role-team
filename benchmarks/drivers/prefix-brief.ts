import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../src/host/index.ts'

/** Trial-local change of transport. The base plugin still owns brief updates and authorization. */
export function installPrefixBrief(ctx: Context, currentRun: () => string) {
  ctx.on(
    'system-prompt/assemble',
    async (_assembly, _context, next) => {
      const base = await next()
      const runId = currentRun()
      const brief = runId && (await ctx.roleTeam.getTeamBrief({ runId }))
      if (!brief || !brief.text.trim()) return base
      const text = [
        `<team-brief-update updated_at="${brief.updatedAt}" updated_by="${brief.updatedBy}">`,
        'Note: The user’s latest direct instruction always overrides this brief.',
        brief.text,
        '</team-brief-update>',
      ].join('\n')
      return {
        ...base,
        sections: [{ name: 'benchmark-team-brief', text, interpolate: false }, ...base.sections],
      }
    },
    { prepend: true },
  )
  ctx.on(
    'agent/pre-step',
    async (_payload, next) => {
      const d = await next()
      return d.kind === 'enter'
        ? { ...d, messages: d.messages.filter((m) => m.source.kind !== 'team-brief') }
        : d
    },
    { prepend: true },
  )
}
