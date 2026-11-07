// Concurrency rules for Negotiator turns:
//  - one turn in flight per buyer; a submit during a running turn replaces the queued event
//  - a global cap on turns in flight, the rest wait in a FIFO queue
//  - an 8-second deadline per turn; on a miss the relay posts the template fallback and drops the late reply
import { config } from './config.ts'
import type { Buyer, Engine } from './engine.ts'

export type NegotiatorEvent =
  | { event: 'join' }
  | { event: 'offer'; amount: number; intent: 'offer' | 'final_offer' }

export interface TurnIO {
  postNegotiator(buyer: Buyer, ev: NegotiatorEvent, seq: number): Promise<void>
  interruptNegotiator(buyer: Buyer): Promise<void>
}

interface TurnState {
  inFlight: boolean
  queued?: NegotiatorEvent | undefined
  current?: NegotiatorEvent | undefined
  seq: number
  recorded: boolean
  stale: boolean
  holdsSlot: boolean
  startedAt: number
  deadline?: NodeJS.Timeout | undefined
  guard?: NodeJS.Timeout | undefined
}

export interface TurnMetric {
  buyer_id: string
  ms: number
  outcome: 'recorded' | 'timeout' | 'no_reply'
}

export class TurnManager {
  private st = new Map<string, TurnState>()
  private waiting: string[] = []
  private running = 0
  readonly metrics: TurnMetric[] = []

  private engine: Engine
  private io: () => TurnIO
  private now: () => number

  constructor(engine: Engine, io: () => TurnIO, now: () => number = Date.now) {
    this.engine = engine
    this.io = io
    this.now = now
  }

  get inFlight(): number {
    return this.running
  }

  get queueDepth(): number {
    return this.waiting.length
  }

  private state(buyerId: string): TurnState {
    let s = this.st.get(buyerId)
    if (!s) {
      s = { inFlight: false, seq: 0, recorded: false, stale: false, holdsSlot: false, startedAt: 0 }
      this.st.set(buyerId, s)
    }
    return s
  }

  /** Queue an event for a buyer. A queued event is replaced by a newer one: the latest offer counts. */
  enqueue(buyerId: string, ev: NegotiatorEvent): void {
    const s = this.state(buyerId)
    const wasQueued = s.queued !== undefined
    s.queued = ev
    if (!s.inFlight && !wasQueued) this.waiting.push(buyerId)
    this.pump()
  }

  private pump(): void {
    while (this.running < config.globalTurnCap && this.waiting.length > 0) {
      const id = this.waiting.shift() as string
      const s = this.state(id)
      if (s.inFlight || !s.queued) continue
      this.start(id, s)
    }
  }

  private start(buyerId: string, s: TurnState): void {
    const buyer = this.engine.buyerById(buyerId)
    const ev = s.queued
    s.queued = undefined
    if (!buyer || !ev) return
    s.inFlight = true
    s.current = ev
    s.seq += 1
    s.recorded = false
    s.stale = false
    s.holdsSlot = true
    s.startedAt = this.now()
    buyer.check_fails = 0
    this.running += 1
    this.engine.state.stats.events_posted += 1
    s.deadline = setTimeout(() => this.onDeadline(buyerId), config.turnDeadlineMs)
    this.io()
      .postNegotiator(buyer, ev, s.seq)
      .catch((err: unknown) => {
        console.error(`[turn] post failed for ${buyer.handle}:`, (err as Error).message)
        this.onDeadline(buyerId)
      })
  }

  private releaseSlot(s: TurnState): void {
    if (s.holdsSlot) {
      s.holdsSlot = false
      this.running = Math.max(0, this.running - 1)
    }
  }

  private onDeadline(buyerId: string): void {
    const s = this.state(buyerId)
    if (!s.inFlight || s.recorded || s.stale) return
    s.stale = true
    this.metrics.push({ buyer_id: buyerId, ms: this.now() - s.startedAt, outcome: 'timeout' })
    const buyer = this.engine.buyerById(buyerId)
    if (buyer && s.current?.event === 'offer') this.engine.applyFallback(buyer, this.now())
    if (buyer) this.io().interruptNegotiator(buyer).catch(() => {})
    this.releaseSlot(s)
    // If the interrupt never produces run.finished, free the buyer anyway.
    s.guard = setTimeout(() => this.finish(buyerId), 10_000)
    this.pump()
  }

  /** record_counter calls this: is the reply for the turn that is still current? */
  onRecorded(buyerId: string): boolean {
    const s = this.state(buyerId)
    if (!s.inFlight || s.stale) return false
    s.recorded = true
    this.metrics.push({ buyer_id: buyerId, ms: this.now() - s.startedAt, outcome: 'recorded' })
    return true
  }

  isCurrent(buyerId: string): boolean {
    const s = this.state(buyerId)
    return s.inFlight && !s.stale
  }

  /** The turn's run finished (or its guard fired): free the buyer and start any queued event. */
  finish(buyerId: string): void {
    const s = this.state(buyerId)
    if (!s.inFlight) return
    if (s.deadline) clearTimeout(s.deadline)
    if (s.guard) clearTimeout(s.guard)
    const buyer = this.engine.buyerById(buyerId)
    if (!s.recorded && !s.stale && buyer && s.current?.event === 'offer') {
      // The agent finished without recording a reply: send the template rather than leave the buyer hanging.
      this.metrics.push({ buyer_id: buyerId, ms: this.now() - s.startedAt, outcome: 'no_reply' })
      this.engine.applyFallback(buyer, this.now())
    }
    this.releaseSlot(s)
    s.inFlight = false
    s.current = undefined
    if (s.queued) this.waiting.push(buyerId)
    this.pump()
  }

  /** Auction closed: drop everything that has not started. */
  dropQueued(): void {
    for (const s of this.st.values()) s.queued = undefined
    this.waiting = []
  }

  reset(): void {
    for (const s of this.st.values()) {
      if (s.deadline) clearTimeout(s.deadline)
      if (s.guard) clearTimeout(s.guard)
    }
    this.st.clear()
    this.waiting = []
    this.running = 0
    this.metrics.length = 0
  }
}
