// The offer book. All money state lives here; agents read it through tools and can never change a rule.
import { randomBytes } from 'node:crypto'
import {
  ROUNDS_MAX,
  classifyOffer,
  computeFairValue,
  pickWinner,
  priceSetup,
  round2,
  suggestedCounter,
  type Comp,
  type Condition,
  type ExcludedComp,
  type FairValue,
  type Offer,
  type OfferIntent,
  type PriceSetup,
} from './book.ts'
import { checkReply, template } from './check.ts'
import { config } from './config.ts'

export type ListingStatus = 'draft' | 'live' | 'closing' | 'sold' | 'unsold'

export interface Item {
  brand?: string
  category: string
  model?: string
  color: string
  size?: string
  condition: Condition
  material?: string
  notes?: string
  photo_matches_description: boolean
}

export interface Copy {
  title: string
  description: string
  bullets: string[]
  image_url?: string
}

export interface Listing {
  id: string
  status: ListingStatus
  published: boolean
  approved: boolean
  photo_url: string
  seller_description: string
  seller_floor?: number | undefined
  item?: Item
  retail_anchor?: { title?: string | undefined; url?: string | undefined; price: number } | undefined
  comps_kept: Comp[]
  comps_excluded: ExcludedComp[]
  fair_value?: FairValue
  thin_data: boolean
  ask?: number
  floor?: number
  target?: number
  offer_band?: { min: number; max: number }
  bid_increment?: number
  opens_at?: number
  closes_at?: number
  closed_at?: number
  sold_at?: number
  image_urls: string[]
  copy?: Copy
  created_at: number
}

export interface Buyer {
  id: string
  buyer_token: string
  handle: string
  session_id?: string | undefined
  first_offer?: number | undefined
  best_offer?: number | undefined
  rounds_used: number
  last_offer_at?: number | undefined
  last_submit_at?: number | undefined
  last_counter?: number | undefined
  check_fails: number
  status: 'active' | 'winner' | 'runner_up' | 'defaulted'
  reply?: { line: string; ts: number; label?: string | undefined; kind: 'agent' | 'template' } | undefined
  notice?: string | undefined
}

export interface Counter {
  buyer_id: string
  amount?: number | undefined
  round: number
  ts: number
  line: string
  label: 'countered' | 'held' | 'leading'
}

export interface ScreenEvent {
  ts: number
  type: 'join' | 'offer' | 'counter' | 'outlier' | 'rejected' | 'system'
  buyer_handle?: string
  amount?: number
  label?: string
  agent_line?: string
  text?: string
}

export interface Sale {
  buyer_id: string
  amount: number
  ts: number
}

export interface PendingApproval {
  id: string
  kind: 'listing' | 'sale'
  tool: string
  preview: Record<string, unknown>
  ts: number
}

export interface ListerEvent {
  ts: number
  text: string
}

export interface Stats {
  outlier_offers_low: number
  outlier_offers_high: number
  rejected_schema: number
  rejected_rate: number
  /** Events posted into agent sessions: a 400 or 429 must never move this. */
  events_posted: number
}

export interface AuditRow {
  ts: number
  who: string
  line: string
  allowed: number[]
  ok: boolean
}

export interface State {
  listing?: Listing | undefined
  buyers: Buyer[]
  offers: Offer[]
  counters: Counter[]
  screen: ScreenEvent[]
  lister: ListerEvent[]
  approvals: PendingApproval[]
  audit: AuditRow[]
  stats: Stats
  proposal?: { buyer_id: string; amount: number; reason: string; ts: number } | undefined
  notices?: { winner: string; others: string } | undefined
  closer_summary?: string | undefined
  winner_buyer_id?: string | undefined
  sold_amount?: number | undefined
  sale?: Sale | undefined
  handle_seq: number
  cursors: Record<string, string>
  lister_session_id?: string | undefined
  closer_session_id?: string | undefined
}

const emptyStats = (): Stats => ({
  outlier_offers_low: 0,
  outlier_offers_high: 0,
  rejected_schema: 0,
  rejected_rate: 0,
  events_posted: 0,
})

export const emptyState = (): State => ({
  buyers: [],
  offers: [],
  counters: [],
  screen: [],
  lister: [],
  approvals: [],
  audit: [],
  stats: emptyStats(),
  handle_seq: 0,
  cursors: {},
})

const id = (prefix: string): string => `${prefix}_${randomBytes(5).toString('hex')}`

export interface GetStateResult {
  listing: { title: string; condition: string; fair_value: FairValue; ask: number; offer_band: { min: number; max: number } }
  buyer: {
    handle: string
    last_offer: number | null
    last_offer_status: string | null
    last_intent: string | null
    best_valid_offer: number | null
    rounds_used: number
    rounds_max: number
  }
  board: { best_valid_offer: number | null; leader_is_you: boolean; buyers: number }
  seconds_left: number
  suggested_counter: number
}

export type SubmitResult =
  | { kind: 'no_listing' | 'closed' | 'not_open' }
  | { kind: 'rate_limited' }
  | { kind: 'excluded'; offer: Offer; reply: string }
  | { kind: 'accepted'; offer: Offer }

export class Engine {
  state: State = emptyState()

  /** Called whenever state changes; the snapshotter uses it to mark dirty. */
  onChange: () => void = () => {}

  reset(): void {
    this.state = emptyState()
    this.onChange()
  }

  load(raw: State): void {
    this.state = { ...emptyState(), ...raw, stats: { ...emptyStats(), ...raw.stats } }
  }

  get listing(): Listing | undefined {
    return this.state.listing
  }

  private touch(): void {
    this.onChange()
  }

  screen(ev: Omit<ScreenEvent, 'ts'>, now: number): void {
    this.state.screen.push({ ts: now, ...ev })
    if (this.state.screen.length > 500) this.state.screen.splice(0, this.state.screen.length - 500)
    this.touch()
  }

  listerLog(text: string, now: number): void {
    this.state.lister.push({ ts: now, text: text.slice(0, 240) })
    if (this.state.lister.length > 200) this.state.lister.splice(0, this.state.lister.length - 200)
    this.touch()
  }

  // ---------- listing lifecycle ----------

  createDraft(input: { description: string; photoUrl: string; sellerFloor?: number | undefined }, now: number): Listing {
    this.reset()
    const listing: Listing = {
      id: id('l'),
      status: 'draft',
      published: false,
      approved: false,
      photo_url: input.photoUrl,
      seller_description: input.description,
      seller_floor: input.sellerFloor,
      comps_kept: [],
      comps_excluded: [],
      thin_data: false,
      image_urls: [input.photoUrl],
      created_at: now,
    }
    this.state.listing = listing
    this.touch()
    return listing
  }

  /** Validate and price a Lister submission. Returns the tool result, or an error string. */
  publishListing(
    input: {
      item: Item
      retail_anchor?: { title?: string; url?: string; price: number } | undefined
      comps: Comp[]
      copy: Copy
    },
    now: number,
  ): { ok: true; result: Record<string, unknown> } | { ok: false; error: string } {
    const listing = this.listing
    if (!listing) return { ok: false, error: 'No listing is waiting for a Lister.' }
    if (listing.status !== 'draft') return { ok: false, error: 'The listing is already live or finished.' }
    const fv = computeFairValue({
      comps: input.comps,
      retailAnchorPrice: input.retail_anchor?.price,
      condition: input.item.condition,
    })
    if ('error' in fv) return { ok: false, error: fv.error }
    const setup: PriceSetup = priceSetup(fv.fair, listing.seller_floor)
    Object.assign(listing, {
      item: input.item,
      retail_anchor: input.retail_anchor,
      comps_kept: fv.kept,
      comps_excluded: fv.excluded,
      fair_value: fv.fair,
      thin_data: fv.thin,
      ask: setup.ask,
      floor: setup.floor,
      target: setup.target,
      offer_band: setup.offer_band,
      bid_increment: setup.bid_increment,
      copy: input.copy,
      published: true,
    } satisfies Partial<Listing>)
    if (input.copy.image_url) listing.image_urls = [input.copy.image_url, listing.photo_url]
    this.listerLog(
      `Priced from ${fv.kept.length} comparables, ${fv.excluded.length} excluded${fv.thin ? ' (thin data)' : ''}.`,
      now,
    )
    this.touch()
    return {
      ok: true,
      result: {
        listing_id: listing.id,
        fair_value: fv.fair,
        kept: fv.kept.length,
        excluded: fv.excluded.length,
        ask: setup.ask,
        thin_data: fv.thin,
      },
    }
  }

  /** Preview what publish_listing would compute, without changing anything (for the approval card). */
  previewListing(input: { item?: Item; retail_anchor?: { price: number }; comps?: Comp[] }): Record<string, unknown> {
    const comps = Array.isArray(input.comps) ? input.comps : []
    const fv = computeFairValue({
      comps,
      retailAnchorPrice: input.retail_anchor?.price,
      condition: input.item?.condition ?? 'good',
    })
    if ('error' in fv) return { error: fv.error }
    const floor = this.listing?.seller_floor
    return { ...fv, ...priceSetup(fv.fair, floor), seller_floor_set: floor !== undefined }
  }

  open(now: number): string | undefined {
    const l = this.listing
    if (!l || !l.published) return 'Nothing to open: the Lister has not published a listing yet.'
    if (!l.approved) return 'Approve the listing first.'
    if (l.status !== 'draft') return 'The auction is already open or finished.'
    l.status = 'live'
    l.opens_at = now
    l.closes_at = now + config.auctionSeconds * 1000
    this.screen({ type: 'system', text: 'Auction open' }, now)
    this.touch()
    return undefined
  }

  secondsLeft(now: number): number {
    const l = this.listing
    if (!l || l.status !== 'live' || !l.closes_at) return 0
    return Math.max(0, Math.ceil((l.closes_at - now) / 1000))
  }

  /** Move live -> closing. Returns false if there was nothing to close. */
  beginClose(now: number): boolean {
    const l = this.listing
    if (!l || l.status !== 'live') return false
    l.status = 'closing'
    l.closed_at = now
    this.screen({ type: 'system', text: 'Auction closed' }, now)
    this.touch()
    return true
  }

  // ---------- buyers ----------

  buyerByToken(token: string | undefined): Buyer | undefined {
    if (!token) return undefined
    return this.state.buyers.find((b) => b.buyer_token === token)
  }

  buyerById(idv: string | undefined): Buyer | undefined {
    return this.state.buyers.find((b) => b.id === idv)
  }

  buyerBySession(sessionId: string): Buyer | undefined {
    return this.state.buyers.find((b) => b.session_id === sessionId)
  }

  join(now: number): Buyer | { error: 'full' | 'closed' } {
    const l = this.listing
    if (!l || !l.published || !l.approved) return { error: 'closed' }
    if (l.status !== 'draft' && l.status !== 'live') return { error: 'closed' }
    if (this.state.buyers.length >= config.maxBuyers) return { error: 'full' }
    this.state.handle_seq += 1
    const buyer: Buyer = {
      id: id('b'),
      buyer_token: randomBytes(24).toString('hex'),
      handle: `Buyer ${this.state.handle_seq}`,
      rounds_used: 0,
      check_fails: 0,
      status: 'active',
    }
    this.state.buyers.push(buyer)
    this.screen({ type: 'join', buyer_handle: buyer.handle }, now)
    return buyer
  }

  buyerOffers(buyerId: string): Offer[] {
    return this.state.offers.filter((o) => o.buyer_id === buyerId)
  }

  /** Every buyer's current live valid offer. */
  liveValidOffers(): Offer[] {
    return this.state.offers.filter((o) => o.status === 'valid')
  }

  bestValid(): Offer | undefined {
    return pickWinner(this.liveValidOffers())
  }

  // ---------- offers ----------

  noteRejected(kind: 'schema' | 'rate', now: number): void {
    if (kind === 'schema') this.state.stats.rejected_schema += 1
    else this.state.stats.rejected_rate += 1
    this.screen({ type: 'rejected', text: kind === 'schema' ? 'Rejected by schema' : 'Rejected by rate limit' }, now)
  }

  /** Offer rules in order: rate limit, outliers, monotonic, floor, valid. The schema check ran in the web layer. */
  submitOffer(buyer: Buyer, amount: number, intent: OfferIntent, now: number): SubmitResult {
    const l = this.listing
    if (!l || !l.published) return { kind: 'no_listing' }
    if (l.status === 'draft') return { kind: 'not_open' }
    if (l.status !== 'live' || !l.closes_at || now >= l.closes_at) return { kind: 'closed' }
    if (buyer.last_submit_at !== undefined && now - buyer.last_submit_at < config.rateLimitMs) {
      this.noteRejected('rate', now)
      return { kind: 'rate_limited' }
    }
    buyer.last_submit_at = now
    const band = l.offer_band as { min: number; max: number }
    const previous = this.buyerOffers(buyer.id)
      .filter((o) => o.status === 'valid')
      .at(-1)
    const verdict = classifyOffer({ offer_band: band, floor: l.floor as number }, amount, previous?.amount)
    const offer: Offer = {
      id: id('o'),
      buyer_id: buyer.id,
      amount,
      intent,
      ts: now,
      status: verdict.status,
      flags: verdict.flags,
    }
    if (verdict.status === 'excluded_low' || verdict.status === 'excluded_high') {
      // Excluded offers stay out of the book, the chart and the price stats.
      if (verdict.status === 'excluded_low') this.state.stats.outlier_offers_low += 1
      else this.state.stats.outlier_offers_high += 1
      const reply = template('outlier', { min: band.min, max: band.max, mid: (l.fair_value as FairValue).mid })
      buyer.reply = { line: reply, ts: now, kind: 'template' }
      this.screen({ type: 'outlier', buyer_handle: buyer.handle, text: 'Outlier excluded' }, now)
      return { kind: 'excluded', offer, reply }
    }
    if (verdict.status === 'valid' && previous) previous.status = 'superseded'
    this.state.offers.push(offer)
    buyer.last_offer_at = now
    if (buyer.first_offer === undefined) buyer.first_offer = amount
    if (verdict.status === 'valid' || verdict.status === 'below_floor') {
      buyer.best_offer = Math.max(buyer.best_offer ?? 0, amount)
    }
    this.screen({ type: 'offer', buyer_handle: buyer.handle, amount, label: verdict.status }, now)
    return { kind: 'accepted', offer }
  }

  // ---------- tools the agents call ----------

  getState(buyer: Buyer, now: number): GetStateResult | { error: string } {
    const l = this.listing
    if (!l || !l.published) return { error: 'No live listing.' }
    const mine = this.buyerOffers(buyer.id)
    const last = mine.at(-1)
    const best = this.bestValid()
    const myValid = mine.filter((o) => o.status === 'valid').at(-1)
    return {
      listing: {
        title: l.copy?.title ?? '',
        condition: l.item?.condition ?? '',
        fair_value: l.fair_value as FairValue,
        ask: l.ask as number,
        offer_band: l.offer_band as { min: number; max: number },
      },
      buyer: {
        handle: buyer.handle,
        last_offer: last?.amount ?? null,
        last_offer_status: last?.status ?? null,
        last_intent: last?.intent ?? null,
        best_valid_offer: myValid?.amount ?? null,
        rounds_used: buyer.rounds_used,
        rounds_max: ROUNDS_MAX,
      },
      board: {
        best_valid_offer: best?.amount ?? null,
        leader_is_you: best?.buyer_id === buyer.id,
        buyers: this.state.buyers.length,
      },
      seconds_left: this.secondsLeft(now),
      suggested_counter: this.counterFor(buyer),
    }
  }

  counterFor(buyer: Buyer): number {
    const l = this.listing as Listing
    return suggestedCounter({
      roundsUsed: buyer.rounds_used,
      ask: l.ask as number,
      floor: l.floor as number,
      bidIncrement: l.bid_increment as number,
      bestValid: this.bestValid()?.amount,
      lastCounter: buyer.last_counter,
    })
  }

  /** Every dollar figure a reply to this buyer may contain. */
  allowedFigures(buyer: Buyer, extra: number[] = []): number[] {
    const l = this.listing
    if (!l || !l.fair_value) return extra
    const mine = this.buyerOffers(buyer.id).map((o) => o.amount)
    const figs = [
      this.counterFor(buyer),
      this.bestValid()?.amount,
      buyer.last_counter,
      l.fair_value.low,
      l.fair_value.mid,
      l.fair_value.high,
      l.ask,
      ...mine,
      ...extra,
    ]
    return figs.filter((n): n is number => typeof n === 'number')
  }

  audit(who: string, line: string, allowed: number[], ok: boolean, now: number): void {
    this.state.audit.push({ ts: now, who, line, allowed, ok })
    if (this.state.audit.length > 2000) this.state.audit.splice(0, this.state.audit.length - 2000)
  }

  /**
   * record_counter. The first failed reply check returns the reason once; if the retry fails too,
   * the template fallback is sent instead (ok with replaced: true).
   */
  recordCounter(
    buyer: Buyer,
    input: { label: unknown; line: unknown; amount?: unknown },
    now: number,
  ): { ok: true; replaced?: boolean } | { ok: false; min_allowed?: number; reason: string } {
    const l = this.listing
    if (!l || !l.published) return { ok: false, reason: 'No live listing.' }
    const label = input.label
    if (label !== 'countered' && label !== 'held' && label !== 'leading') {
      return { ok: false, reason: 'label must be countered, held or leading.' }
    }
    const hasOffers = this.buyerOffers(buyer.id).length > 0
    const suggested = this.counterFor(buyer)
    const best = this.bestValid()
    let amount: number | undefined
    const extra: number[] = []

    if (hasOffers) {
      if (label === 'countered') {
        if (buyer.rounds_used >= ROUNDS_MAX) {
          return { ok: false, min_allowed: suggested, reason: `All ${ROUNDS_MAX} counters are used: the price holds. Use label held and restate ${suggested}.` }
        }
        if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) {
          return { ok: false, min_allowed: suggested, reason: 'countered needs an amount.' }
        }
        if (input.amount < suggested) {
          return { ok: false, min_allowed: suggested, reason: `The counter is below the minimum; use ${suggested} or higher.` }
        }
        amount = round2(input.amount)
        extra.push(amount)
      } else if (label === 'held') {
        if (buyer.rounds_used < ROUNDS_MAX) {
          return { ok: false, reason: `held is only for when all ${ROUNDS_MAX} rounds are used; you have used ${buyer.rounds_used}. Counter at ${suggested} or higher.` }
        }
        amount = buyer.last_counter
      } else if (best?.buyer_id !== buyer.id) {
        return { ok: false, reason: 'This buyer does not have the best valid offer, so the label cannot be leading.' }
      }
    } else if (typeof input.amount === 'number') {
      extra.push(input.amount) // join greeting: figures still have to come from the relay
    }

    const allowed = this.allowedFigures(buyer, extra)
    const verdict = checkReply(input.line, allowed)
    this.audit(buyer.handle, String(input.line ?? ''), allowed, verdict.ok, now)
    let line = String(input.line ?? '')
    let replaced = false
    if (!verdict.ok) {
      buyer.check_fails += 1
      if (buyer.check_fails < 2) return { ok: false, reason: verdict.reason ?? 'The reply check failed.' }
      line = this.fallbackLine(buyer, now)
      replaced = true
    }
    buyer.check_fails = 0

    if (hasOffers) {
      if (label === 'countered' && amount !== undefined) {
        this.state.counters.push({ buyer_id: buyer.id, amount, round: buyer.rounds_used, ts: now, line, label })
        buyer.rounds_used += 1
        buyer.last_counter = amount
      } else {
        this.state.counters.push({ buyer_id: buyer.id, amount, round: buyer.rounds_used, ts: now, line, label })
      }
      this.screen(
        { type: 'counter', buyer_handle: buyer.handle, ...(amount !== undefined ? { amount } : {}), label, agent_line: line },
        now,
      )
    }
    buyer.reply = { line, ts: now, label, kind: replaced ? 'template' : 'agent' }
    this.touch()
    return replaced ? { ok: true, replaced } : { ok: true }
  }

  /** Template reply used on timeouts and double check failures. */
  fallbackLine(buyer: Buyer, now: number): string {
    const l = this.listing
    if (!l || !l.published) return template('closed')
    if (l.status !== 'live') return template('closed')
    const secs = this.secondsLeft(now)
    const best = this.bestValid()
    const last = this.buyerOffers(buyer.id).at(-1)
    if (best && best.buyer_id === buyer.id) return template('leading', { amount: best.amount, seconds_left: secs })
    void last
    return template('below_counter', { counter: this.counterFor(buyer), seconds_left: secs })
  }

  applyFallback(buyer: Buyer, now: number): string {
    const line = this.fallbackLine(buyer, now)
    buyer.reply = { line, ts: now, kind: 'template' }
    buyer.check_fails = 0
    this.audit(buyer.handle, line, this.allowedFigures(buyer), true, now)
    this.touch()
    return line
  }

  // ---------- Closer tools ----------

  /** Each buyer's best offer with status. Excluded offers are not in the book at all. */
  finalBook(): { offers: Array<{ buyer_id: string; handle: string; amount: number; status: string; ts: number }>; fair_value: FairValue; floor: number; ask: number } | { error: string } {
    const l = this.listing
    if (!l || !l.published) return { error: 'No listing.' }
    const offers: Array<{ buyer_id: string; handle: string; amount: number; status: string; ts: number }> = []
    for (const b of this.state.buyers) {
      const mine = this.buyerOffers(b.id).filter((o) => o.status === 'valid' || o.status === 'below_floor')
      if (mine.length === 0) continue
      const top = mine.reduce((a, c) => (c.amount > a.amount || (c.amount === a.amount && c.ts < a.ts) ? c : a))
      offers.push({ buyer_id: b.id, handle: b.handle, amount: top.amount, status: top.status, ts: top.ts })
    }
    offers.sort((a, b) => b.amount - a.amount || a.ts - b.ts)
    return { offers, fair_value: l.fair_value as FairValue, floor: l.floor as number, ask: l.ask as number }
  }

  proposeSale(input: { buyer_id: unknown; amount: unknown; reason: unknown }, now: number): { ok: boolean; reason?: string } {
    const top = pickWinner(this.liveValidOffers())
    if (!top) return { ok: false, reason: 'There is no valid offer to sell to.' }
    if (input.buyer_id !== top.buyer_id || input.amount !== top.amount) {
      const b = this.buyerById(top.buyer_id)
      return { ok: false, reason: `The top valid offer is ${top.amount} from ${b?.handle ?? top.buyer_id} (${top.buyer_id}). Propose that one.` }
    }
    this.state.proposal = { buyer_id: top.buyer_id, amount: top.amount, reason: String(input.reason ?? '').slice(0, 200), ts: now }
    this.touch()
    return { ok: true }
  }

  proposalBuyerId(): string | undefined {
    return this.state.proposal?.buyer_id
  }

  /** Check a Closer notify message against the figures the Closer is allowed to quote. */
  checkNotice(line: unknown, who: string, now: number): { ok: boolean; reason?: string } {
    const l = this.listing
    const figs: number[] = []
    if (l?.fair_value) figs.push(l.fair_value.low, l.fair_value.mid, l.fair_value.high)
    if (l?.ask) figs.push(l.ask)
    if (this.state.proposal) figs.push(this.state.proposal.amount)
    const r = checkReply(line, figs)
    this.audit(who, String(line ?? ''), figs, r.ok, now)
    return r.reason ? { ok: r.ok, reason: r.reason } : { ok: r.ok }
  }

  // ---------- results ----------

  computeStats(): Record<string, unknown> | undefined {
    const l = this.listing
    const s = this.state
    if (!l || !l.fair_value || s.sold_amount === undefined) return undefined
    const mid = l.fair_value.mid
    const floor = l.floor as number
    const sold = s.sold_amount
    const perBuyer = s.buyers.map((b) => {
      const mine = this.buyerOffers(b.id).filter((o) => o.status !== 'ignored')
      return { b, mine }
    })
    const offered = perBuyer.filter((p) => p.mine.length > 0)
    const multi = offered.filter((p) => p.mine.length >= 2)
    const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0)
    const lifts = multi.map((p) => {
      const first = (p.mine[0] as Offer).amount
      const best = Math.max(...p.mine.map((o) => o.amount))
      return (best - first) / first
    })
    const firsts = offered.map((p) => (p.mine[0] as Offer).amount)
    const bests = offered.map((p) => Math.max(...p.mine.map((o) => o.amount)))
    const allOffers = s.offers.length
    const validish = s.offers.filter((o) => o.status === 'valid' || o.status === 'superseded' || o.status === 'accepted').length
    const compsExcluded = l.comps_excluded.length
    return {
      final_price: sold,
      vs_fair_mid_pct: round2(((sold - mid) / mid) * 100),
      vs_floor_pct: round2(((sold - floor) / floor) * 100),
      floor,
      agent_lift_pct: round2(avg(lifts) * 100),
      lowball_first_avg: round2(avg(firsts)),
      lowball_best_avg: round2(avg(bests)),
      buyers_joined: s.buyers.length,
      buyers_offered: offered.length,
      total_offers: allOffers,
      valid_share_pct: allOffers ? round2((validish / allOffers) * 100) : 0,
      avg_rounds: round2(avg(s.buyers.map((b) => b.rounds_used))),
      defenses: {
        outlier_offers: s.stats.outlier_offers_low + s.stats.outlier_offers_high,
        outlier_comps: compsExcluded,
        rejected: s.stats.rejected_schema + s.stats.rejected_rate,
      },
      time_to_sale_s: l.opens_at && l.sold_at ? Math.round((l.sold_at - l.opens_at) / 100) / 10 : null,
      fee_pct: config.feePct,
      seller_net: round2(sold * (1 - config.feePct)),
      summary: s.closer_summary ?? `Floor was $${floor}. Sold at $${sold}.`,
    }
  }
}
