// Swapspot marketplace data: DM threads between fake buyers and the seller. Lives in the engine state,
// so the relay's one-second snapshot covers it and a crash restarts mid-auction with every thread intact.
import { randomBytes } from 'node:crypto'
import { config } from '../config.ts'
import type { Buyer, Engine, MarketMessage, MarketThread } from '../engine.ts'
import { sanitizeName } from './parse.ts'

const id = (prefix: string): string => `${prefix}_${randomBytes(5).toString('hex')}`

/** A buyer arrives from the marketplace: a Buyer record plus an empty DM thread. */
export function joinMarketBuyer(engine: Engine, displayName: unknown, now: number): Buyer | { error: 'full' | 'closed' | 'wrong_channel' } {
  const l = engine.listing
  if (engine.state.channel !== 'marketplace') return { error: 'wrong_channel' }
  if (!l || !l.published || !l.approved) return { error: 'closed' }
  if (l.status !== 'draft' && l.status !== 'live') return { error: 'closed' }
  if (engine.state.buyers.length >= config.maxBuyers) return { error: 'full' }

  let handle = sanitizeName(displayName)
  const taken = new Set(engine.state.buyers.map((b) => b.handle))
  for (let n = 2; taken.has(handle); n += 1) handle = `${sanitizeName(displayName).slice(0, 20)} ${n}`
  engine.state.handle_seq += 1
  const buyer: Buyer = {
    id: id('b'),
    buyer_token: randomBytes(24).toString('hex'),
    handle,
    rounds_used: 0,
    check_fails: 0,
    status: 'active',
    channel: 'market',
  }
  const thread: MarketThread = { id: id('t'), buyer_id: buyer.id, name: handle, messages: [], unread: 0, last_ts: now }
  buyer.thread_id = thread.id
  engine.state.buyers.push(buyer)
  engine.state.threads.push(thread)
  engine.screen({ type: 'join', buyer_handle: buyer.handle }, now)
  return buyer
}

export const threadById = (engine: Engine, threadId: string): MarketThread | undefined =>
  engine.state.threads.find((t) => t.id === threadId)

export function appendMessage(engine: Engine, buyerId: string, from: 'buyer' | 'seller', text: string, kind: 'agent' | 'auto' | undefined, now: number): MarketMessage | undefined {
  const buyer = engine.buyerById(buyerId)
  const thread = buyer?.thread_id ? threadById(engine, buyer.thread_id) : undefined
  if (!thread) return undefined
  const msg: MarketMessage = { id: id('m'), ts: now, from, text, ...(kind ? { kind } : {}) }
  thread.messages.push(msg)
  if (thread.messages.length > 200) thread.messages.splice(0, thread.messages.length - 200)
  thread.last_ts = now
  thread.unread = from === 'buyer' ? thread.unread + 1 : 0
  engine.onChange()
  return msg
}

/** The seller inbox list: unanswered threads first, newest first. */
export function inboxView(engine: Engine): Array<{ id: string; name: string; unread: number; last_text: string; last_from: string; last_ts: number }> {
  return [...engine.state.threads]
    .sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.last_ts - a.last_ts)
    .map((t) => {
      const last = t.messages.at(-1)
      return { id: t.id, name: t.name, unread: t.unread, last_text: last?.text.slice(0, 80) ?? '', last_from: last?.from ?? '', last_ts: t.last_ts }
    })
}

export function threadView(t: MarketThread): { id: string; name: string; unread: number; messages: Array<{ from: string; text: string; kind: string | null; ts: number }> } {
  return { id: t.id, name: t.name, unread: t.unread, messages: t.messages.map((m) => ({ from: m.from, text: m.text, kind: m.kind ?? null, ts: m.ts })) }
}

/** Latest browser frame and action log from the agent's sandbox Chromium (not persisted). */
export class BrowserFeed {
  frame: Buffer | undefined
  frameAt = 0
  actions: Array<{ ts: number; text: string }> = []

  push(frame: Buffer | undefined, action: string | undefined, now: number): void {
    if (frame) {
      this.frame = frame
      this.frameAt = now
    }
    if (action) {
      this.actions.push({ ts: now, text: action.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) })
      if (this.actions.length > 60) this.actions.splice(0, this.actions.length - 60)
    }
  }

  clear(): void {
    this.frame = undefined
    this.frameAt = 0
    this.actions = []
  }
}
