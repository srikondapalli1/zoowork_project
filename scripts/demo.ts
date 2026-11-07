// npm run demo [-- --stub] [-- --tunnel cloudflared|none] [-- --seconds 60] [-- --max-buyers 40] [-- --port 8787]
//
// One command for the room demo: starts a tunnel (cloudflared) and the relay with the right PUBLIC_BASE_URL, checks that the relay answers
// from outside, then prints the three URLs and a QR code you can scan right from the terminal to test on your own phone.
//   --stub          local stand-ins instead of ZooWork agents: free, ideal for a rehearsal on real phones
//   PUBLIC_BASE_URL set  use your own tunnel (ngrok, a reserved cloudflared domain) instead of starting one
// Live runs use your prepaid ZooWork balance: check Usage in ZooWork Platform afterwards.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { preflight, printChecks } from './lib/preflight.ts'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const stub = process.argv.includes('--stub')
const port = Number(arg('--port') ?? 8787)
const seconds = arg('--seconds') ?? '60'
const maxBuyers = arg('--max-buyers') ?? '40'
const tunnelMode = arg('--tunnel') ?? (process.env.PUBLIC_BASE_URL ? 'none' : 'cloudflared')
const adminToken = process.env.ADMIN_TOKEN || randomBytes(10).toString('hex')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const children: ChildProcess[] = []
const cleanup = (): void => { for (const c of children) if (!c.killed) c.kill('SIGTERM') }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(0) })
process.on('SIGTERM', () => { cleanup(); process.exit(0) })

async function main(): Promise<void> {
  let publicUrl = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')
  const needCloudflared = tunnelMode === 'cloudflared' && !publicUrl

  // 1. Before starting anything: the things that do not depend on the tunnel.
  const early = (await preflight({ stub, publicUrl: publicUrl || 'https://pending.invalid', checkReachable: false, needCloudflared })).filter((c) => c.name !== 'Public URL')
  printChecks(early)
  if (early.some((c) => c.level === 'fail')) {
    console.error('\nFix the problems above first. (Nothing was started.)')
    process.exit(1)
  }

  // 2. The tunnel, so the QR code can point at a real address.
  if (needCloudflared) {
    console.log('\nStarting a cloudflared tunnel…')
    const t = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(t)
    publicUrl = await new Promise<string>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('cloudflared did not print a tunnel URL within 40 seconds. Check your internet connection.')), 40_000)
      const on = (d: Buffer): void => {
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d))
        if (m) { clearTimeout(timer); res(m[0]) }
      }
      t.stdout.on('data', on); t.stderr.on('data', on)
      t.on('exit', (c) => rej(new Error(`cloudflared exited (${c}) before giving a URL`)))
    })
  } else if (!publicUrl) {
    publicUrl = `http://localhost:${port}`
    console.warn('\nNo tunnel: the QR code will only work on this machine. Pass --tunnel cloudflared, or set PUBLIC_BASE_URL to your own tunnel.')
  }

  // 3. The relay, told its public address.
  const relay = spawn(process.execPath, ['relay/index.ts'], {
    env: {
      ...process.env,
      ZOOWORK_MODE: stub ? 'stub' : 'live',
      PORT: String(port),
      ADMIN_TOKEN: adminToken,
      PUBLIC_BASE_URL: publicUrl,
      AUCTION_SECONDS: seconds,
      MAX_BUYERS: maxBuyers,
      DATA_DIR: mkdtempSync(join(tmpdir(), 'snapsell-demo-')),
      STUB_BROWSER: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(relay)
  relay.stdout.on('data', (d) => process.stdout.write(`[relay] ${d}`))
  relay.stderr.on('data', (d) => process.stderr.write(`[relay] ${d}`))
  relay.on('exit', (c) => { console.error(`\nThe relay exited (${c}).`); cleanup(); process.exit(1) })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${port}/api/state`)).ok) break } catch { /* not up yet */ }
    await sleep(500)
  }

  // 4. Does it answer from outside? A fresh tunnel can take a little while to be reachable.
  const relevant = /Public URL|tunnel|QR target|\/join/
  const failing = (cs: Awaited<ReturnType<typeof preflight>>): boolean => cs.some((c) => c.level === 'fail' && relevant.test(c.name))
  let late = await preflight({ stub: true, publicUrl, checkReachable: true, needCloudflared: false })
  for (let i = 0; i < 20 && failing(late); i++) {
    await sleep(3000)
    late = await preflight({ stub: true, publicUrl, checkReachable: true, needCloudflared: false })
  }
  console.log('')
  printChecks(late.filter((c) => relevant.test(c.name)))
  if (failing(late)) {
    // Do not present a QR code that the room cannot use. Keep checking until it works.
    console.log('\n*** NOT READY: phones cannot use this link yet. Fix the FAIL lines above. Still checking every 10 seconds… ***')
    for (;;) {
      await sleep(10_000)
      late = await preflight({ stub: true, publicUrl, checkReachable: true, needCloudflared: false })
      if (!failing(late)) break
    }
    console.log('\nNow reachable from outside.')
    printChecks(late.filter((c) => relevant.test(c.name)))
  }

  const joinUrl = `${publicUrl}/join`
  console.log(`
===================================================================
  Big screen (projector)   ${publicUrl}/screen
  Seller console (phone)   ${publicUrl}/admin?token=${adminToken}
  Room link / QR target    ${joinUrl}
  Mode: ${stub ? 'STUB (free local stand-ins)' : 'LIVE on ZooWork Managed Agents'}   auction ${seconds}s   room cap ${maxBuyers}
===================================================================
Scan this with your own phone to test the room link:
`)
  console.log(await QRCode.toString(joinUrl, { type: 'utf8' }))
  console.log('Keep the seller console URL private (it is the admin key). Press Ctrl+C to stop everything.')
  await new Promise(() => {})
}

main().catch((e) => { console.error(`\nCould not start the demo: ${(e as Error).message}`); cleanup(); process.exit(1) })
