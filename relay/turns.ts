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
  /** When the buyer submitted the event that is queued / running: the 8-second promise counts from here. */
  queuedAt: number
  currentAt: number
  seq: number
  recorded: boolean
  stale: boolean
  holdsSlot: boolean
  startedAt: number
  deadline?: NodeJS.Timeout | undefined
  guard?: NodeJS.Timeout | undefined
  /** Timer for an offer that is still waiting its turn: the buyer is owed a reply within the deadline too. */
  queueTimer?: NodeJS.Timeout | undefined
}

export interface TurnMetric {
  buyer_id: string
  ms: number
  outcome: 'recorded' | 'timeout' | 'no_reply' | 'queue_timeout' | 'superseded'
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
      s = { inFlight: false, queuedAt: 0, currentAt: 0, seq: 0, recorded: false, stale: false, holdsSlot: false, startedAt: 0 }
      this.st.set(buyerId, s)
    }
    return s
  }

  /** Queue an event for a buyer. A queued event is replaced by a newer one: the latest offer counts. */
  enqueue(buyerId: string, ev: NegotiatorEvent): void {
    const s = this.state(buyerId)
    const wasQueued = s.queued !== undefined
    s.queued = ev
    s.queuedAt = this.now()
    if (s.queueTimer) clearTimeout(s.queueTimer)
    s.queueTimer = setTimeout(() => this.onQueueDeadline(buyerId), config.turnDeadlineMs)
    // A running turn that has not answered is about an older offer: the latest offer counts, so stop it
    // rather than make this buyer wait for an answer nobody needs.
    if (s.inFlight && !s.recorded && !s.stale) this.supersede(buyerId, s)
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
    if (s.queueTimer) clearTimeout(s.queueTimer)
    s.queueTimer = undefined
    if (!buyer || !ev) return
    s.inFlight = true
    s.current = ev
    s.seq += 1
    s.recorded = false
    s.stale = false
    s.holdsSlot = true
    s.startedAt = this.now()
    s.currentAt = s.queuedAt
    buyer.check_fails = 0
    this.running += 1
    this.engine.state.stats.events_posted += 1
    const remaining = Math.max(0, s.currentAt + config.turnDeadlineMs - this.now())
    s.deadline = setTimeout(() => this.onDeadline(buyerId), remaining)
    this.io()
      .postNegotiator(buyer, ev, s.seq)
      .catch((err: unknown) => {
        console.error(`[turn] post failed for ${buyer.handle}:`, (err as Error).message)
        this.onDeadline(buyerId)
      })
  }

  private supersede(buyerId: string, s: TurnState): void {
    s.stale = true
    if (s.deadline) clearTimeout(s.deadline)
    s.deadline = undefined
    this.metrics.push({ buyer_id: buyerId, ms: this.now() - s.startedAt, outcome: 'superseded' })
    const buyer = this.engine.buyerById(buyerId)
    if (buyer) this.io().interruptNegotiator(buyer).catch(() => {})
    // If the interrupt never produces run.finished, free the buyer anyway.
    if (s.guard) clearTimeout(s.guard)
    s.guard = setTimeout(() => this.finish(buyerId), 4000)
  }

  /** An offer waited too long behind a running turn or the global cap: send the template now; the agent's reply still replaces it later. */
  private onQueueDeadline(buyerId: string): void {
    const s = this.state(buyerId)
    s.queueTimer = undefined
    if (!s.queued || s.queued.event !== 'offer') return
    const buyer = this.engine.buyerById(buyerId)
    if (!buyer) return
    this.metrics.push({ buyer_id: buyerId, ms: config.turnDeadlineMs, outcome: 'queue_timeout' })
    this.engine.applyFallback(buyer, this.now())
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
    for (const s of this.st.values()) {
      s.queued = undefined
      if (s.queueTimer) clearTimeout(s.queueTimer)
      s.queueTimer = undefined
    }
    this.waiting = []
  }

  reset(): void {
    for (const s of this.st.values()) {
      if (s.deadline) clearTimeout(s.deadline)
      if (s.guard) clearTimeout(s.guard)
      if (s.queueTimer) clearTimeout(s.queueTimer)
    }
    this.st.clear()
    this.waiting = []
    this.running = 0
    this.metrics.length = 0
  }
}
