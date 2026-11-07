// Reply check: the only gate between agent text and a buyer's phone or the big screen.
// A line passes only if it is short, plain, clean and every dollar figure is one the relay supplied.

export const MAX_REPLY_CHARS = 220

// Deliberately small; extend before a real venue.
const PROFANITY = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'piss', 'cunt', 'slut', 'whore', 'damn', 'crap',
]

export interface CheckResult {
  ok: boolean
  reason?: string
}

// Numbers followed by one of these are not dollar figures ("41s left", "3 seconds", "10%").
const UNIT_AFTER = /^\s?(?:s\b|sec\b|secs\b|seconds?\b|min\b|mins\b|minutes?\b|%|x\b|st\b|nd\b|rd\b|th\b|rounds?\b|buyers?\b|offers?\b|times?\b|wears?\b|inch(?:es)?\b|cm\b|years?\b|yrs?\b|months?\b|days?\b|hours?\b|hrs?\b|pockets?\b|zips?\b|pieces?\b|miles?\b|pm\b)/i
// ...and neither are numbers named as a count or position ("round 2", "2 of 4", "Buyer 14", "size 10").
const LABEL_BEFORE = /(?:\bround|\brounds|\bof|\bbuyer|\boffer|\bnumber|\bsize|\bsz|#)\s*$/i
const NUMBER =/(?:\$\s?)?\d[\d,]*(?:\.\d+)?/g

/** Dollar figures in a line: anything with $ or a bare number that is not a time/count unit. */
export function dollarFigures(line: string): number[] {
  const out: number[] = []
  for (const m of line.matchAll(NUMBER)) {
    const raw = m[0]
    const after = line.slice((m.index ?? 0) + raw.length)
    const before = line.slice(0, m.index ?? 0)
    const hasDollar = raw.trimStart().startsWith('$')
    if (!hasDollar && (UNIT_AFTER.test(after) || LABEL_BEFORE.test(before))) continue
    const n = Number(raw.replace(/[$,\s]/g, ''))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

export function checkReply(line: unknown, allowedFigures: readonly number[]): CheckResult {
  if (typeof line !== 'string' || line.trim() === '') return { ok: false, reason: 'The line is empty.' }
  if (line.length > MAX_REPLY_CHARS) {
    return { ok: false, reason: `The line is ${line.length} characters; the limit is ${MAX_REPLY_CHARS}.` }
  }
  if (/https?:|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|ai|app|ly|me|xyz)\b/i.test(line)) {
    return { ok: false, reason: 'Links are not allowed.' }
  }
  if (/[<>`*_#~\[\]\\|]/.test(line) || /&[a-z]+;/i.test(line)) {
    return { ok: false, reason: 'No HTML or markdown: remove the symbols < > ` * _ # ~ [ ] \\ |.' }
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(line)) return { ok: false, reason: 'Control characters are not allowed.' }
  const lower = line.toLowerCase()
  for (const w of PROFANITY) {
    if (new RegExp(`\\b${w}`, 'i').test(lower)) return { ok: false, reason: 'Keep it clean: no profanity.' }
  }
  for (const n of dollarFigures(line)) {
    if (!allowedFigures.some((a) => Math.abs(a - n) < 0.005)) {
      return {
        ok: false,
        reason: `The figure ${n} is not one the relay supplied. Use only your counter, the best offer, the buyer's own offer, the fair-value band or the ask from get_state.`,
      }
    }
  }
  return { ok: true }
}

export function template(kind: 'outlier', v: { min: number; max: number; mid: number }): string
export function template(kind: 'below_counter', v: { counter: number; seconds_left: number }): string
export function template(kind: 'leading', v: { amount: number; seconds_left: number }): string
export function template(kind: 'closed'): string
export function template(kind: 'ack'): string
export function template(kind: string, v?: Record<string, number>): string {
  const f = (n: number | undefined): string => String(Math.round((n ?? 0) * 100) / 100)
  switch (kind) {
    case 'outlier':
      return `Offers here run ${f(v?.min)} to ${f(v?.max)}; comparables put it around ${f(v?.mid)}.`
    case 'below_counter':
      return `Can't go that low. ${f(v?.counter)} takes it, ${Math.max(0, Math.round(v?.seconds_left ?? 0))}s left.`
    case 'leading':
      return `You're leading at ${f(v?.amount)}. Hold tight, ${Math.max(0, Math.round(v?.seconds_left ?? 0))}s left.`
    case 'ack':
      return 'Thanks for the message. Checking and getting right back to you.'
    default:
      return "Auction's closed. Results in a moment."
  }
}
