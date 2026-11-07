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
  payWindowMs: Math.round(20_000 / timeScale),
  turnDeadlineMs: num('TURN_DEADLINE_MS', 8000),
  globalTurnCap: num('GLOBAL_TURN_CAP', 30),
  maxBuyers: num('MAX_BUYERS', 150),
  feePct: num('FEE_PCT', 0.1),
  maxPaymentTries: 3,
  adminToken: process.env.ADMIN_TOKEN || randomBytes(12).toString('hex'),
  adminTokenGenerated: !process.env.ADMIN_TOKEN,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  zoodataApiKey: process.env.ZOODATA_API_KEY ?? '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  dataDir: resolve(process.env.DATA_DIR ?? 'data'),
  pagesDir: resolve('pages'),
  agentsDir: resolve('agents'),
}

export type Config = typeof config
