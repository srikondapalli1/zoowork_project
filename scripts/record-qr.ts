// Records the room (QR) demo end to end in one composite page: seller console | big screen | a buyer's phone.
//
//   npm run record:qr                       live on ZooWork Managed Agents (needs ZOOWORK_API_KEY and `npm run create-agents`)
//   npm run record:qr -- --stub             free rehearsal with local stand-ins, banner says STUB RUN
//
// On camera: the presenter attaches a photo and types what it is, the Lister researches and the console shows the comparables,
// the presenter approves and opens; the QR code goes up; one buyer's phone joins and haggles with the agent while the attack-bot
// personas (lowballers, whale, sniper, trolls, spammer, schema attacker) fill the chart; the clock runs out, the Closer proposes,
// the presenter approves the sale, and the winner and stats card appear. Presenter clicks are made by this script and captioned.
//
// Live runs use your prepaid ZooWork balance: check Usage in ZooWork Platform afterwards.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { createZooworkClient } from '@zoowork-ai/sdk'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string): boolean => process.argv.includes(name)
const stub = has('--stub')
const port = Number(arg('--port') ?? 8830)
const seconds = Number(arg('--seconds') ?? 75)
const crowd = Number(arg('--crowd') ?? 12)
const [w, h] = (arg('--size') ?? '1920x1080').split('x').map(Number) as [number, number]
const outFile = resolve(arg('--out') ?? (stub ? 'docs/demo/qr-stub-rehearsal.webm' : 'docs/demo/qr-room-demo.webm'))
const listerWaitMs = Number(arg('--lister-wait') ?? 120) * 1000
const adminToken = randomBytes(12).toString('hex')
const description = "Patagonia Better Sweater, men's M, navy, worn about 10 times"
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (m: string): void => console.log(`${new Date().toTimeString().slice(0, 8)}  ${m}`)

const children: ChildProcess[] = []
const cleanup = (): void => { for (const c of children) if (!c.killed) c.kill('SIGTERM') }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

async function main(): Promise<void> {
  const base = `http://localhost:${port}`

  // ---- live: the three agents must be running ----
  if (!stub) {
    if (!process.env.ZOOWORK_API_KEY) throw new Error('Set ZOOWORK_API_KEY first (or use --stub for a free rehearsal).')
    const ids = JSON.parse(readFileSync('agents/ids.json', 'utf8')) as Record<string, string>
    const client = createZooworkClient()
    for (const role of ['lister', 'negotiator', 'closer'] as const) {
      if (!ids[role]) throw new Error(`agents/ids.json has no ${role}. Run \`npm run create-agents -- --only lister,negotiator,closer\`.`)
      const a = await client.getAgent(ids[role] as string)
      if (a.status?.desired_state !== 'running') throw new Error(`The ${role} agent is not running. Run \`npm run create-agents -- --only lister,negotiator,closer\`.`)
    }
    log('lister, negotiator and closer are running')
  }

  // ---- relay ----
  const dataDir = mkdtempSync(join(tmpdir(), 'snapsell-qr-'))
  const relay = spawn(process.execPath, ['relay/index.ts'], {
    env: { ...process.env, ZOOWORK_MODE: stub ? 'stub' : 'live', PORT: String(port), ADMIN_TOKEN: adminToken, PUBLIC_BASE_URL: base, AUCTION_SECONDS: String(seconds), DATA_DIR: dataDir, STUB_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(relay)
  relay.stderr.on('data', (d) => process.stderr.write(`[relay] ${d}`))
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/state`)).ok) break } catch { /* not up yet */ }
    await sleep(500)
  }
  const admin = async (path: string, body?: unknown): Promise<any> => {
    const get = path === 'state'
    const r = await fetch(`${base}/api/admin/${path}`, { method: get ? 'GET' : 'POST', headers: { 'x-admin-token': adminToken, 'content-type': 'application/json' }, ...(get ? {} : { body: JSON.stringify(body ?? {}) }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`admin/${path}: ${r.status} ${JSON.stringify(j)}`)
    return j
  }
  const pub = async (): Promise<any> => (await fetch(`${base}/api/state`)).json()
  await admin('reset')
  await admin('channel', { mode: 'qr' })
  log(`relay up (${stub ? 'STUB' : 'LIVE'} mode, QR channel)`)

  // ---- the photo the presenter "takes" ----
  const photoPath = join(mkdtempSync(join(tmpdir(), 'snapsell-photo-')), 'jacket.jpg')
  await sharp('data/rehearsal/photo.svg').resize(1000).jpeg({ quality: 85 }).toFile(photoPath)

  // ---- browser + video ----
  const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<any> } }
  const videoDir = mkdtempSync(join(tmpdir(), 'snapsell-video-'))
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, recordVideo: { dir: videoDir, size: { width: w, height: h } } })
  const page: any = await ctx.newPage()
  const label = stub ? 'STUB RUN (local stand-ins, not ZooWork)' : 'LIVE on ZooWork Managed Agents'
  await page.goto(`${base}/qr-split?token=${adminToken}&label=${encodeURIComponent(label)}`)
  const con = page.frameLocator('#console')
  const phone = page.frameLocator('#phone')
  const caption = async (text: string, ms = 4000): Promise<void> => {
    await page.evaluate(([t, d]: [string, number]) => {
      const el = document.createElement('div')
      el.textContent = t
      el.style.cssText = 'position:fixed;left:50%;bottom:58px;transform:translateX(-50%);background:rgba(15,20,27,.95);color:#f1f3f6;border:1px solid #4cc3a3;border-radius:12px;padding:12px 22px;font:600 20px system-ui;z-index:99;max-width:80%;text-align:center'
      document.body.append(el)
      setTimeout(() => el.remove(), d)
    }, [text, ms] as [string, number]).catch(() => {})
  }
  await sleep(2000)
  await caption('A seller snaps one photo and types what it is. Three ZooWork agents do the rest.', 5000)
  await sleep(2500)

  // ---- 1. the presenter creates the listing ----
  await con.locator('#photo').setInputFiles(photoPath)
  await sleep(500)
  await con.locator('#desc').pressSequentially(description, { delay: 25 })
  await sleep(600)
  await con.locator('#create').click()
  log('listing created; the Lister is researching')
  await caption('The Lister reads the photo, searches resale sites and returns raw comparables. It never sets the price.', 6000)

  // ---- 2. wait for the Lister, then the presenter approves ----
  const t0 = Date.now()
  let usedRehearsal = false
  for (;;) {
    const s = await admin('state')
    if (s.approvals.some((a: any) => a.kind === 'listing')) break
    if (Date.now() - t0 > listerWaitMs) {
      log('the Lister did not finish in time: loading the saved rehearsal listing')
      await caption('The Lister stalled, so the presenter loads the saved listing.', 4500)
      await con.locator('#rehearsal').click()
      usedRehearsal = true
      break
    }
    await sleep(800)
  }
  if (!usedRehearsal) {
    await sleep(500)
    await caption('The relay computes the price from the comparables and drops the outliers. The presenter reviews and approves (automated for this recording).', 6500)
    await sleep(5500)
    await con.locator('#approveListing').click()
  }
  for (let i = 0; i < 60; i++) {
    const s = await admin('state')
    if (s.listing?.published && s.listing?.approved) break
    await sleep(500)
  }
  await sleep(1200)
  await con.locator('#open').click()
  const live = await pub()
  const mid: number = live.listing.fair_value.mid
  log(`auction open: fair mid ${mid}`)
  await caption('The QR code goes up. The room scans it and makes offers with a number and a button, nothing else.', 5000)

  // ---- 3. the crowd (attack-bot personas) in the background ----
  const bots = spawn(process.execPath, ['bot/attack.ts', '--base', base, '--token', adminToken, '--crowd', String(crowd)], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(bots)
  let botOut = ''
  bots.stdout.on('data', (d) => { botOut += d })
  bots.stderr.on('data', (d) => { botOut += d })
  const botDone = new Promise<number>((r) => bots.on('close', (c) => r(c ?? 1)))

  // ---- 4. one buyer's phone, on camera ----
  const replyText = async (): Promise<string> => (await phone.locator('#reply').textContent({ timeout: 1500 }).catch(() => '')) ?? ''
  const waitReplyChange = async (before: string, ms: number): Promise<string> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const t = await replyText()
      if (t && t !== before) return t
      await sleep(400)
    }
    return before
  }
  // The bot's first checks need a quiet relay (they count agent events). Let them finish before the on-camera buyer starts posting.
  for (const end = Date.now() + 60_000; !botOut.includes('Comp poisoner') && Date.now() < end; ) await sleep(500)
  await sleep(1500)
  await phone.locator('#join').click({ timeout: 20_000 })
  log('on-camera buyer joined')
  const welcome = await waitReplyChange('', 25_000)
  log(`buyer sees: ${welcome.slice(0, 90)}`)
  await caption('A buyer joins. The Negotiator greets them and knows only what the relay lets it see.', 4500)
  await sleep(2500)
  const first = Math.max(1, Math.round(mid * 0.85))
  await phone.locator('#amount').pressSequentially(String(first), { delay: 120 })
  await sleep(500)
  await phone.locator('#offer').click()
  log(`on-camera buyer offered ${first}`)
  const r1 = await waitReplyChange(welcome, 20_000)
  log(`buyer sees: ${r1.slice(0, 90)}`)
  await caption('The Negotiator counters in under 8 seconds. Every dollar figure in its reply is checked against the relay.', 5500)
  await sleep(4000)
  await phone.locator('#beat').click()
  await sleep(1200)
  await phone.locator('#final').click()
  log('on-camera buyer made a final offer')
  const r2 = await waitReplyChange(r1, 20_000)
  log(`buyer sees: ${r2.slice(0, 90)}`)

  // ---- 5. close, then the presenter approves the sale ----
  let saleCaptioned = false
  for (let i = 0; i < 1500; i++) {
    const s = await admin('state')
    const st = s.listing?.status
    if (st === 'sold' || st === 'unsold') break
    if (s.approvals.some((a: any) => a.kind === 'sale')) {
      if (!saleCaptioned) {
        saleCaptioned = true
        await caption('The Closer proposes the winner. Only the presenter can make the sale final (automated for this recording).', 6000)
        await sleep(4500)
      }
      await con.locator('#approveSale').click({ timeout: 5000 }).catch(() => admin('approve-sale'))
    } else if (s.closer_stalled) {
      await admin('force-sale')
    }
    await sleep(600)
  }
  await sleep(1500)
  await caption('Sold. The floor is revealed on the stats card, never before.', 4500)
  await sleep(9000)
  await page.screenshot({ path: outFile.replace(/\.webm$/, '-final.png') }).catch(() => {})
  const code = await Promise.race([botDone, sleep(25_000).then(() => 0)])

  const video = page.video()
  await ctx.close()
  const raw = await video?.path()
  await browser.close()
  mkdirSync(resolve(outFile, '..'), { recursive: true })
  if (raw && existsSync(raw)) renameSync(raw, outFile)
  log(`video: ${outFile}`)
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', outFile, '-c:v', 'libx264', '-crf', '27', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile.replace(/\.webm$/, '.mp4')])
    log(`mp4:   ${outFile.replace(/\.webm$/, '.mp4')}`)
  } catch {
    log('ffmpeg not found: the .webm is the deliverable (it plays in any browser)')
  }

  const final = await admin('state')
  const m = (final.turns.metrics as Array<{ outcome: string }>)
  console.log(`\nLister: ${usedRehearsal ? 'STALLED, used the saved rehearsal listing' : stub ? 'local stand-in (stub run)' : 'ZooWork agent researched the photo live'}`)
  console.log(`turns: ${m.filter((x) => x.outcome === 'recorded').length} answered by the agent, ${m.filter((x) => ['timeout', 'queue_timeout', 'no_reply'].includes(x.outcome)).length} template fallbacks, ${m.filter((x) => x.outcome === 'superseded').length} stale turns interrupted`)
  console.log('\n' + botOut.split('\n').filter((l) => /^(PASS|FAIL)|checks passed/.test(l)).join('\n'))
  cleanup()
  process.exit(code === 0 ? 0 : 1)
}

main().catch((e) => { console.error(`\nrecording failed: ${(e as Error).message}`); cleanup(); process.exit(1) })
