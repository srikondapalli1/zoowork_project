import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const num = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`)
  return n
}

const port = num('PORT', 8787)
// Test knob: divides every real-time duration so the attack bot can run at 3x.
const timeScale = Math.max(1, num('TIME_SCALE', 1))

export const config = {
  port,
  /** "stub" runs the three agents as local code (free, for tests); "live" uses ZooWork Managed Agents. */
  mode: (process.env.ZOOWORK_MODE === 'live' ? 'live' : 'stub') as 'live' | 'stub',
  timeScale,
  auctionSeconds: num('AUCTION_SECONDS', 90),
  rateLimitMs: Math.round(3000 / timeScale),
  turnDeadlineMs: num('TURN_DEADLINE_MS', 8000),
  /** A browser-driven reply takes several model steps, so marketplace DMs get a longer promise. */
  marketDeadlineMs: num('MARKET_DEADLINE_MS', 12000),
  /** Scoped key the browser agent uses for the seller inbox and the browser feed. It cannot reach /api/admin. */
  marketKey: process.env.MARKET_KEY || randomBytes(12).toString('hex'),
  marketKeyGenerated: !process.env.MARKET_KEY,
  globalTurnCap: num('GLOBAL_TURN_CAP', 30),
  maxBuyers: num('MAX_BUYERS', 150),
  feePct: num('FEE_PCT', 0.1),
  adminToken: process.env.ADMIN_TOKEN || randomBytes(12).toString('hex'),
  adminTokenGenerated: !process.env.ADMIN_TOKEN,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  zoodataApiKey: process.env.ZOODATA_API_KEY ?? '',
  dataDir: resolve(process.env.DATA_DIR ?? 'data'),
  /** Saved rehearsal listing and its photo: shipped with the repo, independent of DATA_DIR. */
  rehearsalDir: resolve('data/rehearsal'),
  pagesDir: resolve('pages'),
  agentsDir: resolve('agents'),
}

export type Config = typeof config

/** Is this a URL phones in the room can actually open? */
export function publicUrlProblem(raw: string): { level: 'fail' | 'warn'; message: string } | undefined {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { level: 'fail', message: 'PUBLIC_BASE_URL is not a valid URL.' }
  }
  const host = u.hostname.toLowerCase()
  const privateHost =
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0' || host === '[::1]' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  if (privateHost) {
    return {
      level: 'fail',
      message: `PUBLIC_BASE_URL (${u.origin}) points at this machine or a private network, so phones in the room cannot open the QR code. Start a tunnel and set PUBLIC_BASE_URL to its https address.`,
    }
  }
  if (u.protocol !== 'https:') return { level: 'warn', message: 'PUBLIC_BASE_URL is not https: use an https tunnel so phones and cookies behave.' }
  return undefined
}
