// Web pages and API. Buyers can only ever send {amount, intent}; nothing a buyer types reaches a model or the screen.
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import QRCode from 'qrcode'
import { computeFairValue, priceSetup, validateOfferBody, type Comp, type Condition } from './book.ts'
import { template } from './check.ts'
import { config } from './config.ts'
import type { Buyer, Listing } from './engine.ts'
import { CSP, HttpError, MIME, parseCookies, readBody, safeEqual, send } from './http.ts'
import { handleMarket } from './market/web.ts'
import type { Relay } from './relay.ts'

export function createWebServer(relay: Relay): Server {
  const engine = relay.engine
  const now = (): number => Date.now()

  const isAdmin = (req: IncomingMessage, url: URL): boolean => {
    const given = String(req.headers['x-admin-token'] ?? url.searchParams.get('token') ?? '')
    return given !== '' && safeEqual(given, config.adminToken)
  }

  const publicListing = (l: Listing) => ({
    id: l.id,
    status: l.status,
    photo_url: l.photo_url,
    copy: l.copy ?? null,
    item: l.item ? { brand: l.item.brand, category: l.item.category, size: l.item.size, color: l.item.color, condition: l.item.condition } : null,
    fair_value: l.fair_value ?? null,
    ask: l.ask ?? null,
    offer_band: l.offer_band ?? null,
    bid_increment: l.bid_increment ?? null,
    thin_data: l.thin_data,
    comps_kept: l.comps_kept.length,
    comps_excluded: l.comps_excluded.length,
    seconds_left: engine.secondsLeft(now()),
    opens_at: l.opens_at ?? null,
    closes_at: l.closes_at ?? null,
    approved: l.approved,
    published: l.published,
    floor: l.status === 'sold' || l.status === 'unsold' ? (l.floor ?? null) : null, // hidden until the sale is over
  })

  const buyerView = (b: Buyer) => {
    const l = engine.listing as Listing
    const best = engine.bestValid()
    const mine = engine.buyerOffers(b.id)
    const sale = engine.state.sale
    return {
      handle: b.handle,
      status: b.status,
      listing: publicListing(l),
      board: { best_valid_offer: best?.amount ?? null, leader_is_you: best?.buyer_id === b.id, buyers: engine.state.buyers.length },
      your_offers: mine.map((o) => ({ amount: o.amount, intent: o.intent, status: o.status, ts: o.ts })),
      reply: b.reply ?? null,
      notice: b.notice ?? null,
      result:
        l.status === 'sold' && sale ? { winner: sale.buyer_id === b.id, handle: engine.buyerById(sale.buyer_id)?.handle ?? null, amount: sale.amount } : null,
      rate_limit_ms: config.rateLimitMs,
      server_time: now(),
    }
  }

  const screenState = () => {
    const l = engine.listing
    const s = engine.state
    if (!l) return { phase: 'idle', channel: s.channel, lister: [], server_time: now() }
    const dots = s.offers
      .filter((o) => o.status === 'valid' || o.status === 'below_floor' || o.status === 'superseded' || o.status === 'accepted')
      .map((o) => ({
        t: l.opens_at ? Math.round(((o.ts - l.opens_at) / 1000) * 10) / 10 : 0,
        amount: o.amount,
        handle: engine.buyerById(o.buyer_id)?.handle ?? '',
        status: o.status === 'below_floor' ? 'below_floor' : 'valid',
      }))
    const sale = s.sale
    return {
      phase: l.status,
      listing: publicListing(l),
      channel: s.channel,
      market: s.channel === 'marketplace' ? { ...relay.marketStats(), url: `${config.publicBaseUrl}/market` } : null,
      qr_url: s.channel === 'qr' && l.approved && l.status !== 'draft' ? `${config.publicBaseUrl}/l/${l.id}` : null,
      auction_seconds: config.auctionSeconds,
      offers: dots,
      ticker: s.screen
        .filter((e) => e.type === 'counter' && e.agent_line)
        .slice(-8)
        .reverse()
        .map((e) => ({ buyer: e.buyer_handle, amount: e.amount ?? null, label: e.label, line: e.agent_line })),
      counters: {
        buyers: s.buyers.length,
        offers: s.offers.length,
        outliers_excluded: s.stats.outlier_offers_low + s.stats.outlier_offers_high,
        rejected: s.stats.rejected_schema + s.stats.rejected_rate,
        comps_excluded: l.comps_excluded.length,
      },
      lister: s.lister.slice(-30),
      comps: { kept: l.comps_kept.map((c) => ({ title: c.title, price: c.price })), excluded: l.comps_excluded.map((e) => ({ title: e.comp.title, price: e.comp.price, reason: e.reason })) },
      winner: l.status === 'sold' && sale ? { handle: engine.buyerById(sale.buyer_id)?.handle ?? '', amount: sale.amount } : null,
      stats: l.status === 'sold' || l.status === 'unsold' ? (engine.computeStats() ?? { summary: s.closer_summary ?? 'Ended unsold.' }) : null,
      server_time: now(),
    }
  }

  const adminState = () => {
    const l = engine.listing
    const s = engine.state
    return {
      mode: config.mode,
      channel: s.channel,
      market_key_hint: s.channel === 'marketplace' ? `${config.publicBaseUrl}/market/inbox?key=${config.marketKey}` : null,
      market: relay.marketStats(),
      listing: l ?? null,
      approvals: s.approvals,
      closer_stalled: relay.closerStalled,
      closer_running: relay.closerRunning,
      proposal: s.proposal ?? null,
      seconds_left: engine.secondsLeft(now()),
      lister: s.lister.slice(-40),
      counts: { buyers: s.buyers.length, offers: s.offers.length, ...s.stats },
      turns: { in_flight: relay.turns.inFlight, queued: relay.turns.queueDepth, metrics: relay.turns.metrics.slice(-200) },
      offers: s.offers,
      buyers: s.buyers.map((b) => ({ id: b.id, handle: b.handle, status: b.status, rounds_used: b.rounds_used, session_id: b.session_id ?? null })),
      audit: s.audit.slice(-300),
      public_base_url: config.publicBaseUrl,
    }
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://relay.local')
    const path = url.pathname
    const method = req.method ?? 'GET'

    // ----- pages -----
    if (method === 'GET' && (path === '/' || path === '/screen')) {
      if (path === '/') return send(res, 302, '', { location: '/screen' })
      return page(res, 'screen.html')
    }
    if (method === 'GET' && path === '/admin') {
      if (!isAdmin(req, url)) return send(res, 401, 'Missing or wrong token.')
      return page(res, 'admin.html')
    }
    if (method === 'GET' && /^\/l\/[\w-]+$/.test(path)) return page(res, 'buyer.html')

    if (method === 'GET' && path === '/vendor/chart.js') {
      // Chart.js 4.4.1 (MIT) is served from the relay so the big screen works without internet access.
      try {
        return send(res, 200, await readFile(join(config.pagesDir, 'vendor', 'chart.umd.js')), { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' })
      } catch {
        return send(res, 404, 'Chart.js missing.')
      }
    }

    if (method === 'GET' && /^\/photo\/[\w.-]+$/.test(path)) {
      const name = path.slice('/photo/'.length)
      const file = name === 'rehearsal.svg' ? join(config.rehearsalDir, 'photo.svg') : join(config.dataDir, 'photos', name)
      try {
        const data = await readFile(file)
        return send(res, 200, data, { 'content-type': MIME[extname(name)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=60' })
      } catch {
        return send(res, 404, 'Not found.')
      }
    }

    // ----- public API -----
    if (method === 'GET' && path === '/api/state') return send(res, 200, screenState())

    if (method === 'GET' && path === '/api/qr.svg') {
      const l = engine.listing
      if (!l) return send(res, 404, 'No listing.')
      const svg = await QRCode.toString(`${config.publicBaseUrl}/l/${l.id}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      return send(res, 200, svg, { 'content-type': 'image/svg+xml' })
    }

    const m = /^\/api\/l\/([\w-]+)\/(public|join|offer|me)$/.exec(path)
    if (m) {
      const l = engine.listing
      if (!l || !l.published || l.id !== m[1]) return send(res, 404, { error: 'No such listing.' })
      const action = m[2]
      const cookies = parseCookies(req)

      if (method === 'GET' && action === 'public') return send(res, 200, { listing: publicListing(l) })

      if (method === 'POST' && action === 'join') {
        const r = await relay.joinBuyer(cookies.bt)
        if ('error' in r) return send(res, r.error === 'full' ? 503 : 409, { error: r.error === 'full' ? 'This listing is full.' : 'This listing is not open for buyers.' })
        const cookie = `bt=${r.buyer.buyer_token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
        return send(res, r.created ? 201 : 200, { handle: r.buyer.handle }, { 'set-cookie': cookie })
      }

      const buyer = engine.buyerByToken(cookies.bt)
      if (!buyer) return send(res, 401, { error: 'Join first.' })

      if (method === 'GET' && action === 'me') return send(res, 200, buyerView(buyer))

      if (method === 'POST' && action === 'offer') {
        let parsed: unknown
        try {
          parsed = JSON.parse(await readBody(req, 512))
        } catch {
          engine.noteRejected('schema', now())
          return send(res, 400, { error: 'Send exactly {"amount": number, "intent": "offer" | "final_offer"}.' })
        }
        const body = validateOfferBody(parsed)
        if (!body.ok) {
          engine.noteRejected('schema', now())
          return send(res, 400, { error: 'Send exactly {"amount": number, "intent": "offer" | "final_offer"}.' })
        }
        const r = relay.submit(buyer, body.amount, body.intent)
        switch (r.kind) {
          case 'rate_limited':
            return send(res, 429, { error: 'One offer every few seconds.' })
          case 'closed':
            return send(res, 409, { error: 'closed', reply: template('closed') })
          case 'not_open':
          case 'no_listing':
            return send(res, 409, { error: 'The auction has not opened yet.' })
          case 'excluded':
            return send(res, 200, { status: 'excluded', reply: r.reply })
          default:
            return send(res, 202, { status: 'accepted' })
        }
      }
      return send(res, 405, { error: 'Method not allowed.' })
    }

    // ----- admin API -----
    if (path.startsWith('/api/admin/')) {
      if (!isAdmin(req, url)) return send(res, 401, { error: 'Missing or wrong admin token.' })
      const action = path.slice('/api/admin/'.length)

      if (method === 'GET' && action === 'state') return send(res, 200, adminState())
      if (method !== 'POST') return send(res, 405, { error: 'Method not allowed.' })

      switch (action) {
        case 'create': {
          const body = JSON.parse(await readBody(req, 8 * 1024 * 1024)) as { photo?: unknown; description?: unknown; floor?: unknown }
          const description = typeof body.description === 'string' ? body.description.trim() : ''
          if (description.length < 3 || description.length > 300) throw new HttpError(400, 'Describe the item in 3 to 300 characters.')
          if (typeof body.photo !== 'string') throw new HttpError(400, 'A photo is required.')
          const dataUrl = /^data:image\/(?:jpeg|png|webp|heic|heif);base64,(.+)$/s.exec(body.photo)
          if (!dataUrl) throw new HttpError(400, 'The photo must be a JPEG, PNG or WebP data URL.')
          const floor = body.floor === undefined || body.floor === '' || body.floor === null ? undefined : Number(body.floor)
          if (floor !== undefined && !(floor > 0 && floor < 100000)) throw new HttpError(400, 'The floor must be a positive number.')
          const l = await relay.createListing(Buffer.from(dataUrl[1] as string, 'base64'), description, floor)
          return send(res, 201, { id: l.id })
        }
        case 'approve-listing':
          return send(res, 200, { ok: await relay.decide('listing', 'allow-once') })
        case 'reject-listing':
          return send(res, 200, { ok: await relay.decide('listing', 'deny') })
        case 'approve-sale':
          return send(res, 200, { ok: await relay.decide('sale', 'allow-once') })
        case 'open': {
          const err = relay.open()
          return send(res, err ? 409 : 200, err ? { error: err } : { ok: true })
        }
        case 'close': {
          const err = await relay.close()
          return send(res, err ? 409 : 200, err ? { error: err } : { ok: true })
        }
        case 'force-sale': {
          const err = relay.forceSale()
          return send(res, err ? 409 : 200, err ? { error: err } : { ok: true })
        }
        case 'load-rehearsal': {
          const l = await relay.loadRehearsal()
          return send(res, 201, { id: l.id })
        }
        case 'channel': {
          const body = JSON.parse(await readBody(req, 256)) as { mode?: unknown }
          const err = relay.setChannel(body.mode as 'qr' | 'marketplace')
          return send(res, err ? 409 : 200, err ? { error: err } : { ok: true, channel: engine.state.channel })
        }
        case 'reset':
          await relay.reset()
          return send(res, 200, { ok: true })
        case 'debug/fair-value': {
          // Pure computation for the attack bot's Comp poisoner test. Changes nothing.
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { comps?: Comp[]; retail?: number; condition?: Condition }
          const fv = computeFairValue({ comps: body.comps ?? [], retailAnchorPrice: body.retail, condition: body.condition ?? 'good' })
          return send(res, 200, 'error' in fv ? fv : { ...fv, ...priceSetup(fv.fair) })
        }
        default:
          return send(res, 404, { error: 'Unknown admin action.' })
      }
    }

    if (await handleMarket(relay, req, res, url)) return

    return send(res, 404, 'Not found.')
  }

  async function page(res: ServerResponse, name: string): Promise<void> {
    try {
      const html = await readFile(join(config.pagesDir, name))
      send(res, 200, html, { 'content-type': MIME['.html'] as string, 'content-security-policy': CSP })
    } catch {
      send(res, 404, 'Page missing.')
    }
  }

  return createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.end()
      if (e instanceof HttpError) return send(res, e.status, { error: e.message })
      if (e instanceof SyntaxError) return send(res, 400, { error: 'Bad JSON.' })
      console.error('[web]', e)
      send(res, 500, { error: 'Server error.' })
    })
  })
}
