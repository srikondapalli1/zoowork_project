// Swapspot marketplace routes. Three audiences, three kinds of auth:
//   buyers (the fake-buyer script, or a human)   x-buyer-token, issued when they register
//   the seller (the browser agent)               x-market-key, scoped: inbox + feed only, never /api/admin
//   the public                                   listing facts and reply-latency stats, no message text
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { config } from '../config.ts'
import { CSP, MIME, HttpError, readBody, safeEqual, send } from '../http.ts'
import type { Buyer, Listing } from '../engine.ts'
import type { Relay } from '../relay.ts'
import { inboxView, threadById, threadView } from './store.ts'

const BAD_BODY = { error: 'Send exactly {"text": "..."}.' }

async function page(res: ServerResponse, name: string): Promise<void> {
  try {
    send(res, 200, await readFile(join(config.pagesDir, name)), { 'content-type': MIME['.html'] as string, 'content-security-policy': CSP })
  } catch {
    send(res, 404, 'Page missing.')
  }
}

/** Returns true if the request was a marketplace route and has been answered. */
export async function handleMarket(relay: Relay, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname
  const method = req.method ?? 'GET'
  const engine = relay.engine
  if (!path.startsWith('/market') && !path.startsWith('/api/market/') && path !== '/split') return false

  const keyOk = (): boolean => {
    const given = String(req.headers['x-market-key'] ?? url.searchParams.get('key') ?? '')
    return given !== '' && safeEqual(given, config.marketKey)
  }
  const listing = (): Listing | undefined => engine.listing
  const publicListing = () => {
    const l = listing()
    return l && l.published
      ? {
          id: l.id,
          status: l.status,
          title: l.copy?.title ?? '',
          description: l.copy?.description ?? '',
          bullets: l.copy?.bullets ?? [],
          photo_url: l.photo_url,
          ask: l.ask ?? null,
          seconds_left: engine.secondsLeft(Date.now()),
        }
      : null
  }

  // ----- pages -----
  if (method === 'GET' && (path === '/market' || path === '/market/')) return await page(res, 'market.html'), true
  if (method === 'GET' && path === '/market/inbox') {
    if (!keyOk()) return send(res, 401, 'Missing or wrong marketplace key.'), true
    return await page(res, 'market-inbox.html'), true
  }
  if (method === 'GET' && path === '/split') return await page(res, 'split.html'), true

  // ----- public -----
  if (method === 'GET' && path === '/api/market/listing') {
    return send(res, 200, { channel: engine.state.channel, listing: publicListing(), stats: relay.marketStats() }), true
  }
  if (method === 'GET' && path === '/api/market/stats') return send(res, 200, relay.marketStats()), true

  // ----- buyers -----
  if (method === 'POST' && path === '/api/market/buyers') {
    let body: unknown
    try {
      body = JSON.parse(await readBody(req, 512))
    } catch {
      return send(res, 400, { error: 'Send {"name": "..."}.' }), true
    }
    const name = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).name : undefined
    const r = relay.joinMarket(name)
    if ('error' in r) {
      const msg = { full: 'This listing is full.', closed: 'This listing is not taking messages.', wrong_channel: 'The marketplace channel is switched off.' }[r.error]
      return send(res, r.error === 'full' ? 503 : 409, { error: msg }), true
    }
    return send(res, 201, { handle: r.buyer.handle, thread_id: r.buyer.thread_id, buyer_token: r.buyer.buyer_token }), true
  }

  const bm = /^\/api\/market\/threads\/([\w-]+)(?:\/(messages))?$/.exec(path)
  if (bm) {
    const t = threadById(engine, bm[1] as string)
    const buyer: Buyer | undefined = t ? engine.buyerById(t.buyer_id) : undefined
    const token = String(req.headers['x-buyer-token'] ?? '')
    if (!t || !buyer || token === '' || !safeEqual(token, buyer.buyer_token)) return send(res, 401, { error: 'Not your thread.' }), true
    if (method === 'GET' && !bm[2]) return send(res, 200, { thread: threadView(t), seconds_left: engine.secondsLeft(Date.now()), status: listing()?.status ?? null }), true
    if (method === 'POST' && bm[2] === 'messages') {
      let body: unknown
      try {
        body = JSON.parse(await readBody(req, 1024))
      } catch {
        engine.noteRejected('schema', Date.now())
        return send(res, 400, BAD_BODY), true
      }
      const keys = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.keys(body) : []
      if (keys.length !== 1 || keys[0] !== 'text') {
        engine.noteRejected('schema', Date.now())
        return send(res, 400, BAD_BODY), true
      }
      const r = relay.marketMessage(buyer, (body as { text: unknown }).text)
      return send(res, r.status, r.body), true
    }
    return send(res, 405, { error: 'Method not allowed.' }), true
  }

  // ----- the seller (browser agent) -----
  if (path.startsWith('/api/market/seller/')) {
    if (!keyOk()) return send(res, 401, { error: 'Missing or wrong marketplace key.' }), true
    if (method === 'GET' && path === '/api/market/seller/threads') return send(res, 200, { threads: inboxView(engine) }), true
    const sm = /^\/api\/market\/seller\/threads\/([\w-]+)(?:\/(send))?$/.exec(path)
    if (sm) {
      const t = threadById(engine, sm[1] as string)
      if (!t) return send(res, 404, { error: 'No such thread.' }), true
      if (method === 'GET' && !sm[2]) return send(res, 200, { thread: threadView(t) }), true
      if (method === 'POST' && sm[2] === 'send') {
        let body: unknown
        try {
          body = JSON.parse(await readBody(req, 1024))
        } catch {
          return send(res, 400, BAD_BODY), true
        }
        const r = relay.marketSellerSend(t.id, typeof body === 'object' && body !== null ? (body as { text?: unknown }).text : undefined)
        return send(res, r.status, r.body), true
      }
    }
    return send(res, 404, { error: 'Not found.' }), true
  }

  // ----- the agent's browser feed (frames and an action log pushed from the sandbox) -----
  if (method === 'POST' && path === '/api/market/feed') {
    if (!keyOk()) return send(res, 401, { error: 'Missing or wrong marketplace key.' }), true
    let body: { frame?: unknown; action?: unknown }
    try {
      body = JSON.parse(await readBody(req, 600 * 1024))
    } catch (e) {
      if (e instanceof HttpError) throw e
      return send(res, 400, { error: 'Bad JSON.' }), true
    }
    const frame = typeof body.frame === 'string' && body.frame.length < 560_000 ? Buffer.from(body.frame, 'base64') : undefined
    relay.feed.push(frame, typeof body.action === 'string' ? body.action : undefined, Date.now())
    return send(res, 204, ''), true
  }
  if (method === 'GET' && path === '/api/market/feed/frame.jpg') {
    const f = relay.feed.frame
    if (!f) return send(res, 404, 'No frame yet.'), true
    return send(res, 200, f, { 'content-type': 'image/jpeg' }), true
  }
  if (method === 'GET' && path === '/api/market/feed/actions') {
    return send(res, 200, { actions: relay.feed.actions.slice(-30), frame_at: relay.feed.frameAt }), true
  }

  return send(res, 404, { error: 'Not found.' }), true
}
