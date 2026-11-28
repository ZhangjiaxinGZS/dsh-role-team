import { describe, expect, it } from 'vitest'
import { checkCoachingEdit } from '../src/host/training/write-boundary.js'

describe('new coaching text', () => {
  it.each([
    '每次执行 bash 后，都要核对返回码，失败要先调查再继续。',
    '后台作业依靠完成通知推进，不要轮询或休眠。',
    '最终回复前取回后台任务的结果，再清理不需要的作业。',
    '只有用户明确要求时才创建目标。恢复后要重新激活活跃目标。',
    '遇到相同条件连续三轮未解决才能标记阻塞，并把情况写进 blocked_reason。',
    '只有用户明确要求多代理编排时，才使用工作流工具，把 JS 脚本分阶段执行并返回结构化结果。',
    '一两次委派优先直接调用子代理。',
    '私教时长期职责通过 update_role 写入，修正已有经验时调用 revise_experience。',
    'Mark a goal blocked only after three consecutive rounds with the same obstacle.',
    'Use the workflow tool only on explicit request for large multi-agent orchestration.',
    'Use the `workflow` tool only when explicitly requested.',
    'Prefer plain subagent calls for one or two delegations.',
    'Omit name unless explicitly renaming the role with update_role.',
  ])('rejects an operating instruction: %s', (part) => {
    expect(() => checkCoachingEdit('body', 'old', part, 'zh')).toThrow(/未保存.*body.*重试/)
  })

  it.each([
    '负责维护项目的 bash 测试脚本。',
    '维护审批 workflow 状态机和它的退出码测试。',
    '负责维护 update_role 的长期职责字段，以及 revise_experience 接口的已保存经验查询。',
    '后台任务测试夹具区分完成通知和轮询两种状态。',
    '称呼我小林。每周五用中文汇总。',
    '项目任务表的 blocked_reason 存储审批被拒的业务原因。',
    'Exercise the workflow JS parser with fixtures and verify the generated phases.',
    'Compare job_output and job_kill in the job API compatibility matrix.',
    'src/plugin/customParseFormat/index.js is the public plugin entry. Check a strict-format fixture again after upgrading Day.js.',
  ])('accepts a duty, preference or observation: %s', (part) => {
    expect(() => checkCoachingEdit('body', undefined, part, 'en')).not.toThrow()
  })

  it('allows an unchanged list item but checks a second copy of it', () => {
    const item = '- Use remember_experience for reusable lessons.'
    expect(() => checkCoachingEdit('body', item, item + '\n- Review public fixtures.', 'en')).not.toThrow()
    expect(() => checkCoachingEdit('body', '# Old\n' + item, '# New\n' + item, 'en')).not.toThrow()
    expect(() => checkCoachingEdit('body', item, item + '\n' + item, 'en')).toThrow(/Not saved/)
  })
})
