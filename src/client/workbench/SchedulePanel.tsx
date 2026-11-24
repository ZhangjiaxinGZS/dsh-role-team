import { useState } from 'react'
import { Modal, Notice, useAction, useLoad, useUi } from '../ui.js'
import type { Input } from '../../shared/runtime.js'
import type { ScheduleRow, Timing } from '../../shared/schedules.js'

function defaultRule(kind: Timing['kind']): Timing {
  const time_zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const clock = { time: '09:00', time_zone }
  switch (kind) {
    case 'after':
      return { kind, after_seconds: 600 }
    case 'at':
      return { kind, at: new Date(Date.now() + 3600000).toISOString() }
    case 'daily':
      return { kind, daily: clock }
    case 'weekly':
      return { kind, weekly: { ...clock, weekdays: [1] } }
    case 'cron':
      return { kind, cron: { expression: '0 9 * * 1-5', time_zone } }
    case 'every':
      return { kind, every_seconds: 3600 }
    case 'rrule':
      return { kind, rrule: '' }
  }
}
const weekLabel = (n: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
    Date.UTC(2024, 0, n),
  )
function cadence(rule: Timing, t: ReturnType<typeof useUi>['t']) {
  switch (rule.kind) {
    case 'after':
    case 'every': {
      const seconds = rule.kind === 'after' ? rule.after_seconds : rule.every_seconds
      const duration = new Intl.NumberFormat(navigator.language, {
        style: 'unit',
        unit: 'second',
        unitDisplay: 'long',
      })
      return t(rule.kind) + ' · ' + duration.format(seconds)
    }
    case 'at':
      return t('at')
    case 'rrule':
      return rule.rrule
    case 'cron':
      return rule.cron.expression + ' · ' + rule.cron.time_zone
    case 'daily':
      return [t('daily'), rule.daily.time.replace(/:00(?:\.000)?$/, ''), rule.daily.time_zone].join(
        ' · ',
      )
    case 'weekly':
      return [
        rule.weekly.weekdays.map((n) => weekLabel(n, navigator.language)).join(', '),
        rule.weekly.time.replace(/:00(?:\.000)?$/, ''),
        rule.weekly.time_zone,
      ].join(' · ')
  }
}
function TimingFields({ rule, change }: { rule: Timing; change: (value: Timing) => void }) {
  const { t } = useUi()
  if (rule.kind === 'after' || rule.kind === 'every')
    return (
      <label>
        {t('seconds')}
        <input
          required
          type="number"
          min={rule.kind === 'after' ? 1 : 60}
          value={(rule.kind === 'after' ? rule.after_seconds : rule.every_seconds) || ''}
          onChange={(e) =>
            change(
              rule.kind === 'after'
                ? { kind: 'after', after_seconds: Number(e.target.value) }
                : { kind: 'every', every_seconds: Number(e.target.value) },
            )
          }
        />
      </label>
    )
  if (rule.kind === 'at') {
    const date = new Date(rule.at)
    const local = Number.isFinite(date.valueOf())
      ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
      : ''
    return (
      <label>
        {t('localTime')} · {Intl.DateTimeFormat().resolvedOptions().timeZone}
        <input
          required
          type="datetime-local"
          step="1"
          value={local}
          onChange={(e) =>
            change({ kind: 'at', at: e.target.value ? new Date(e.target.value).toISOString() : '' })
          }
        />
      </label>
    )
  }
  if (rule.kind === 'rrule')
    return (
      <label>
        {t('rrule')}
        <textarea
          required
          value={rule.rrule}
          onChange={(e) => change({ kind: 'rrule', rrule: e.target.value })}
        />
      </label>
    )
  const fields = rule.kind === 'cron' ? rule.cron : rule.kind === 'daily' ? rule.daily : rule.weekly
  function update(patch: { time_zone?: string; time?: string; expression?: string }) {
    if (rule.kind === 'cron') change({ kind: 'cron', cron: { ...rule.cron, ...patch } })
    if (rule.kind === 'daily') change({ kind: 'daily', daily: { ...rule.daily, ...patch } })
    if (rule.kind === 'weekly') change({ kind: 'weekly', weekly: { ...rule.weekly, ...patch } })
  }
  return (
    <>
      {rule.kind === 'cron' ? (
        <label>
          {t('cron')}
          <input
            required
            value={rule.cron.expression}
            onChange={(e) => update({ expression: e.target.value })}
          />
        </label>
      ) : (
        <label>
          {t('localTime')}
          <input
            type="time"
            step=".001"
            required
            value={rule.kind === 'daily' ? rule.daily.time : rule.weekly.time}
            onChange={(e) => update({ time: e.target.value })}
          />
        </label>
      )}
      <label>
        {t('timeZone')}
        <input
          required
          value={fields.time_zone}
          onChange={(e) => update({ time_zone: e.target.value })}
        />
      </label>
      {rule.kind === 'weekly' && (
        <fieldset>
          <legend>{t('weekdays')}</legend>
          <div className="rt-timer-days">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <label key={n}>
                <input
                  type="checkbox"
                  checked={rule.weekly.weekdays.includes(n)}
                  onChange={(e) =>
                    change({
                      kind: 'weekly',
                      weekly: {
                        ...rule.weekly,
                        weekdays: e.target.checked
                          ? [...rule.weekly.weekdays, n].sort()
                          : rule.weekly.weekdays.filter((day) => day !== n),
                      },
                    })
                  }
                />
                {weekLabel(n, navigator.language)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </>
  )
}

function Editor({
  runId,
  task,
  done,
  locked,
}: {
  runId: string
  task?: ScheduleRow
  done: () => void
  locked: ReturnType<typeof useAction>
}) {
  const { call, t } = useUi()
  const [title, setTitle] = useState(task?.title ?? ''),
    [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [rule, setRule] = useState(task?.timing ?? defaultRule('after'))
  const kinds: Timing['kind'][] = ['after', 'at', 'daily', 'weekly', 'cron']
  if (!kinds.includes(rule.kind)) kinds.push(rule.kind)
  return (
    <form
      className="rt-timer-form"
      onSubmit={(e) => {
        e.preventDefault()
        void locked.run(async () => {
          if (task)
            await call('changeTeamSchedule', {
              runId,
              id: task.id,
              expectedUpdatedAt: task.updatedAt,
              action: 'update',
              title,
              prompt,
              ...(JSON.stringify(rule) !== JSON.stringify(task.timing) && { timing: rule }),
            })
          else await call('createTeamSchedule', { runId, title, prompt, timing: rule })
          done()
        })
      }}
    >
      <label>
        {t('timerTitle')}
        <input
          autoFocus
          required
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        {t('timerPrompt')}
        <textarea required rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <label>
        {t('timerRule')}
        <select
          value={rule.kind}
          onChange={(e) => setRule(defaultRule(e.target.value as Timing['kind']))}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {t(k)}
            </option>
          ))}
        </select>
      </label>
      <TimingFields rule={rule} change={setRule} />
      <footer>
        <button type="button" disabled={locked.busy} onClick={done}>
          {t('cancel')}
        </button>
        <button
          className="rt-primary"
          disabled={locked.busy || (rule.kind === 'weekly' && !rule.weekly.weekdays.length)}
        >
          {t(task ? 'save' : 'create')}
        </button>
      </footer>
    </form>
  )
}

function History({ runId, task }: { runId: string; task: ScheduleRow }) {
  const { call, t } = useUi(),
    [before, setBefore] = useState<string>()
  const history = useLoad(
    JSON.stringify([runId, task.id, before]),
    () => call('teamScheduleHistory', { runId, id: task.id, before }),
    2500,
  )
  return (
    <section>
      <h4>
        {task.title} · {t('timerHistory')}
      </h4>
      <Notice>{history.error}</Notice>
      {!history.data ? (
        <p>{t('loading')}</p>
      ) : history.data.records.length ? (
        history.data.records.map((r) => (
          <article key={r.messageId}>
            <time>{new Date(r.deliveredAt).toLocaleString()}</time>
            <p>{r.prompt}</p>
          </article>
        ))
      ) : (
        <p>{t('emptyHistory')}</p>
      )}
      {before && <button onClick={() => setBefore(undefined)}>{t('latest')}</button>}
      {history.data?.nextBefore && (
        <button onClick={() => setBefore(history.data!.nextBefore!)}>{t('earlier')}</button>
      )}
    </section>
  )
}

export function SchedulePanel({
  runId,
  active,
  close,
}: {
  runId: string
  active: boolean
  close: () => void
}) {
  const { call, t } = useUi(),
    action = useAction()
  const tasks = useLoad(runId, () => call('teamSchedules', { runId }), 2500)
  const [editor, setEditor] = useState<ScheduleRow | 'new'>(),
    [history, setHistory] = useState<ScheduleRow>(),
    [deleting, setDeleting] = useState<string>()
  function list() {
    setEditor(undefined)
    setHistory(undefined)
    action.clear()
    tasks.refresh()
  }
  function apply(task: ScheduleRow, operation: Input<'changeTeamSchedule'>['action']) {
    void action.run(async () => {
      await call('changeTeamSchedule', {
        runId,
        id: task.id,
        expectedUpdatedAt: task.updatedAt,
        action: operation,
      })
      setDeleting(undefined)
      tasks.refresh()
    })
  }
  return (
    <Modal title={t('teamTimers')} close={close} locked={action.busy}>
      <Notice>{action.error || tasks.error}</Notice>
      {editor ? (
        <Editor
          runId={runId}
          task={editor === 'new' ? undefined : editor}
          done={list}
          locked={action}
        />
      ) : history ? (
        <>
          <History runId={runId} task={history} />
          <footer>
            <button onClick={list}>{t('back')}</button>
          </footer>
        </>
      ) : (
        <div className="rt-timer-list">
          {active && (
            <div>
              <button
                onClick={() => {
                  action.clear()
                  setEditor('new')
                }}
              >
                {t('newTimer')}
              </button>
            </div>
          )}
          {!tasks.data ? <p>{t('loading')}</p> : !tasks.data.length && <p>{t('emptyTimers')}</p>}
          {tasks.data?.map((task) => (
            <article key={task.id}>
              <strong>{task.title}</strong>
              <small>
                {cadence(task.timing, t)} ·{' '}
                {t(
                  task.status === 'active'
                    ? 'activeTimer'
                    : task.status === 'paused'
                      ? 'pausedTimer'
                      : 'endedTimer',
                )}
              </small>
              {task.status === 'active' && (
                <small>
                  {t('scheduledFor')} · {new Date(task.scheduledAt).toLocaleString()}
                </small>
              )}
              <p>{task.prompt}</p>
              {deleting === task.id ? (
                <div>
                  {t('deleteTimerHint')}{' '}
                  <button disabled={action.busy} onClick={() => setDeleting(undefined)}>
                    {t('cancel')}
                  </button>{' '}
                  <button disabled={action.busy} onClick={() => apply(task, 'delete')}>
                    {t('deleteTimer')}
                  </button>
                </div>
              ) : (
                <div className="rt-timer-actions">
                  <button onClick={() => setHistory(task)}>{t('timerHistory')}</button>
                  {active && (
                    <>
                      <button
                        disabled={action.busy}
                        onClick={() => {
                          action.clear()
                          setEditor(task)
                        }}
                      >
                        {t('edit')}
                      </button>
                      {task.status !== 'ended' && (
                        <button
                          disabled={action.busy}
                          onClick={() => apply(task, task.status === 'active' ? 'pause' : 'resume')}
                        >
                          {t(task.status === 'active' ? 'pauseTimer' : 'resumeTimer')}
                        </button>
                      )}
                      <button disabled={action.busy} onClick={() => apply(task, 'run')}>
                        {t('runTimer')}
                      </button>
                      <button disabled={action.busy} onClick={() => setDeleting(task.id)}>
                        {t('deleteTimer')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </Modal>
  )
}
