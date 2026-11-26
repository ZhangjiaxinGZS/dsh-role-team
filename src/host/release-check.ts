import semver from 'semver'
import pkg from 'dsh-role-team/package.json' with { type: 'json' }
import type { UpdateInfo } from '../shared/runtime.js'

const repository = 'ZhangjiaxinGZS/dsh-role-team'
const releases = `https://github.com/${repository}/releases`
const ttl = 6 * 60 * 60 * 1000

export class ReleaseCheck {
  private cache?: { result: UpdateInfo; until: number }
  private pending?: Promise<UpdateInfo>

  constructor(private readonly enabled: () => boolean) {}

  private empty(enabled: boolean): UpdateInfo {
    return { enabled, currentVersion: pkg.version, latestVersion: null, hasUpdate: false, releaseUrl: releases }
  }

  async check(force = false): Promise<UpdateInfo> {
    if (!this.enabled()) return this.empty(false)
    if (!this.pending && !force && this.cache && Date.now() < this.cache.until) return this.cache.result
    this.pending ??= this.latest().then(result => {
      this.cache = { result, until: Date.now() + ttl }
      return result
    }).finally(() => { this.pending = undefined })
    const result = await this.pending
    return this.enabled() ? result : this.empty(false)
  }

  private async latest(): Promise<UpdateInfo> {
    const result = this.empty(true)
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        signal: AbortSignal.timeout(5000), redirect: 'error', credentials: 'omit',
      })
      if (!response.ok) return result
      const { tag_name: tag } = await response.json()
      if (typeof tag !== 'string') return result
      const version = tag.replace(/^v/, '')
      if (!/^\d/.test(version) || version.trim() !== version || !semver.valid(version)) return result
      return { ...result, latestVersion: version, hasUpdate: semver.gt(version, pkg.version),
        releaseUrl: `${releases}/tag/${encodeURIComponent(tag)}` }
    } catch {
      return result
    }
  }
}
