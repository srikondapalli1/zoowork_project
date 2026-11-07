// Local stand-ins for the three agents, for tests and rehearsal. They call the same tool handlers as the
// ZooWork agents, so the relay rules are exercised exactly the same way, with no model and no cost.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from './config.ts'
import type { Buyer, GetStateResult, Listing } from './engine.ts'
import type { AgentIO } from './relay.ts'
import type { Relay } from './relay.ts'
import type { NegotiatorEvent } from './turns.ts'
import { handleTool } from './tools.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const f = (n: number): string => String(Math.round(n * 100) / 100)

export class StubIO implements AgentIO {
  private relay: Relay
  private timers = new Set<NodeJS.Timeout>()
  /** Test knob: STUB_LATENCY_MS delays each Negotiator turn (use it to exercise the 8-second fallback). */
  private latencyMs = Number(process.env.STUB_LATENCY_MS ?? 0)
  private stopped = false

  constructor(relay: Relay) {
    this.relay = relay
  }

  private later(ms: number, fn: () => void | Promise<void>): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (!this.stopped) void Promise.resolve(fn()).catch((e: unknown) => console.error('[stub]', (e as Error).message))
    }, ms)
    this.timers.add(t)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.stopped = false
  }

  async startLister(listing: Listing, _photo: Buffer, description: string): Promise<void> {
    const fixture = JSON.parse(await readFile(join(config.rehearsalDir, 'listing.json'), 'utf8'))
    const engine = this.relay.engine
    const steps = [
      'image: reading the photo',
      `web_search "${description.slice(0, 50)}"`,
      'zoodata_search retail price',
      'web_search resale comparables (eBay sold, Poshmark, Depop)',
      'web_fetch comparable listings',
      'publish_listing',
    ]
    steps.forEach((text, i) => this.later(400 * (i + 1), () => engine.listerLog(`[stub Lister] ${text}`, Date.now())))
    this.later(400 * (steps.length + 1), async () => {
      const copy = { ...fixture.copy, title: String(description).slice(0, 70) || fixture.copy.title }
      const res = await handleTool(this.relay, 'lister', {}, 'publish_listing', { ...fixture, copy })
      if (res.isError) engine.listerLog(`[stub Lister] publish failed: ${JSON.stringify(res.value)}`, Date.now())
    })
  }

  async startNegotiator(buyer: Buyer): Promise<void> {
    buyer.session_id = `stub_${buyer.id}`
    this.relay.turns.enqueue(buyer.id, { event: 'join' })
  }

  async postNegotiator(buyer: Buyer, ev: NegotiatorEvent): Promise<void> {
    this.later(this.latencyMs || 20 + Math.random() * 120, async () => {
      const relay = this.relay
      const got = await handleTool(relay, 'negotiator', { buyerId: buyer.id }, 'get_state', {})
      const s = got.value as GetStateResult
      if (got.isError || !s.listing) return relay.turns.finish(buyer.id)

      let label: 'countered' | 'held' | 'leading'
      let amount: number | undefined
      let line: string
      if (ev.event === 'join') {
        label = 'leading'
        line = `Welcome. Fair value runs ${f(s.listing.fair_value.low)} to ${f(s.listing.fair_value.high)}, asking ${f(s.listing.ask)}.`
      } else if (s.board.leader_is_you) {
        label = 'leading'
        line = `You're on top at ${f(s.board.best_valid_offer ?? 0)}. Hold tight, ${s.seconds_left}s left.`
      } else if (s.buyer.rounds_used >= s.buyer.rounds_max) {
        label = 'held'
        line = `My price holds at ${f(s.suggested_counter)}. ${s.seconds_left}s left.`
      } else {
        label = 'countered'
        amount = s.suggested_counter
        line = `Counter at ${f(amount)}. Comparables run ${f(s.listing.fair_value.low)} to ${f(s.listing.fair_value.high)}.`
      }
      const input = { label, line, ...(amount !== undefined ? { amount } : {}) }
      let res = await handleTool(relay, 'negotiator', { buyerId: buyer.id }, 'record_counter', input)
      const v = res.value as { ok: boolean; reason?: string }
      if (!v.ok && v.reason && !v.reason.startsWith('This turn expired')) {
        // Like the real agent, retry once with a plain line after the reason.
        res = await handleTool(relay, 'negotiator', { buyerId: buyer.id }, 'record_counter', { ...input, line: 'Fair point. Make me an offer.' })
      }
      relay.turns.finish(buyer.id)
    })
  }

  async interruptNegotiator(): Promise<void> {}

  async startCloser(): Promise<void> {
    this.later(300, async () => {
      const relay = this.relay
      const book = (await handleTool(relay, 'closer', {}, 'get_final_book', {})).value as {
        offers: Array<{ buyer_id: string; handle: string; amount: number; status: string }>
        floor: number
        fair_value: { mid: number }
      }
      const top = book.offers.find((o) => o.status === 'valid')
      if (!top) return relay.onCloserFinished(undefined)
      const reason = `Top valid offer, ${f(top.amount)} against a fair-value mid of ${f(book.fair_value.mid)}.`
      const proposed = await handleTool(relay, 'closer', {}, 'propose_sale', { buyer_id: top.buyer_id, amount: top.amount, reason })
      if (!(proposed.value as { ok?: boolean }).ok) return relay.onCloserFinished(undefined)
      const sale = await handleTool(relay, 'closer', {}, 'confirm_sale', { buyer_id: top.buyer_id, amount: top.amount })
      if (sale.isError) return relay.onCloserFinished(undefined)
      await handleTool(relay, 'closer', {}, 'notify', {
        winner: 'You won! The presenter will find you.',
        others: 'It sold at the final price. Thanks for playing.',
      })
      await sleep(0)
      relay.onCloserFinished(`Floor was $${f(book.floor)}. Sold at $${f(top.amount)}.`)
    })
  }

  async postCloser(): Promise<void> {}

  async resolveApproval(): Promise<void> {}
}
