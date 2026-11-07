// Custom tools. They run here in the relay, so keys, prices and money rules never enter the sandbox.
// Every input is re-validated: the JSON schema only guides the model, it does not bind it.
import { pickWinner, type Comp, type Condition } from './book.ts'
import type { Copy, Item } from './engine.ts'
import type { Relay } from './relay.ts'
import { zoodataSearch } from './zoodata.ts'

export type Role = 'lister' | 'negotiator' | 'responder' | 'closer'

export interface ToolContext {
  buyerId?: string | undefined
}

export interface ToolResult {
  value: unknown
  isError?: boolean
}

const err = (message: string): ToolResult => ({ value: { error: message }, isError: true })

const ALLOWED: Record<Role, readonly string[]> = {
  lister: ['zoodata_search', 'publish_listing'],
  negotiator: ['get_state', 'record_counter'],
  responder: ['get_state', 'record_counter'], // the marketplace Negotiator: same two tools, plus a browser in its sandbox
  closer: ['get_final_book', 'propose_sale', 'confirm_sale', 'notify'],
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined)
const optStr = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.trim().slice(0, max) || undefined : undefined)
const CONDITIONS: Condition[] = ['new_with_tags', 'excellent', 'good', 'fair']
const PRICE_IN_TEXT = /\$\s?\d|\b\d[\d,.]*\s?(?:dollars|usd|bucks)\b/i
const httpUrl = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim().slice(0, 500) : ''
  return /^https?:\/\//i.test(s) ? s : ''
}

function parsePublish(
  input: unknown,
): { ok: true; item: Item; retail_anchor: { title?: string | undefined; url?: string | undefined; price: number } | undefined; comps: Comp[]; copy: Copy } | { ok: false; error: string } {
  if (!isObj(input)) return { ok: false, error: 'Input must be an object.' }
  const it = input.item
  if (!isObj(it)) return { ok: false, error: 'item is required.' }
  const category = str(it.category, 80)
  const color = str(it.color, 40)
  if (!category || !color) return { ok: false, error: 'item.category and item.color are required.' }
  if (!CONDITIONS.includes(it.condition as Condition)) return { ok: false, error: 'item.condition must be new_with_tags, excellent, good or fair.' }
  if (typeof it.photo_matches_description !== 'boolean') return { ok: false, error: 'item.photo_matches_description must be true or false.' }
  const item: Item = {
    category,
    color,
    condition: it.condition as Condition,
    photo_matches_description: it.photo_matches_description,
    ...(optStr(it.brand, 60) ? { brand: optStr(it.brand, 60) as string } : {}),
    ...(optStr(it.model, 100) ? { model: optStr(it.model, 100) as string } : {}),
    ...(optStr(it.size, 30) ? { size: optStr(it.size, 30) as string } : {}),
    ...(optStr(it.material, 80) ? { material: optStr(it.material, 80) as string } : {}),
    ...(optStr(it.notes, 300) ? { notes: optStr(it.notes, 300) as string } : {}),
  }

  let retail_anchor: { title?: string | undefined; url?: string | undefined; price: number } | undefined
  if (input.retail_anchor !== undefined) {
    const ra = input.retail_anchor
    if (!isObj(ra) || typeof ra.price !== 'number' || !(ra.price > 0)) return { ok: false, error: 'retail_anchor.price must be a positive number.' }
    retail_anchor = { title: optStr(ra.title, 200), url: httpUrl(ra.url) || undefined, price: ra.price }
  }

  if (!Array.isArray(input.comps) || input.comps.length < 3 || input.comps.length > 15) {
    return { ok: false, error: 'comps must have 3 to 15 entries.' }
  }
  const comps: Comp[] = []
  for (const c of input.comps) {
    if (!isObj(c) || typeof c.price !== 'number' || !(c.price > 0) || !['resale', 'new'].includes(String(c.kind)) || !['exact', 'similar', 'loose'].includes(String(c.match))) {
      return { ok: false, error: 'Each comp needs title, url, price > 0, kind (resale|new) and match (exact|similar|loose).' }
    }
    comps.push({ title: optStr(c.title, 200) ?? 'Untitled', url: httpUrl(c.url), price: c.price, kind: c.kind as Comp['kind'], match: c.match as Comp['match'] })
  }

  const cp = input.copy
  if (!isObj(cp)) return { ok: false, error: 'copy is required.' }
  const title = str(cp.title, 1000)
  const description = str(cp.description, 1000)
  if (!title || title.length > 70) return { ok: false, error: 'copy.title is required and must be at most 70 characters.' }
  if (!description || description.length > 300) return { ok: false, error: 'copy.description is required and must be at most 300 characters.' }
  if (!Array.isArray(cp.bullets) || cp.bullets.length < 1 || cp.bullets.length > 5 || cp.bullets.some((b) => typeof b !== 'string' || b.length > 90)) {
    return { ok: false, error: 'copy.bullets must have 1 to 5 strings of at most 90 characters.' }
  }
  const copyText = [title, description, ...(cp.bullets as string[])].join(' ')
  if (PRICE_IN_TEXT.test(copyText)) return { ok: false, error: 'The copy must not contain prices: the relay sets the price.' }
  const image = httpUrl(cp.image_url)
  const copy: Copy = { title, description, bullets: (cp.bullets as string[]).map((b) => b.trim()), ...(image ? { image_url: image } : {}) }
  return { ok: true, item, retail_anchor, comps, copy }
}

export async function handleTool(relay: Relay, role: Role, ctx: ToolContext, name: string, input: unknown): Promise<ToolResult> {
  if (!ALLOWED[role].includes(name)) return err(`${name} is not available to this agent.`)
  const engine = relay.engine
  const now = Date.now()

  switch (name) {
    // ----- Lister -----
    case 'zoodata_search': {
      const keyword = isObj(input) ? str(input.keyword, 80) : undefined
      if (!keyword) return err('keyword is required (at most 80 characters).')
      const r = await zoodataSearch(keyword)
      engine.listerLog(`zoodata_search "${keyword}" -> ${r.results.length} result(s)`, now)
      return { value: r.note ? { results: r.results, note: r.note } : r.results }
    }
    case 'publish_listing': {
      const parsed = parsePublish(input)
      if (!parsed.ok) return err(parsed.error)
      const l = engine.listing
      if (!l || l.status !== 'draft') return err('There is no draft listing waiting for the Lister.')
      // The presenter must approve before anything is published, even if the platform gate did not fire.
      const approved = await relay.requireApproval('listing', 'publish_listing', parsed as unknown as Record<string, unknown>)
      if (!approved) return err('The presenter declined this listing.')
      const res = engine.publishListing(parsed, now)
      if (!res.ok) return err(res.error)
      l.approved = true
      return { value: res.result }
    }

    // ----- Negotiator -----
    case 'get_state': {
      const buyer = engine.buyerById(ctx.buyerId)
      if (!buyer) return err('Unknown buyer session.')
      const s = engine.getState(buyer, now)
      return 'error' in s ? err(s.error) : { value: s }
    }
    case 'record_counter': {
      const buyer = engine.buyerById(ctx.buyerId)
      if (!buyer) return err('Unknown buyer session.')
      if (!isObj(input)) return err('Input must be an object.')
      if (!relay.turns.isCurrent(buyer.id)) return { value: { ok: false, reason: 'This turn expired; the relay already replied to the buyer.' } }
      const r = engine.recordCounter(buyer, { label: input.label, line: input.line, amount: input.amount }, now)
      if (r.ok) relay.turns.onRecorded(buyer.id)
      return { value: r }
    }

    // ----- Closer -----
    case 'get_final_book': {
      const l = engine.listing
      if (!l || l.status !== 'closing') return err('The auction is not closing.')
      const book = engine.finalBook()
      return 'error' in book ? err(book.error) : { value: book }
    }
    case 'propose_sale': {
      const l = engine.listing
      if (!l || l.status !== 'closing') return err('The auction is not closing.')
      if (!isObj(input)) return err('Input must be an object.')
      return { value: engine.proposeSale({ buyer_id: input.buyer_id, amount: input.amount, reason: input.reason }, now) }
    }
    case 'confirm_sale': {
      const l = engine.listing
      if (!l || l.status !== 'closing') return err('The auction is not closing.')
      if (!isObj(input) || typeof input.buyer_id !== 'string' || typeof input.amount !== 'number') return err('buyer_id and amount are required.')
      const prop = engine.state.proposal
      if (!prop || prop.buyer_id !== input.buyer_id || prop.amount !== input.amount) {
        return err('Call propose_sale first, and use the same buyer_id and amount.')
      }
      // Only the presenter can make the sale final.
      const approved = await relay.requireApproval('sale', 'confirm_sale', { buyer_id: input.buyer_id, amount: input.amount })
      if (!approved) return err('The presenter declined the sale.')
      const top = pickWinner(engine.liveValidOffers())
      if (!top || top.buyer_id !== input.buyer_id || top.amount !== input.amount) return err('That is no longer the top valid offer.')
      try {
        return { value: relay.completeSale(input.buyer_id, input.amount) }
      } catch (e) {
        return err((e as Error).message)
      }
    }
    case 'notify': {
      if (!isObj(input)) return err('Input must be an object.')
      return { value: relay.notify(input.winner, input.others) }
    }
    default:
      return err(`Unknown tool ${name}.`)
  }
}
