// ZooData retail-price lookup. The key never leaves the relay.
// ASSUMPTION: the spec gives the endpoint but not the request or response shape. This sends
// {"keyword": ...} with a Bearer key and reads the product list defensively. Confirm against the
// ZooData docs; a failure returns an empty result so the Lister falls back to web_search.
import { config } from './config.ts'

export interface ZooDataProduct {
  title: string
  asin: string
  price: number | null
  rating: number | null
  image: string
}

const URL_ = 'https://api.zoodata.ai/openapi/v2/products/search'

const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''))
    return Number.isFinite(n) && n > 0 ? n : null
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return asNumber(o.amount ?? o.value ?? o.current ?? o.price)
  }
  return null
}

const findList = (json: unknown): unknown[] => {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>
    for (const k of ['products', 'results', 'items', 'data']) {
      const v = o[k]
      if (Array.isArray(v)) return v
      if (v && typeof v === 'object') {
        const inner = findList(v)
        if (inner.length) return inner
      }
    }
  }
  return []
}

export async function zoodataSearch(keyword: string): Promise<{ results: ZooDataProduct[]; note?: string }> {
  if (!config.zoodataApiKey) return { results: [], note: 'ZooData is not configured; use web_search for the retail price.' }
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.zoodataApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ keyword }),
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return { results: [], note: `ZooData returned ${res.status}; use web_search for the retail price.` }
    const results = findList(await res.json())
      .slice(0, 5)
      .map((row): ZooDataProduct => {
        const r = (row ?? {}) as Record<string, unknown>
        const image = r.image ?? r.image_url ?? r.thumbnail
        return {
          title: String(r.title ?? r.name ?? '').slice(0, 200),
          asin: String(r.asin ?? r.id ?? ''),
          price: asNumber(r.price ?? r.current_price),
          rating: asNumber(r.rating ?? r.stars),
          image: typeof image === 'string' ? image : '',
        }
      })
    return { results }
  } catch (e) {
    return { results: [], note: `ZooData lookup failed (${(e as Error).name}); use web_search for the retail price.` }
  }
}
