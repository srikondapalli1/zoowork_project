// Orchestration: ties the offer book to the agents, the clock and the presenter's approvals.
// Agents propose; only this class (through the engine) makes anything count.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { pickWinner, type Comp } from './book.ts'
import { checkReply, template } from './check.ts'
import { parseMessage, sanitizeText } from './market/parse.ts'
import { BrowserFeed, appendMessage, joinMarketBuyer, threadById } from './market/store.ts'
import { config } from './config.ts'
import { Engine, type Channel, type Buyer, type Copy, type Item, type Listing, type PendingApproval, type State } from './engine.ts'
import { TurnManager, type NegotiatorEvent } from './turns.ts'

export type CloserEvent = { event: 'close' }

/** What the relay needs from whatever runs the three agents (ZooWork live, or local stubs for tests). */
export interface AgentIO {
  startLister(listing: Listing, photo: Buffer, description: string): Promise<void>
  startNegotiator(buyer: Buyer): Promise<void>
  postNegotiator(buyer: Buyer, ev: NegotiatorEvent, seq: number): Promise<void>
  interruptNegotiator(buyer: Buyer): Promise<void>
  startCloser(listing: Listing): Promise<void>
  postCloser(ev: CloserEvent): Promise<void>
  resolveApproval(approvalId: string, decision: 'allow-once' | 'deny'): Promise<void>
  stop(): Promise<void>
}

type Decision = 'allow-once' | 'deny'

const SALE_WINNER_TEMPLATE = 'You won! The presenter will find you.'
const SALE_OTHERS_TEMPLATE = 'It sold at the final price. Thanks for playing.'

export class Relay {
  readonly engine = new Engine()
  io!: AgentIO
  readonly turns: TurnManager
  closerRunning = false
  /** Latest frame and action log pushed by the agent's sandbox browser (marketplace channel). */
  readonly feed = new BrowserFeed()
  private closeTimer: NodeJS.Timeout | undefined
  private snapTimer: NodeJS.Timeout | undefined
  private dirty = false
  private approvalHandlers = new Map<string, (d: Decision) => Promise<void> | void>()
  private notifyFails = 0

  private now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
    this.turns = new TurnManager(this.engine, () => this.io, now)
    this.engine.onChange = () => {
      this.dirty = true
    }
    // A template line the relay itself sends (outlier, timeout, unsent approved line) lands in the buyer's DM thread.
    this.engine.onTemplateReply = (buyer, line, at) => {
      if (buyer.channel === 'market') appendMessage(this.engine, buyer.id, 'seller', line, 'auto', at)
    }
  }

  // ---------- persistence ----------

  private get statePath(): string {
    return join(config.dataDir, 'state.json')
  }

  async restore(): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as State
      this.engine.load(raw)
      this.engine.state.approvals = [] // approval handlers do not survive a restart
      this.rearmTimers()
      return true
    } catch {
      return false
    }
  }

  startSnapshots(): void {
    this.snapTimer = setInterval(() => void this.snapshot(), 1000)
    this.snapTimer.unref()
  }

  async snapshot(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    try {
      await mkdir(config.dataDir, { recursive: true })
      const tmp = `${this.statePath}.tmp`
      await writeFile(tmp, JSON.stringify(this.engine.state))
      await rename(tmp, this.statePath)
    } catch (e) {
      this.dirty = true
      console.error('[snapshot] failed:', (e as Error).message)
    }
  }

  private rearmTimers(): void {
    const l = this.engine.listing
    if (l?.status === 'live' && l.closes_at) this.armCloseTimer(l.closes_at)
  }

  async stop(): Promise<void> {
    if (this.snapTimer) clearInterval(this.snapTimer)
    this.dirty = true
    await this.snapshot()
    this.clearTimers()
    await this.io.stop()
  }

  private clearTimers(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = undefined
  }

  // ---------- admin actions ----------

  async reset(): Promise<void> {
    this.clearTimers()
    this.turns.reset()
    this.approvalHandlers.clear()
    this.grants.clear()
    this.closerRunning = false
    this.notifyFails = 0
    await this.io.stop()
    this.feed.clear()
    this.engine.reset()
  }

  async createListing(rawPhoto: Buffer, description: string, floor: number | undefined): Promise<Listing> {
    // Phone photos are several MB and the sandbox upload runs at ~100 KB/s: shrink before it ever leaves the relay.
    const photo = await sharp(rawPhoto)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer()
    await this.reset()
    await mkdir(join(config.dataDir, 'photos'), { recursive: true })
    const draft = this.engine.createDraft({ description, photoUrl: '/photo/pending.jpg', sellerFloor: floor }, this.now())
    draft.photo_url = `/photo/${draft.id}.jpg`
    draft.image_urls = [draft.photo_url]
    await writeFile(join(config.dataDir, 'photos', `${draft.id}.jpg`), photo)
    this.engine.listerLog(`Photo stored (${Math.round(photo.length / 1024)} KB). Lister starting.`, this.now())
    this.io.startLister(draft, photo, description).catch((e: unknown) => {
      this.engine.listerLog(`Lister failed to start: ${(e as Error).message}. Use Load rehearsal listing.`, this.now())
    })
    return draft
  }

  /** Rehearsal listing: a saved, already-priced listing so the demo survives a stalled Lister. */
  async loadRehearsal(): Promise<Listing> {
    const fixture = JSON.parse(await readFile(join(config.rehearsalDir, 'listing.json'), 'utf8')) as {
      description: string
      item: Item
      retail_anchor: { title: string; url: string; price: number }
      comps: Comp[]
      copy: Copy
    }
    await this.reset()
    const now = this.now()
    const draft = this.engine.createDraft({ description: fixture.description, photoUrl: '/photo/rehearsal.svg' }, now)
    const res = this.engine.publishListing(fixture, now)
    if (!res.ok) throw new Error(res.error)
    draft.approved = true
    this.engine.listerLog('Rehearsal listing loaded from disk.', now)
    return draft
  }

  /** Approve/deny the pending approval of one kind (the console's Approve listing / Approve sale buttons). */
  async decide(kind: 'listing' | 'sale', decision: Decision): Promise<boolean> {
    const pending = this.engine.state.approvals.find((a) => a.kind === kind)
    if (!pending) return false
    const handler = this.approvalHandlers.get(pending.id)
    this.dropApproval(pending.id)
    if (!handler) return false
    if (decision === 'allow-once') this.grants.add(kind)
    await handler(decision)
    return true
  }

  /** Grants from the console that a platform-paused tool call is waiting to consume. */
  private grants = new Set<'listing' | 'sale'>()

  /**
   * Called by the money tools just before they act. Normally the platform gate already paused the call
   * and the presenter's approval left a grant; if the gate did not fire, wait for the presenter here.
   */
  async requireApproval(kind: 'listing' | 'sale', tool: string, args: Record<string, unknown>): Promise<boolean> {
    if (this.grants.delete(kind)) return true
    const d = await this.localApproval(kind, tool, args)
    this.grants.delete(kind)
    return d === 'allow-once'
  }

  /** Live path: the platform paused a tool call for approval. */
  onPlatformApproval(p: { approvalId: string; toolName: string; args: Record<string, unknown> }): void {
    const kind = p.toolName.endsWith('publish_listing') ? 'listing' : p.toolName.endsWith('confirm_sale') ? 'sale' : undefined
    if (!kind) {
      // Any other tool that asks for approval is outside this demo's policy.
      void this.io.resolveApproval(p.approvalId, 'deny').catch(() => {})
      return
    }
    this.addApproval(kind, p.toolName, p.args, p.approvalId, (d) => this.io.resolveApproval(p.approvalId, d))
  }

  /** Stub path: a local tool call waits for the presenter. */
  localApproval(kind: 'listing' | 'sale', tool: string, args: Record<string, unknown>): Promise<Decision> {
    return new Promise((resolve) => {
      this.addApproval(kind, tool, args, `local_${randomBytes(4).toString('hex')}`, resolve)
    })
  }

  private addApproval(
    kind: 'listing' | 'sale',
    tool: string,
    args: Record<string, unknown>,
    id: string,
    handler: (d: Decision) => Promise<void> | void,
  ): void {
    const preview = kind === 'listing' ? this.previewListing(args) : this.previewSale(args)
    const approval: PendingApproval = { id, kind, tool, preview, ts: this.now() }
    // A newer request of the same kind replaces an older, unanswered one.
    for (const old of this.engine.state.approvals.filter((a) => a.kind === kind)) this.dropApproval(old.id)
    this.engine.state.approvals.push(approval)
    this.approvalHandlers.set(id, handler)
    this.engine.listerLog(kind === 'listing' ? 'Waiting for your approval to publish.' : 'Waiting for your approval of the sale.', this.now())
    this.engine.onChange()
  }

  dropApproval(id: string): void {
    this.engine.state.approvals = this.engine.state.approvals.filter((a) => a.id !== id)
    this.approvalHandlers.delete(id)
    this.engine.onChange()
  }

  private previewListing(args: Record<string, unknown>): Record<string, unknown> {
    const input = args as { item?: Item; retail_anchor?: { price: number }; comps?: Comp[]; copy?: Copy }
    return { ...this.engine.previewListing(input), copy: input.copy ?? null, item: input.item ?? null }
  }

  private previewSale(args: Record<string, unknown>): Record<string, unknown> {
    const buyer = this.engine.buyerById(String(args.buyer_id))
    const top = pickWinner(this.engine.liveValidOffers())
    return {
      buyer_id: args.buyer_id,
      handle: buyer?.handle ?? null,
      amount: args.amount,
      is_top_valid_offer: top?.buyer_id === args.buyer_id && top?.amount === args.amount,
      reason: this.engine.state.proposal?.reason ?? null,
      fair_value: this.engine.listing?.fair_value ?? null,
      floor: this.engine.listing?.floor ?? null,
    }
  }

  // ---------- clock ----------

  open(): string | undefined {
    const err = this.engine.open(this.now())
    if (err) return err
    this.armCloseTimer((this.engine.listing as Listing).closes_at as number)
    return undefined
  }

  private armCloseTimer(closesAt: number): void {
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = setTimeout(() => void this.close(), Math.max(0, closesAt - this.now()))
  }

  async close(): Promise<string | undefined> {
    if (this.closeTimer) clearTimeout(this.closeTimer)
    const now = this.now()
    if (!this.engine.beginClose(now)) return 'The auction is not live.'
    this.turns.dropQueued()
    const l = this.engine.listing as Listing
    if (!pickWinner(this.engine.liveValidOffers())) {
      this.engine.state.closer_summary = 'No valid offers. The listing ends unsold.'
      this.finishUnsold()
      return undefined
    }
    this.closerRunning = true
    try {
      await this.io.startCloser(l)
    } catch (e) {
      this.closerRunning = false
      this.engine.screen({ type: 'system', text: `Closer failed to start: ${(e as Error).message}` }, now)
    }
    return undefined
  }

  private finishUnsold(): void {
    const l = this.engine.listing
    if (!l) return
    l.status = 'unsold'
    this.engine.screen({ type: 'system', text: 'Listing ended unsold' }, this.now())
    this.engine.onChange()
  }

  // ---------- buyers ----------

  async joinBuyer(token: string | undefined): Promise<{ buyer: Buyer; created: boolean } | { error: 'full' | 'closed' }> {
    const existing = this.engine.buyerByToken(token)
    if (existing) return { buyer: existing, created: false }
    if (this.engine.state.channel !== 'qr') return { error: 'closed' } // the room QR is off while the marketplace channel is on
    const res = this.engine.join(this.now())
    if ('error' in res) return res
    this.io.startNegotiator(res).catch((e: unknown) => {
      console.error(`[join] Negotiator session failed for ${res.handle}:`, (e as Error).message)
    })
    return { buyer: res, created: true }
  }

  submit(buyer: Buyer, amount: number, intent: 'offer' | 'final_offer') {
    const r = this.engine.submitOffer(buyer, amount, intent, this.now())
    if (r.kind === 'accepted') this.turns.enqueue(buyer.id, { event: 'offer', amount, intent })
    return r
  }

  // ---------- Closer / sale ----------

  /**
   * confirm_sale, after the presenter approved. There is no payment step: the sale is final and the
   * winner is displayed on the big screen and on the winner's phone.
   */
  completeSale(buyerId: string, amount: number): { sold: true; winner: string; amount: number } {
    const s = this.engine.state
    const l = this.engine.listing
    const buyer = this.engine.buyerById(buyerId)
    if (!l || !buyer) throw new Error('Unknown buyer or listing.')
    const now = this.now()
    l.status = 'sold'
    l.sold_at = now
    s.sale = { buyer_id: buyerId, amount, ts: now }
    s.sold_amount = amount
    s.winner_buyer_id = buyerId
    buyer.status = 'winner'
    for (const b of s.buyers) if (b.id !== buyerId) b.status = 'runner_up'
    const win = s.offers.find((o) => o.buyer_id === buyerId && o.status === 'valid')
    if (win) win.status = 'accepted'
    this.engine.screen({ type: 'system', text: `Sold to ${buyer.handle}` }, now)
    this.engine.onChange()
    return { sold: true, winner: buyer.handle, amount }
  }

  /** The Closer's run ended. If the listing is still closing with no sale in motion, the console offers a failsafe. */
  onCloserFinished(summaryText: string | undefined): void {
    this.closerRunning = false
    const l = this.engine.listing
    if (summaryText && l && l.fair_value) {
      const figs = [l.fair_value.low, l.fair_value.mid, l.fair_value.high, l.ask ?? 0, l.floor ?? 0]
      if (this.engine.state.sale) figs.push(this.engine.state.sale.amount)
      const verdict = checkReply(summaryText, figs)
      this.engine.audit('closer-summary', summaryText, figs, verdict.ok, this.now())
      if (verdict.ok) this.engine.state.closer_summary = summaryText
    }
    this.engine.onChange()
  }

  get closerStalled(): boolean {
    const l = this.engine.listing
    return l?.status === 'closing' && !this.closerRunning && !this.engine.state.approvals.some((a) => a.kind === 'sale')
  }

  /** Failsafe: the presenter sells to the top valid offer without the Closer. Still the presenter's own action. */
  forceSale(): string | undefined {
    const top = pickWinner(this.engine.liveValidOffers())
    const l = this.engine.listing
    if (!top || !l || l.status !== 'closing') return 'There is nothing to sell.'
    this.completeSale(top.buyer_id, top.amount)
    this.applyNotices(SALE_WINNER_TEMPLATE, SALE_OTHERS_TEMPLATE)
    return undefined
  }

  applyNotices(winner: string, others: string): void {
    const s = this.engine.state
    s.notices = { winner, others }
    const winId = s.sale?.buyer_id ?? this.engine.proposalBuyerId()
    for (const b of s.buyers) b.notice = b.id === winId ? winner : others
    this.engine.onChange()
  }

  /** notify tool: reply check on both messages; one retry, then templates. */
  notify(winner: unknown, others: unknown): { ok: boolean; reason?: string } {
    const now = this.now()
    const a = this.engine.checkNotice(winner, 'notify-winner', now)
    const b = this.engine.checkNotice(others, 'notify-others', now)
    if (a.ok && b.ok) {
      this.notifyFails = 0
      this.applyNotices(String(winner), String(others))
      return { ok: true }
    }
    this.notifyFails += 1
    if (this.notifyFails < 2) return { ok: false, reason: (!a.ok ? a.reason : b.reason) ?? 'The reply check failed.' }
    this.notifyFails = 0
    this.applyNotices(SALE_WINNER_TEMPLATE, SALE_OTHERS_TEMPLATE)
    return { ok: true }
  }


  // ---------- channels ----------

  /** Switch between the QR room flow and the marketplace flow. Only before the auction opens. */
  setChannel(mode: Channel): string | undefined {
    if (mode !== 'qr' && mode !== 'marketplace') return 'Unknown channel.'
    const l = this.engine.listing
    if (l && l.status !== 'draft') return 'The channel can only be changed before the auction opens.'
    if (this.engine.state.buyers.length > 0) return 'Buyers have already joined: reset first.'
    this.engine.state.channel = mode
    this.engine.onChange()
    return undefined
  }

  /** A marketplace buyer registers; they get a DM thread and (live) a Responder session. */
  joinMarket(name: unknown): { buyer: Buyer } | { error: 'full' | 'closed' | 'wrong_channel' } {
    const res = joinMarketBuyer(this.engine, name, this.now())
    if ('error' in res) return res
    this.io.startNegotiator(res).catch((e: unknown) => {
      console.error(`[market] Responder session failed for ${res.handle}:`, (e as Error).message)
    })
    return { buyer: res }
  }

  /**
   * A DM from a marketplace buyer. The relay itself finds any price in the text and applies the offer rules;
   * the agent is only woken, with no text in the event, and reads the thread in its browser.
   */
  marketMessage(buyer: Buyer, rawText: unknown): { status: number; body: Record<string, unknown> } {
    const text = sanitizeText(rawText)
    if (!text) return { status: 400, body: { error: 'Send {"text": "..."} with 1 to 280 characters.' } }
    const l = this.engine.listing
    const now = this.now()
    if (!l || !l.published) return { status: 409, body: { error: 'No listing.' } }
    if (buyer.last_msg_at !== undefined && now - buyer.last_msg_at < config.rateLimitMs) {
      this.engine.noteRejected('rate', now)
      return { status: 429, body: { error: 'One message every few seconds.' } }
    }
    buyer.last_msg_at = now
    appendMessage(this.engine, buyer.id, 'buyer', text, undefined, now)
    const auto = (line: string): void => void appendMessage(this.engine, buyer.id, 'seller', line, 'auto', now)
    const over = l.status === 'closing' || l.status === 'sold' || l.status === 'unsold' || (l.status === 'live' && !!l.closes_at && now >= l.closes_at)
    if (over) {
      auto(template('closed'))
      return { status: 200, body: { ok: true, auto_reply: true } }
    }
    const parsed = parseMessage(text)
    const thread = buyer.thread_id as string
    if (parsed.amount !== undefined) {
      if (l.status === 'draft') {
        auto('Offers open when the sale starts. Send it again then.')
        return { status: 200, body: { ok: true, auto_reply: true } }
      }
      const r = this.engine.submitOffer(buyer, parsed.amount, parsed.intent, now)
      if (r.kind === 'excluded') return { status: 200, body: { ok: true, auto_reply: true } } // template already in the thread
      if (r.kind !== 'accepted') return { status: 200, body: { ok: true } }
      this.turns.enqueue(buyer.id, { event: 'message', thread, has_offer: true })
      return { status: 200, body: { ok: true } }
    }
    this.turns.enqueue(buyer.id, { event: 'message', thread, has_offer: false })
    return { status: 200, body: { ok: true } }
  }

  /**
   * The seller inbox Send button. Only the line record_counter approved for this buyer may go out, so the agent
   * drives a real UI but cannot put a figure, a floor or a promise of its own into a thread.
   */
  marketSellerSend(threadId: string, rawText: unknown): { status: number; body: Record<string, unknown> } {
    const thread = threadById(this.engine, threadId)
    const buyer = thread ? this.engine.buyerById(thread.buyer_id) : undefined
    if (!thread || !buyer) return { status: 404, body: { error: 'No such thread.' } }
    const text = sanitizeText(rawText)
    if (!buyer.pending_send) {
      return { status: 409, body: { error: 'No approved reply is waiting for this thread. Call get_state, then record_counter, then send exactly the line it approves.' } }
    }
    if (text !== buyer.pending_send) {
      return { status: 409, body: { error: `Not the approved reply. Send exactly this text: ${buyer.pending_send}` } }
    }
    buyer.pending_send = undefined
    appendMessage(this.engine, buyer.id, 'seller', text, 'agent', this.now())
    return { status: 200, body: { ok: true } }
  }

  /** Reply latency per buyer message across the marketplace, for the dashboard and the recording footer. */
  marketStats(): { threads: number; buyer_messages: number; agent_replies: number; auto_replies: number; median_ms: number | null; p90_ms: number | null } {
    const waits: number[] = []
    let agent = 0
    let auto = 0
    for (const t of this.engine.state.threads) {
      let pendingSince: number | undefined
      for (const m of t.messages) {
        if (m.from === 'buyer') pendingSince ??= m.ts
        else {
          if (m.kind === 'agent') agent += 1
          else auto += 1
          if (pendingSince !== undefined) waits.push(m.ts - pendingSince)
          pendingSince = undefined
        }
      }
    }
    waits.sort((a, b) => a - b)
    const pick = (q: number): number | null => (waits.length ? (waits[Math.min(waits.length - 1, Math.floor(waits.length * q))] as number) : null)
    return {
      threads: this.engine.state.threads.length,
      buyer_messages: this.engine.state.threads.reduce((n, t) => n + t.messages.filter((m) => m.from === 'buyer').length, 0),
      agent_replies: agent,
      auto_replies: auto,
      median_ms: pick(0.5),
      p90_ms: pick(0.9),
    }
  }

  closedReply(): string {
    return template('closed')
  }
}
