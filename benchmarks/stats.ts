export function passAt1(outcomes: readonly boolean[]) {
  return outcomes.length ? outcomes.filter(Boolean).length / outcomes.length : 0
}

export function passPowK(outcomes: readonly boolean[], k: number) {
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('k must be a positive integer')
  const n = outcomes.length,
    c = outcomes.filter(Boolean).length
  if (c < k) return 0
  let p = 1
  for (let i = 0; i < k; i++) p *= (c - i) / (n - i)
  return p
}

function quantile(sorted: readonly number[], p: number) {
  const x = (sorted.length - 1) * p,
    i = Math.floor(x)
  return sorted[i] + (sorted[Math.ceil(x)] - sorted[i]) * (x - i)
}

export function bootstrapCI(
  values: readonly number[],
  { iterations = 10000, alpha = 0.05, seed = 42 } = {},
) {
  if (!values.length || values.some((v) => !Number.isFinite(v)))
    throw new RangeError('finite observations required')
  if (!Number.isSafeInteger(iterations) || iterations < 1 || !(alpha > 0 && alpha < 1))
    throw new RangeError('invalid bootstrap options')
  function random() {
    let t = (seed = (seed + 0x6d2b79f5) | 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const median = quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  )
  if (values.every((v) => v === values[0])) return { mean, median, low: values[0], high: values[0] }
  const samples = Array.from({ length: iterations }, () => {
    let sum = 0
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)]
    return sum / values.length
  }).sort((a, b) => a - b)
  return { mean, median, low: quantile(samples, alpha / 2), high: quantile(samples, 1 - alpha / 2) }
}

export function mcnemarExact(pairs: readonly [boolean, boolean][]) {
  let b = 0,
    c = 0
  for (const [a, z] of pairs) {
    if (a && !z) b++
    if (!a && z) c++
  }
  const m = b + c
  let logMass = -m * Math.LN2,
    tail = Math.exp(logMass)
  for (let i = 1; i <= Math.min(b, c); i++) {
    logMass += Math.log((m - i + 1) / i)
    tail += Math.exp(logMass)
  }
  return { b, c, pValue: Math.min(1, 2 * tail) }
}

// Complementary error function for the two-sided normal approximation.
function erfc(x: number) {
  const t = 1 / (1 + 0.5 * x)
  const poly = [
    0.17087277, -0.82215223, 1.48851587, -1.13520398, 0.27886807, -0.18628806, 0.09678418, 0.37409196,
    1.00002368,
  ]
  return Math.min(1, t * Math.exp(-x * x - 1.26551223 + t * poly.reduce((a, v) => a * t + v, 0)))
}

export function wilcoxonSignedRank(pairs: readonly [number, number][]) {
  const d = pairs
    .map(([a, b]) => a - b)
    .filter((x) => x !== 0)
    .sort((a, b) => Math.abs(a) - Math.abs(b))
  const n = d.length,
    total = (n * (n + 1)) / 2
  let pos = 0,
    ties = 0
  for (let i = 0; i < n; ) {
    let j = i + 1
    while (j < n && Math.abs(d[i]) === Math.abs(d[j])) j++
    const t = j - i
    ties += t * t * t - t
    for (; i < j; i++) if (d[i] > 0) pos += j - (t - 1) / 2
  }
  const w = Math.min(pos, total - pos)
  if (!n) return { w, n, pValue: 1 }
  if (n <= 20 && ties === 0) {
    const counts = Array<number>(total + 1).fill(0)
    counts[0] = 1
    for (let r = 1; r <= n; r++) for (let s = total; s >= r; s--) counts[s] += counts[s - r]
    return { w, n, pValue: Math.min(1, (2 * counts.slice(0, w + 1).reduce((a, b) => a + b)) / 2 ** n) }
  }
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - ties / 48
  return { w, n, pValue: erfc(Math.max(0, total / 2 - w - 0.5) / Math.sqrt(2 * variance)) }
}

export function cliffsDelta(a: readonly number[], b: readonly number[]) {
  if (!a.length || !b.length) throw new RangeError('both samples required')
  let dominance = 0
  for (const x of a) for (const y of b) dominance += Math.sign(x - y)
  const delta = dominance / (a.length * b.length),
    size = Math.abs(delta)
  const magnitude =
    size < 0.147 ? 'negligible' : size < 0.33 ? 'small' : size < 0.474 ? 'medium' : 'large'
  return { delta, magnitude } as const
}

export function krippendorffAlpha(units: readonly (number | null)[][], level: 'nominal' | 'ordinal') {
  const counts = new Map<number, number>()
  const columns: number[][] = []
  for (let i = 0; i < Math.max(0, ...units.map((row) => row.length)); i++) {
    const values = units.map((row) => row[i]).filter((x): x is number => x != null)
    if (values.length < 2) continue
    columns.push(values)
    for (const x of values) counts.set(x, (counts.get(x) ?? 0) + 1)
  }
  let n = 0
  const ranks = new Map<number, number>()
  for (const x of [...counts.keys()].sort((a, b) => a - b)) {
    const count = counts.get(x)!
    ranks.set(x, n + count / 2)
    n += count
  }
  const distance = (a: number, b: number) =>
    level === 'nominal' ? Number(a !== b) : (ranks.get(a)! - ranks.get(b)!) ** 2
  let observed = 0,
    expected = 0
  for (const col of columns)
    for (const a of col) for (const b of col) observed += distance(a, b) / (col.length - 1)
  for (const [a, ca] of counts) for (const [b, cb] of counts) expected += ca * cb * distance(a, b)
  return expected ? 1 - (observed * (n - 1)) / expected : NaN // Agreement is undefined without expected disagreement.
}

export function communicationF1(precision: number, recall: number) {
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0
}
