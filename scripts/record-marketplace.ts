// One-command recorder for the marketplace demo: the agent's browser on the left, the seller dashboard on the right.
//
//   npm run record:marketplace -- --tunnel cloudflared          real run on ZooWork Managed Agents (needs a tunnel)
//   PUBLIC_BASE_URL=https://xyz.ngrok.app npm run record:marketplace    same, with a tunnel you started yourself
//   npm run record:marketplace -- --stub                        free rehearsal with local stand-ins, clearly labelled STUB RUN
//
// What it does: starts the relay, switches to the Marketplace channel, loads the rehearsal listing, opens the auction,
// runs 30 fake buyers (one message every 10 to 15 s), records /split in a headless browser, presses Approve sale as the
// presenter (captioned), and writes docs/demo/marketplace-demo.webm (+ .mp4 if ffmpeg is installed).
//
// The real run uses your prepaid ZooWork balance: check Usage in ZooWork Platform afterwards.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createZooworkClient } from '@zoowork-ai/sdk'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string): boolean => process.argv.includes(name)
const stub = has('--stub')
const port = Number(arg('--port') ?? 8787)
const seconds = Number(arg('--seconds') ?? 60)
const buyers = Number(arg('--buyers') ?? 30)
const speed = Math.max(1, Number(arg('--speed') ?? 1))
const [w, h] = (arg('--size') ?? '1920x1080').split('x').map(Number) as [number, number]
const outFile = resolve(arg('--out') ?? (stub ? 'docs/demo/stub-rehearsal.webm' : 'docs/demo/marketplace-demo.webm'))
const adminToken = randomBytes(12).toString('hex')
const marketKey = randomBytes(12).toString('hex')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (m: string): void => console.log(`${new Date().toTimeString().slice(0, 8)}  ${m}`)

const children: ChildProcess[] = []
const cleanup = (): void => { for (const c of children) if (!c.killed) c.kill('SIGTERM') }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

async function main(): Promise<void> {
  let publicBase = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')
  const local = `http://localhost:${port}`

  // ---- tunnel (real run only: ZooWork's sandbox has to reach the marketplace) ----
  if (!stub && arg('--tunnel') === 'cloudflared') {
    log('starting a cloudflared quick tunnel…')
    const t = spawn('cloudflared', ['tunnel', '--url', local], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(t)
    publicBase = await new Promise<string>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('cloudflared did not print a URL in 30 s')), 30_000)
      const onData = (d: Buffer): void => {
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d))
        if (m) { clearTimeout(timer); res(m[0]) }
      }
      t.stdout.on('data', onData); t.stderr.on('data', onData)
      t.on('error', (e) => rej(new Error(`could not run cloudflared (${e.message}). Install it, or start a tunnel yourself and set PUBLIC_BASE_URL.`)))
    })
    log(`tunnel: ${publicBase}`)
  }
  if (!stub && (!publicBase || /localhost|127\.0\.0\.1/.test(publicBase))) {
    throw new Error('A real run needs a public URL for the ZooWork sandbox. Use --tunnel cloudflared, or set PUBLIC_BASE_URL to your tunnel (ngrok, cloudflared).')
  }
  const base = stub ? local : publicBase

  // ---- the four agents must exist and be running (real run) ----
  if (!stub) {
    if (!process.env.ZOOWORK_API_KEY) throw new Error('Set ZOOWORK_API_KEY in your environment first.')
    const ids = JSON.parse(readFileSync('agents/ids.json', 'utf8')) as Record<string, string>
    if (!ids.responder) throw new Error('agents/ids.json has no responder yet. Run `npm run create-agents` first.')
    const client = createZooworkClient()
    for (const role of ['responder', 'closer'] as const) {
      const a = await client.getAgent(ids[role] as string)
      if (a.status?.desired_state !== 'running') {
        if (!has('--start-agents')) throw new Error(`The ${role} agent is not running. Run \`npm run create-agents\` (it starts them) or pass --start-agents.`)
        await client.startAgent(ids[role] as string)
        await client.waitUntilRunning(ids[role] as string)
      }
    }
    log('agents are running')
  }

  // ---- relay ----
  const dataDir = mkdtempSync(join(tmpdir(), 'snapsell-rec-'))
  const relay = spawn(process.execPath, ['relay/index.ts'], {
    env: {
      ...process.env,
      ZOOWORK_MODE: stub ? 'stub' : 'live',
      PORT: String(port),
      ADMIN_TOKEN: adminToken,
      MARKET_KEY: marketKey,
      PUBLIC_BASE_URL: base,
      AUCTION_SECONDS: String(seconds),
      TIME_SCALE: String(speed),
      DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(relay)
  relay.stderr.on('data', (d) => process.stderr.write(`[relay] ${d}`))
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${local}/api/state`)).ok) break } catch { /* not up yet */ }
    await sleep(500)
  }
  const admin = async (path: string, body?: unknown): Promise<any> => {
    const get = path === 'state'
    const r = await fetch(`${local}/api/admin/${path}`, { method: get ? 'GET' : 'POST', headers: { 'x-admin-token': adminToken, 'content-type': 'application/json' }, ...(get ? {} : { body: JSON.stringify(body ?? {}) }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`admin/${path}: ${r.status} ${JSON.stringify(j)}`)
    return j
  }
  log(`relay up (${stub ? 'STUB' : 'LIVE'} mode)`)

  await admin('channel', { mode: 'marketplace' })
  await admin('load-rehearsal')
  if (!stub) await sleep(8000) // let the agent's browser upload and warm up before the first DM

  // ---- browser + video ----
  // playwright is loaded with require so it also resolves from a global install; install it with `npm i -D playwright && npx playwright install chromium`.
  const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<any> } }
  const videoDir = mkdtempSync(join(tmpdir(), 'snapsell-video-'))
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, recordVideo: { dir: videoDir, size: { width: w, height: h } } })
  const page: any = await ctx.newPage()
  const label = stub ? 'STUB RUN (local browser, not ZooWork)' : 'LIVE on ZooWork Managed Agents'
  const where = stub ? 'local Chromium' : 'ZooWork sandbox Chromium'
  await page.goto(`${local}/split?label=${encodeURIComponent(label)}&where=${encodeURIComponent(where)}`)
  const caption = async (text: string, ms = 4000): Promise<void> => {
    await page.evaluate(([t, d]: [string, number]) => {
      const el = document.createElement('div')
      el.textContent = t
      el.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);background:rgba(15,20,27,.94);color:#f1f3f6;border:1px solid #4cc3a3;border-radius:12px;padding:12px 22px;font:600 20px system-ui;z-index:99;max-width:80%;text-align:center'
      document.body.append(el)
      setTimeout(() => el.remove(), d)
    }, [text, ms] as [string, number]).catch(() => {})
  }
  await sleep(1500)
  await caption(`${buyers} fake buyers, one message every 10 to 15 s. Each reply is written by a ZooWork agent working a real browser.`, 5000)
  await sleep(2500)

  // ---- open the auction and run the buyers ----
  await admin('open')
  log('auction open; starting the fake buyers')
  const bots = spawn(process.execPath, ['bot/marketplace-buyers.ts', '--base', local, '--token', adminToken, '--buyers', String(buyers), '--interval', arg('--interval') ?? '10-15', '--speed', String(speed)], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(bots)
  let botOut = ''
  bots.stdout.on('data', (d) => { botOut += d })
  bots.stderr.on('data', (d) => { botOut += d })
  const botDone = new Promise<number>((r) => bots.on('close', (c) => r(c ?? 1)))

  // ---- the presenter's step, captioned ----
  let sold = false
  const presenter = (async () => {
    for (let i = 0; i < 1200 && !sold; i++) {
      const s = await admin('state')
      const st = s.listing?.status
      if (st === 'sold' || st === 'unsold') { sold = true; return }
      if (s.approvals.some((a: any) => a.kind === 'sale')) {
        await caption('Presenter approves the sale (automated for this recording)', 3000)
        await sleep(1800)
        await admin('approve-sale')
      } else if (s.closer_stalled) {
        await admin('force-sale')
      }
      await sleep(500)
    }
  })()
  await presenter
  await sleep(1500)
  await caption('Sold. Floor revealed on the stats card.', 4000)
  await sleep(6000)
  await page.screenshot({ path: outFile.replace(/\.webm$/, '-final.png') }).catch(() => {})
  const code = await Promise.race([botDone, sleep(15_000).then(() => 0)])

  const video = page.video()
  await ctx.close()
  const raw = await video?.path()
  await browser.close()
  mkdirSync(resolve(outFile, '..'), { recursive: true })
  if (raw && existsSync(raw)) renameSync(raw, outFile)
  log(`video: ${outFile}`)
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', outFile, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile.replace(/\.webm$/, '.mp4')])
    log(`mp4:   ${outFile.replace(/\.webm$/, '.mp4')}`)
  } catch {
    log('ffmpeg not found: the .webm is the deliverable (it plays in any browser)')
  }

  console.log('\n' + botOut.split('\n').filter((l) => /^(PASS|FAIL|buyers |reply time|turns:)|checks passed/.test(l)).join('\n'))
  cleanup()
  process.exit(code === 0 ? 0 : 1)
}

main().catch((e) => { console.error(`\nrecording failed: ${(e as Error).message}`); cleanup(); process.exit(1) })
