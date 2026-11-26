import type { V2Scenario, V2Arm } from '../types.ts'
import type { Trial } from './driver.ts'
import { effectiveCost } from '../stats.ts'
import { armsFor, mainArms, tierOf } from './protocol.ts'

const allArms: V2Arm[] = [...mainArms, 'v0.2.0-brief-only', 'v0.2.0-prefix-brief']
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length

export type ReportMode = 'offline' | 'live'
export function scorecard(trials: Trial[], scenarios: V2Scenario[], repeats: number, mode: ReportMode, arms = allArms) {
  const matrix = scenarios.map((s) => ({
    scenario: s.id,
    tier: tierOf(s.id),
    cells: arms.map((arm) => {
      if (!armsFor(s).includes(arm)) return 'N/A'
      const rows = trials.filter((t) => t.scenario === s.id && t.arm === arm)
      const passes = rows.filter((t) => t.verification.artifactPass).length
      const missing = repeats - rows.length
      if (missing)
        return (
          (mode === 'live' ? 'ERR/MISSING' : 'Incomplete fixture matrix') +
          ' (' +
          rows.length +
          '/' +
          repeats +
          ')'
        )
      return (passes === rows.length ? '🟢' : passes ? '🟡' : '🔴') + ' ' + passes + '/' + rows.length
    }),
  }))
  const tiers = (['S', 'M', 'L'] as const).map((tier) => {
    const eligible = scenarios.filter((s) => tierOf(s.id) === tier && !s.multiAgentOnly)
    const samples = mainArms.map(() => [] as { quality: number; experience: number; economy: number }[])
    for (const s of eligible)
      for (let i = 1; i <= repeats; i++) {
        const group = mainArms.map((a) =>
          trials.find((t) => t.scenario === s.id && t.arm === a && t.repeat === i),
        )
        if (!group.every((t) => t !== undefined)) continue
        const costs = group.map((t) => effectiveCost(t.metrics, 0).units)
        const times = group.map((t) => t.clock.agentWallMs)
        for (const [j, t] of group.entries()) {
          const corrections = t.events.filter((e) => e.type === 'user/correction').length
          const dispatches =
            tier === 'S' ? t.events.filter((e) => e.actor === 'lead' && e.tool === 'send_message').length : 0
          const quality = 100 * (Number(t.verification.artifactPass) * 0.8 + t.verification.milestone * 0.2)
          const experience = 100 / (1 + corrections + dispatches)
          const economy =
            50 * ((Math.min(...costs) + 1) / (costs[j] + 1) + (Math.min(...times) + 1) / (times[j] + 1))
          samples[j].push({ quality, experience, economy })
        }
      }
    const ranking = samples
      .flatMap((rows, j) => {
        if (!rows.length) return []
        const quality = mean(rows.map((r) => r.quality)),
          experience = mean(rows.map((r) => r.experience)),
          economy = mean(rows.map((r) => r.economy))
        return [
          {
            arm: mainArms[j],
            n: rows.length,
            quality,
            experience,
            economy,
            score: 0.5 * quality + 0.25 * experience + 0.25 * economy,
          },
        ]
      })
      .sort((a, b) => b.score - a.score)
    return { tier, planned: eligible.length * repeats, ranking }
  })
  const stops: Record<string, number> = {}
  for (const t of trials) if (t.cap) stops[t.cap] = (stops[t.cap] ?? 0) + 1
  return { arms, matrix, tiers, stops }
}
export function decisionLines(board: ReturnType<typeof scorecard>) {
  const lines = [
    '## 一页决策总榜',
    '',
    '同题同轮的三个主臂配对计分，定向消融与仅限团队题单列在矩阵。各维度为 0–100 分；综合分 = 50% 交付质量 + 25% 协作体验 + 25% 经济效率。交付按 80% 最终通过 + 20% 里程碑；体验代理为 100/(1+用户纠正次数+简单题派工消息数)；经济为本组最低成本与最低耗时相对各臂的比率各半（分子分母均加 1）。离线时间为确定性事件时钟。',
    '',
    '| 难度 | 臂 | 配对数/计划 | 交付质量 | 协作体验 | 经济效率 | 综合 |',
    '|---|---|---:|---:|---:|---:|---:|',
  ]
  for (const { tier, ranking, planned } of board.tiers)
    for (const r of ranking)
      lines.push(
        '| ' +
          [
            tier,
            r.arm,
            r.n + '/' + planned,
            ...[r.quality, r.experience, r.economy, r.score].map((x) => x.toFixed(2)),
          ].join(' | ') +
          ' |',
      )
  lines.push('')
  for (const { tier, ranking } of board.tiers) {
    if (!ranking.length) {
      lines.push('- ' + tier + ' 档缺少可配对数据。')
      continue
    }
    const winners = ranking.filter((r) => Math.abs(r.score - ranking[0].score) < 1e-9),
      last = ranking.at(-1)!
    const losers = ranking.filter((r) => Math.abs(r.score - last.score) < 1e-9)
    const dim = (['quality', 'experience', 'economy'] as const)
      .map((key, i) => ({
        name: ['交付质量', '协作体验', '经济效率'][i],
        gap: (ranking[0][key] - last[key]) * (i === 0 ? 0.5 : 0.25),
      }))
      .sort((a, b) => b.gap - a.gap)[0]
    lines.push(
      '- ' +
        tier +
        ' 档 🏆 ' +
        winners.map((r) => r.arm).join(' / ') +
        '；⚠️ ' +
        losers.map((r) => r.arm).join(' / ') +
        '。' +
        (dim.gap < 1e-9
          ? '三维得分持平。'
          : dim.name + '对首尾综合分差贡献最大（' + dim.gap.toFixed(2) + ' 分）。'),
    )
  }
  lines.push(
    '',
    '## 逐题红绿灯',
    '',
    '🟢 全通过 · 🟡 部分通过 · 🔴 全失败（含协议中止） · N/A 该任务、臂或指标不适用 · SKIPPED (offline) 离线运行按协议跳过线上裁判 · ERR/MISSING 真机应采集的试次或评分缺失（含全部票据被拒）。',
    '',
    '| 题 | 档 | ' + board.arms.join(' | ') + ' |',
    '|---|---|' + board.arms.map(() => '---').join('|') + '|',
  )
  for (const r of board.matrix) lines.push('| ' + [r.scenario, r.tier, ...r.cells].join(' | ') + ' |')
  lines.push(
    '',
    '硬闸统计：已识别的重复失败循环 ' +
      (board.stops.repeatedFailureLoop ?? 0) +
      '，加权成本 ' +
      (board.stops.maxWeightedCostUnits ?? 0) +
      '，步数 ' +
      (board.stops.maxSteps ?? 0) +
      '，时钟 ' +
      (board.stops.maxWallMs ?? 0) +
      '。仅撞步数或时钟上限不足以认定死循环。',
    '',
  )
  return lines
}
