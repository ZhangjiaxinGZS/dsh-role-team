import { afterEach, expect, it, vi } from 'vitest'
import semver from 'semver'
import pkg from 'dsh-role-team/package.json' with { type: 'json' }
import { ReleaseCheck } from '../src/host/release-check.js'

const next = semver.inc(pkg.version, 'minor')!
const release = (tag: string) => Response.json({ tag_name: tag, html_url: 'https://untrusted.example/' })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

it.each([
  [`v${next}`, next, true],
  [next + '-beta.12', next + '-beta.12', true],
  [pkg.version, pkg.version, false],
  [pkg.version + '+build.7', pkg.version + '+build.7', false],
  [pkg.version + '-rc.1', pkg.version + '-rc.1', false],
  ['0.0.0', '0.0.0', false],
  ['v01.4.0', null, false], ['v2.0', null, false], ['v2.0.0-alpha.01', null, false],
  ['=2.0.0', null, false], ['vv2.0.0', null, false], ['v2.0.0 ', null, false],
] as const)('checks release tag %s using SemVer precedence', async (tag, latestVersion, hasUpdate) => {
  const fetch = vi.fn().mockResolvedValue(release(tag))
  vi.stubGlobal('fetch', fetch)
  const checker = new ReleaseCheck(() => true)
  expect(fetch).not.toHaveBeenCalled()
  const result = await checker.check()
  expect(result).toEqual({ enabled: true, currentVersion: pkg.version, latestVersion, hasUpdate,
    releaseUrl: 'https://github.com/ZhangjiaxinGZS/dsh-role-team/releases' +
      (latestVersion ? '/tag/' + encodeURIComponent(tag) : '') })
  expect(fetch).toHaveBeenCalledWith('https://api.github.com/repos/ZhangjiaxinGZS/dsh-role-team/releases/latest',
    { credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) })
})

it('shares in-flight checks, caches six hours and supports forced refresh', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async () => release(next))
  vi.stubGlobal('fetch', fetch)
  const checker = new ReleaseCheck(() => true)
  await Promise.all([checker.check(), checker.check(true)])
  vi.advanceTimersByTime(6 * 3600_000 - 1)
  await checker.check()
  expect(fetch).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(1)
  await checker.check()
  expect(fetch).toHaveBeenCalledTimes(2)
  await checker.check(true)
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('makes no requests when disabled, even for forced checks and cached results', async () => {
  let enabled = false
  const fetch = vi.fn(async () => release(next))
  vi.stubGlobal('fetch', fetch)
  const checker = new ReleaseCheck(() => enabled)
  expect(await checker.check(true)).toMatchObject({ enabled: false, hasUpdate: false })
  expect(fetch).not.toHaveBeenCalled()
  enabled = true
  expect((await checker.check()).hasUpdate).toBe(true)
  enabled = false
  expect((await checker.check()).hasUpdate).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('silently caches network and rate-limit failures and retries on force', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(release(next))
  vi.stubGlobal('fetch', fetch)
  const checker = new ReleaseCheck(() => true)
  const fallback = await checker.check()
  expect(fallback).toMatchObject({ enabled: true, hasUpdate: false, latestVersion: null })
  expect(await checker.check()).toEqual(fallback)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await checker.check(true)).toEqual(fallback)
  expect((await checker.check(true)).hasUpdate).toBe(true)
})

it('silently aborts the GitHub request after five seconds', async () => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const c = new AbortController()
    setTimeout(() => c.abort(), ms)
    return c.signal
  })
  const fetch = vi.fn((_url: string, { signal }: RequestInit) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason))
  }))
  vi.stubGlobal('fetch', fetch)
  const promise = new ReleaseCheck(() => true).check()
  const signal = fetch.mock.calls[0][1].signal!
  await vi.advanceTimersByTimeAsync(4999)
  expect(signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(signal.aborted).toBe(true)
  expect(await promise).toMatchObject({ enabled: true, hasUpdate: false })
})
