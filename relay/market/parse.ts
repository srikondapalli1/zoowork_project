// Deterministic price extraction from a marketplace DM. No model is involved: the relay decides whether a
// message contains an offer, so injected text can never smuggle a number past the offer rules.
import type { OfferIntent } from '../book.ts'

export const MAX_MESSAGE_CHARS = 280
const MAX_AMOUNT = 1_000_000

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`
const DOLLAR = new RegExp(String.raw`\$\s?${NUM}`, 'g')
const WORD_SUFFIX = new RegExp(String.raw`${NUM}\s?(?:dollars|bucks|usd)\b`, 'gi')
// "can you do 65", "I'll take 70", "offer 60", "give you 55": a bare number after an offering verb,
// unless it is clearly a time, a duration or a measurement.
const VERB_NUMBER = new RegExp(
  String.raw`\b(?:do|take|for|at|offer|offering|pay|paying|give(?:\s+you)?|go(?:ing)?\s+(?:up\s+)?to|meet\s+(?:at|me\s+at))\s+${NUM}(?!\s?(?:%|pm|am|inch|inches|in\b|cm|years?|yrs?|months?|days?|hours?|hrs?|miles?|times|wears?|min))`,
  'gi',
)
const ONLY_NUMBER = new RegExp(String.raw`^\s*${NUM}\s*[?.!]*\s*$`)

const toNumber = (whole: string, cents: string | undefined): number => {
  const n = Number(`${whole.replace(/,/g, '')}${cents ? '.' + cents : ''}`)
  return Math.min(n, MAX_AMOUNT)
}

function lastMatch(re: RegExp, text: string): number | undefined {
  let found: number | undefined
  for (const m of text.matchAll(re)) found = toNumber(m[1] as string, m[2])
  return found
}

/** The amount the buyer is offering, or undefined if the message has no price. The last price wins ("saw it for $120, can do $70"). */
export function extractAmount(text: string): number | undefined {
  const t = text.slice(0, MAX_MESSAGE_CHARS)
  const found = lastMatch(DOLLAR, t) ?? lastMatch(WORD_SUFFIX, t) ?? lastMatch(VERB_NUMBER, t)
  if (found !== undefined) return found > 0 ? found : undefined
  const only = ONLY_NUMBER.exec(t)
  if (only) {
    const n = toNumber(only[1] as string, only[2])
    return n > 0 ? n : undefined
  }
  return undefined
}

const FINAL = /\b(?:final|last|best)\s+(?:offer|price)\b|\bfinal\b|\blowest\s+i(?:'ll|\s+will|\s+can)\b|\btake\s+it\s+or\s+leave\s+it\b/i

export function parseMessage(text: string): { amount?: number; intent: OfferIntent } {
  const amount = extractAmount(text)
  const intent: OfferIntent = amount !== undefined && FINAL.test(text) ? 'final_offer' : 'offer'
  return amount === undefined ? { intent } : { amount, intent }
}

/** Display names come from outside: keep a short, plain, printable name. */
export function sanitizeName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  const clean = s.replace(/[^A-Za-z0-9 .'\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24)
  return clean || 'Buyer'
}

/** Message text: printable only, trimmed, capped. Returns undefined for an empty message. */
export function sanitizeText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS)
  return clean === '' ? undefined : clean
}
