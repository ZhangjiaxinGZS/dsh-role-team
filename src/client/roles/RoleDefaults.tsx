import { useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  permissionPresetId,
  type FileContents,
  type ModelChoice,
  type PermissionPresetId,
  type RoleMeta,
} from '../../shared/index.js'
import { serializeMarkdown } from '../../shared/markdown.js'
import { Modal, Notice, useAction, useLoad, useUi, type Labels } from '../ui.js'
import type { Departure, ProfileGuard } from './DocumentEditor.js'

type ModelEntry = {
  provider: string
  model: string
  name: string
  defaultEffort?: string
  efforts: { id: string; name: string }[]
  isDefault?: boolean
}

const PERMISSION_LABELS: Record<PermissionPresetId, Labels> = {
  'read-only': 'readOnlyMode',
  'workspace-write': 'workspaceWrite',
  auto: 'autoMode',
  'danger-full-access': 'fullAccess',
}

const modelKey = (provider: string, model: string) => provider + '\0' + model

const sameModel = (a?: ModelChoice, b?: ModelChoice) =>
  a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort

function resolveInitialModel(entries: ModelEntry[]): ModelChoice | undefined {
  const entry = entries.find((e) => e.isDefault) ?? entries[0]
  if (!entry) return undefined
  const effort =
    entry.defaultEffort && entry.efforts.some((ef) => ef.id === entry.defaultEffort)
      ? entry.defaultEffort
      : undefined
  return {
    provider: entry.provider,
    model: entry.model,
    ...(effort ? { reasoningEffort: effort } : {}),
  }
}

export function useRoleDefaultCatalogs() {
  const { call, permissions, t } = useUi()
  const models = useLoad('role-defaults-models', async () => {
    try {
      return (await call('seatModels', {})) ?? []
    } catch {
      return [] as ModelEntry[]
    }
  })
  const permCatalog = useLoad('role-defaults-permissions', async () => {
    try {
      return (await permissions?.list()) ?? null
    } catch {
      return null
    }
  })

  const entries = models.data ?? []
  const availablePermissions = useMemo(() => {
    const allowed = new Set<string>(permissionPresetId.options)
    return (permCatalog.data?.options ?? [])
      .filter((o): o is { value: PermissionPresetId; name: string } => allowed.has(o.value))
      .map((o) => ({ value: o.value, label: t(PERMISSION_LABELS[o.value]) || o.name }))
  }, [permCatalog.data, t])

  const initialModel = useMemo(() => resolveInitialModel(entries), [entries])
  const initialPermission = availablePermissions.find(o => o.value === permCatalog.data?.defaultPreset)?.value

  return { entries, availablePermissions, initialModel, initialPermission }
}

export function RoleDefaultsFields({
  entries,
  availablePermissions,
  model,
  permission,
  onModelChange,
  onPermissionChange,
  disabled = false,
}: {
  entries: ModelEntry[]
  availablePermissions: { value: PermissionPresetId; label: string }[]
  model?: ModelChoice
  permission?: PermissionPresetId
  onModelChange: (next: ModelChoice | undefined) => void
  onPermissionChange: (next: PermissionPresetId | undefined) => void
  disabled?: boolean
}) {
  const { t } = useUi()

  const grouped = useMemo(() => {
    const map = new Map<string, ModelEntry[]>()
    for (const entry of entries) {
      const list = map.get(entry.provider) ?? []
      list.push(entry)
      map.set(entry.provider, list)
    }
    return [...map.entries()]
  }, [entries])

  const selectedEntry = model
    ? entries.find((e) => e.provider === model.provider && e.model === model.model)
    : undefined
  const modelValue = model ? modelKey(model.provider, model.model) : ''
  const missingModel = !!model && !selectedEntry
  const noModels = entries.length === 0 && !model

  const missingPermission = !!permission && !availablePermissions.some((o) => o.value === permission)
  const efforts = selectedEntry?.efforts ?? []
  const showEffort = efforts.length > 0 || !!model?.reasoningEffort
  const missingEffort =
    !!model?.reasoningEffort && !efforts.some((e) => e.id === model.reasoningEffort)

  return (
    <>
      <label>
        {t('defaultModel')}
        <select
          aria-label={t('defaultModel')}
          disabled={disabled || noModels}
          value={modelValue}
          onChange={(e) => {
            const raw = e.target.value
            if (!raw) return
            const sep = raw.indexOf('\0')
            const provider = raw.slice(0, sep)
            const id = raw.slice(sep + 1)
            const target = entries.find((item) => item.provider === provider && item.model === id)
            const keptEffort =
              model?.reasoningEffort && target?.efforts.some((ef) => ef.id === model.reasoningEffort)
                ? model.reasoningEffort
                : target?.defaultEffort && target.efforts.some((ef) => ef.id === target.defaultEffort)
                  ? target.defaultEffort
                  : undefined
            onModelChange({
              provider,
              model: id,
              ...(keptEffort ? { reasoningEffort: keptEffort } : {}),
            })
          }}
        >
          {noModels && <option value="">{t('noModels')}</option>}
          {missingModel && (
            <option value={modelValue}>
              {model.provider} / {model.model} · {t('unavailableModel')}
            </option>
          )}
          {grouped.length > 1
            ? grouped.map(([provider, list]) => (
                <optgroup key={provider} label={provider}>
                  {list.map((entry) => (
                    <option key={modelKey(entry.provider, entry.model)} value={modelKey(entry.provider, entry.model)}>
                      {entry.name}
                    </option>
                  ))}
                </optgroup>
              ))
            : entries.map((entry) => (
                <option key={modelKey(entry.provider, entry.model)} value={modelKey(entry.provider, entry.model)}>
                  {entry.name}
                </option>
              ))}
        </select>
      </label>
      {model && showEffort && (
        <label>
          {t('effort')}
          <select
            aria-label={t('effort')}
            disabled={disabled}
            value={model.reasoningEffort ?? ''}
            onChange={(e) => {
              const reasoningEffort = e.target.value || undefined
              onModelChange({
                provider: model.provider,
                model: model.model,
                ...(reasoningEffort ? { reasoningEffort } : {}),
              })
            }}
          >
            <option value="">{t('modelDefault')}</option>
            {missingEffort && (
              <option value={model.reasoningEffort}>
                {model.reasoningEffort} · {t('unavailableModel')}
              </option>
            )}
            {efforts.map((ef) => (
              <option key={ef.id} value={ef.id}>
                {ef.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t('defaultPermission')}
        <select
          aria-label={t('defaultPermission')}
          disabled={disabled || (!permission && availablePermissions.length === 0)}
          value={permission ?? ''}
          onChange={(e) => {
            const raw = e.target.value
            if (raw) onPermissionChange(raw as PermissionPresetId)
          }}
        >
          {!permission && <option value="">{t(availablePermissions.length ? 'hostDefault' : 'unavailableModel')}</option>}
          {missingPermission && (
            <option value={permission}>
              {t(PERMISSION_LABELS[permission])} · {t('unavailableModel')}
            </option>
          )}
          {availablePermissions.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}

export function RoleDefaultsPanel({
  roleId,
  file,
  meta,
  body,
  guard,
  changed,
}: {
  roleId: string
  file: FileContents | null
  meta: RoleMeta
  body: string
  guard?: ProfileGuard
  changed: () => void
}) {
  const { call, t } = useUi()
  const action = useAction()
  const { entries, availablePermissions, initialModel, initialPermission } = useRoleDefaultCatalogs()
  const [model, setModel] = useState<ModelChoice | undefined>(meta.defaultModel)
  const [permission, setPermission] = useState<PermissionPresetId | undefined>(meta.defaultPermission)
  const [touched, setTouched] = useState(false)
  const [observed, setObserved] = useState(file?.hash)
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [departure, setDeparture] = useState<Departure>()

  const effectiveModel = model ?? initialModel
  const effectivePermission = permission ?? initialPermission
  const canSave =
    (effectiveModel !== undefined && !sameModel(effectiveModel, meta.defaultModel)) ||
    (effectivePermission !== undefined && effectivePermission !== meta.defaultPermission)

  if (file?.hash !== observed) {
    setObserved(file?.hash)
    if (touched) setConflict(true)
    else if (!conflict) {
      setModel(meta.defaultModel)
      setPermission(meta.defaultPermission)
    }
  }

  useEffect(() => {
    if (!touched && meta.defaultModel === undefined && model !== undefined) setModel(undefined)
    if (!touched && meta.defaultPermission === undefined && permission !== undefined) setPermission(undefined)
  }, [touched, meta.defaultModel, meta.defaultPermission, model, permission])

  useImperativeHandle(guard, () => (request: Departure) => {
    if (action.busy) return
    if (touched || conflict) setDeparture(request)
    else request.proceed()
  })

  const save = (afterSave?: (savedHash?: string) => void) =>
    action.run(async () => {
      try {
        const { defaultModel: _m, defaultPermission: _p, ...rest } = meta
        const nextMeta: RoleMeta = {
          ...rest,
          ...(effectiveModel ? { defaultModel: effectiveModel } : {}),
          ...(effectivePermission ? { defaultPermission: effectivePermission } : {}),
        }
        const result = await call('saveDocument', {
          roleId,
          text: serializeMarkdown(nextMeta, body),
          expectedHash: file?.hash ?? null,
        })
        if (!result.ok) {
          if (result.code === 'conflict') {
            setConflict(true)
            return
          }
          throw new Error(result.error.message)
        }
        if (result.status.error) throw new Error(result.status.error.message)
        setModel(effectiveModel)
        setPermission(effectivePermission)
        setTouched(false)
        setConflict(false)
        setSaved(true)
        changed()
        afterSave?.(result.hash ?? undefined)
      } finally {
        setDeparture(undefined)
      }
    })

  return (
    <section className="rt-defaults" aria-label={t('defaultsTab')}>
      {departure && (
        <Modal title={t('savedDirty')} close={() => setDeparture(undefined)} locked={action.busy}>
          <p>{t(departure.kind === 'collapse' ? 'unsavedCollapse' : 'unsavedSwitch')}</p>
          <Notice>{conflict ? t('conflict') : action.error}</Notice>
          <footer>
            <Button
              size="sm"
              variant="outline"
              data-modal-autofocus
              disabled={action.busy}
              onClick={() => setDeparture(undefined)}
            >
              {t('keepEditing')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={action.busy}
              onClick={() => {
                setModel(meta.defaultModel)
                setPermission(meta.defaultPermission)
                setTouched(false)
                setConflict(false)
                departure.proceed()
              }}
            >
              {t(departure.kind === 'collapse' ? 'discardCollapse' : 'discardSwitch')}
            </Button>
            <Button
              size="sm"
              disabled={action.busy || conflict}
              onClick={() => save(departure.proceed)}
            >
              {t(departure.kind === 'collapse' ? 'saveCollapse' : 'saveSwitch')}
            </Button>
          </footer>
        </Modal>
      )}
      <RoleDefaultsFields
        entries={entries}
        availablePermissions={availablePermissions}
        model={effectiveModel}
        permission={effectivePermission}
        disabled={action.busy}
        onModelChange={(next) => {
          setModel(next)
          setTouched(true)
          setSaved(false)
        }}
        onPermissionChange={(next) => {
          setPermission(next)
          setTouched(true)
          setSaved(false)
        }}
      />
      <small>{t('defaultsEffectHint')}</small>
      <Notice>{conflict ? t('conflict') : action.error}</Notice>
      {conflict && (
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setConflict(false)
              setTouched(false)
              setModel(meta.defaultModel)
              setPermission(meta.defaultPermission)
              changed()
            }}
          >
            {t('useDisk')}
          </Button>
        </div>
      )}
      <footer>
        <small>{t(saved ? 'saved' : touched ? 'savedDirty' : 'editNext')}</small>
        {touched && (
          <Button
            size="sm"
            variant="outline"
            disabled={action.busy}
            onClick={() => {
              setModel(meta.defaultModel)
              setPermission(meta.defaultPermission)
              setTouched(false)
              setConflict(false)
              setSaved(false)
            }}
          >
            {t('cancel')}
          </Button>
        )}
        <button
          type="button"
          className="rt-primary"
          disabled={action.busy || !canSave || conflict}
          onClick={() => save()}
        >
          {t('save')}
        </button>
      </footer>
    </section>
  )
}
