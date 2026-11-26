// Provider exceptions can contain request headers. Transport only bounded categories and source locations.
export function safeDiagnostic(value: unknown): string {
  if (!(value instanceof Error)) return 'Live host failed'
  const messages: string[] = []
  for (let e: unknown = value; e instanceof Error && messages.length < 5; e = e.cause) {
    const code =
      /\b(?:TOKEN_EXPIRED|QUOTA_EXCEEDED|INVALID_CREDENTIAL|UNAUTHORIZED|RATE_LIMITED|429|401|403)\b/i.exec(
        e.message,
      )
    const bounded =
      /^(?:Model turn failed: [A-Z_0-9]+(?: HTTP \d{3})?|Leader response missing measured inputTokens\/cacheReadTokens|Missing leader model response|A leader trace is required)$/.test(
        e.message,
      )
    const missing = /Cannot find (?:module|package) ['"](@deepseek-ai\/[a-z0-9-]+|[a-z0-9-]+)['"]/.exec(
      e.message,
    )
    const sites = [...(e.stack ?? '').matchAll(/\/([\w.-]+\.(?:[cm]?js|ts)):(\d+):\d+/g)]
      .slice(0, 2)
      .map((m) => m[1] + ':' + m[2])
    messages.push([bounded ? e.message : (missing?.[1] ?? code?.[0] ?? 'host error'), ...sites].join(' '))
  }
  return messages.join(' / ')
}
