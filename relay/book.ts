// Pure money rules for Snap & Sell. No I/O, no clocks: everything here is unit-testable.
// The relay owns every number that moves money; agents only read these through tools.

export type Condition = 'new_with_tags' | 'excellent' | 'good' | 'fair'

export interface Comp {
  title: string
  url: string
  price: number
  kind: 'resale' | 'new'
  match: 'exact' | 'similar' | 'loose'
}

export interface ExcludedComp {
  comp: Comp
  reason: string
}

export interface FairValue {
  low: number
  mid: number
  high: number
}

export interface FairValueResult {
  fair: FairValue
  kept: Comp[]
  excluded: ExcludedComp[]
  thin: boolean
}

export interface PriceSetup {
  ask: number
  floor: number
  target: number
  offer_band: { min: number; max: number }
  bid_increment: number
}

/** Starting guesses from the spec; tune after the load test. */
export const CONDITION_FACTOR: Record<Condition, number> = {
  new_with_tags: 0.65,
  excellent: 0.5,
  good: 0.4,
  fair: 0.25,
}

/** Concession share of the ask-floor gap by counter round (0-based). */
export const CONCESSION_SHARE = [0.35, 0.6, 0.8, 0.9] as const
export const ROUNDS_MAX = CONCESSION_SHARE.length

export const round2 = (x: number): number => Math.round(x * 100) / 100
export const ceil5 = (x: number): number => Math.ceil(x / 5) * 5
export const round5 = (x: number): number => Math.round(x / 5) * 5

/** Linear-interpolation percentile over an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN
  const first = sorted[0] as number
  if (sorted.length === 1) return first
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  const a = sorted[lo] as number
  const b = sorted[hi] as number
  return a + (b - a) * (idx - lo)
}

export const median = (sorted: readonly number[]): number => percentile(sorted, 0.5)

const sortedPrices = (comps: readonly Comp[]): number[] => comps.map((c) => c.price).sort((a, b) => a - b)

/**
 * Fair value with outliers excluded. The Lister only gathers raw comparables;
 * this function is the only thing that turns them into a price, so a strange
 * listing or a poisoned web page cannot set the band.
 */
export function computeFairValue(input: {
  comps: readonly Comp[]
  retailAnchorPrice?: number | undefined
  condition: Condition
}): FairValueResult | { error: string } {
  const excluded: ExcludedComp[] = []
  let kept: Comp[] = []

  // 1. Keep resale comparables whose match is exact or similar.
  for (const comp of input.comps) {
    if (!Number.isFinite(comp.price) || comp.price <= 0) excluded.push({ comp, reason: 'invalid price' })
    else if (comp.kind !== 'resale') excluded.push({ comp, reason: 'not a resale price' })
    else if (comp.match === 'loose') excluded.push({ comp, reason: 'loose match' })
    else kept.push(comp)
  }

  // 2. Drop anything below 0.5 x median or above 2 x median.
  if (kept.length > 0) {
    const m = median(sortedPrices(kept))
    const next: Comp[] = []
    for (const comp of kept) {
      if (comp.price < 0.5 * m) excluded.push({ comp, reason: `below half the median ($${round2(m)})` })
      else if (comp.price > 2 * m) excluded.push({ comp, reason: `above twice the median ($${round2(m)})` })
      else next.push(comp)
    }
    kept = next
  }

  // 3. With 4+ left, also drop anything outside [Q1 - 1.5 IQR, Q3 + 1.5 IQR].
  if (kept.length >= 4) {
    const s = sortedPrices(kept)
    const q1 = percentile(s, 0.25)
    const q3 = percentile(s, 0.75)
    const iqr = q3 - q1
    const lo = q1 - 1.5 * iqr
    const hi = q3 + 1.5 * iqr
    const next: Comp[] = []
    for (const comp of kept) {
      if (comp.price < lo || comp.price > hi) excluded.push({ comp, reason: 'outside the interquartile fence' })
      else next.push(comp)
    }
    kept = next
  }

  // 4. fair_value = p25, median, p75 (with exactly 3: min, median, max).
  if (kept.length >= 3) {
    const s = sortedPrices(kept)
    const fair: FairValue =
      s.length === 3
        ? { low: s[0] as number, mid: s[1] as number, high: s[2] as number }
        : { low: percentile(s, 0.25), mid: median(s), high: percentile(s, 0.75) }
    return {
      fair: { low: round2(fair.low), mid: round2(fair.mid), high: round2(fair.high) },
      kept,
      excluded,
      thin: false,
    }
  }

  // 5. Fewer than 3 kept: retail anchor x condition factor, marked "thin data".
  const retail = input.retailAnchorPrice
  if (retail !== undefined && Number.isFinite(retail) && retail > 0) {
    const mid = retail * CONDITION_FACTOR[input.condition]
    // The spec fixes only the mid; a +/-20% spread is this implementation's choice.
    return {
      fair: { low: round2(mid * 0.8), mid: round2(mid), high: round2(mid * 1.2) },
      kept,
      excluded,
      thin: true,
    }
  }
  return {
    error: `Only ${kept.length} usable resale comparables and no retail anchor. Find at least 3 exact or similar resale prices, or a retail price.`,
  }
}

/** ask, floor, target, offer band and increment from a fair value. */
export function priceSetup(fair: FairValue, sellerFloor?: number): PriceSetup {
  let ask = ceil5(fair.high)
  const floor = sellerFloor !== undefined && sellerFloor > 0 ? round2(sellerFloor) : ceil5(fair.low)
  if (ask <= floor) ask = ceil5(floor + 5)
  return {
    ask,
    floor,
    target: round5(fair.mid * 1.1),
    offer_band: { min: round2(0.5 * fair.mid), max: round2(1.5 * fair.high) },
    bid_increment: Math.max(1, Math.round(0.03 * fair.mid)),
  }
}

export type OfferIntent = 'offer' | 'final_offer'
export type OfferStatus =
  | 'valid'
  | 'below_floor'
  | 'excluded_low'
  | 'excluded_high'
  | 'ignored'
  | 'accepted'
  | 'superseded'

export interface Offer {
  id: string
  buyer_id: string
  amount: number
  intent: OfferIntent
  ts: number
  status: OfferStatus
  flags: string[]
}

export interface OfferRuleContext {
  offer_band: { min: number; max: number }
  floor: number
}

/**
 * Offer rules 3 to 6, in order (schema and rate limit run in the web layer):
 * outliers, monotonic, floor, otherwise valid.
 */
export function classifyOffer(
  ctx: OfferRuleContext,
  amount: number,
  previousValid: number | undefined,
): { status: OfferStatus; flags: string[] } {
  if (amount < ctx.offer_band.min) return { status: 'excluded_low', flags: [] }
  if (amount > ctx.offer_band.max) return { status: 'excluded_high', flags: [] }
  if (previousValid !== undefined && amount < previousValid) return { status: 'ignored', flags: ['decreasing'] }
  if (amount < ctx.floor) return { status: 'below_floor', flags: [] }
  return { status: 'valid', flags: [] }
}

/**
 * Counter schedule: concession by round r closes a share of the ask-floor gap.
 * Never below floor + one increment, never below the current best valid offer + one increment.
 */
export function suggestedCounter(input: {
  roundsUsed: number
  ask: number
  floor: number
  bidIncrement: number
  bestValid: number | undefined
  lastCounter: number | undefined
}): number {
  if (input.roundsUsed >= ROUNDS_MAX && input.lastCounter !== undefined) return input.lastCounter // price holds
  const share = CONCESSION_SHARE[Math.min(input.roundsUsed, ROUNDS_MAX - 1)] as number
  let amount = input.ask - (input.ask - input.floor) * share
  amount = Math.max(amount, input.floor + input.bidIncrement)
  if (input.bestValid !== undefined) amount = Math.max(amount, input.bestValid + input.bidIncrement)
  return Math.ceil(amount - 1e-9)
}

/** Highest valid offer wins; ties go to the earliest. Returns undefined if none. */
export function pickWinner<T extends { amount: number; ts: number; status: OfferStatus }>(
  offers: readonly T[],
): T | undefined {
  let best: T | undefined
  for (const o of offers) {
    if (o.status !== 'valid') continue
    if (!best || o.amount > best.amount || (o.amount === best.amount && o.ts < best.ts)) best = o
  }
  return best
}

/** True when the body is exactly {amount, intent} with a 2-decimal number and a known intent. */
export function validateOfferBody(body: unknown): { ok: true; amount: number; intent: OfferIntent } | { ok: false } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false }
  const keys = Object.keys(body)
  if (keys.length !== 2 || !keys.includes('amount') || !keys.includes('intent')) return { ok: false }
  const { amount, intent } = body as Record<string, unknown>
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return { ok: false }
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return { ok: false } // at most 2 decimals
  if (intent !== 'offer' && intent !== 'final_offer') return { ok: false }
  return { ok: true, amount: round2(amount), intent }
}
