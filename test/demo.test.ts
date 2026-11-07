// The room demo plumbing: the stable /join link, the QR target, public-URL warnings and the preflight checks. No ZooWork calls.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const PUBLIC = 'https://demo-room.trycloudflare.com'
process.env.PUBLIC_BASE_URL = PUBLIC
process.env.ADMIN_TOKEN = 'test-admin-token'
process.env.AUCTION_SECONDS = '60'
process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'snapsell-demo-'))

const { publicUrlProblem } = await import('../relay/config.ts')
const { Relay } = await import('../relay/relay.ts')
const { createWebServer } = await import('../relay/web.ts')
const { preflight } = await import('../scripts/lib/preflight.ts')

class FakeIO {
  async startLister() {}
  async startNegotiator() {}
  async postNegotiator() {}
  async interruptNegotiator() {}
  async startCloser() {}
  async postCloser() {}
  async resolveApproval() {}
  async stop() {}
}

const relay = new Relay()
relay.io = new FakeIO() as never
const server = createWebServer(relay)
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
after(() => { server.close(); void relay.stop() })

test('public URL check: private addresses fail, plain http warns, an https tunnel passes', () => {
  for (const u of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://192.168.1.20:8787', 'http://10.0.0.5', 'http://172.20.1.1', 'http://macbook.local:8787', 'http://[::1]:8787', 'not a url']) {
    assert.equal(publicUrlProblem(u)?.level, 'fail', u)
  }
  assert.equal(publicUrlProblem('http://example.com')?.level, 'warn')
  assert.equal(publicUrlProblem('https://abc-def.trycloudflare.com'), undefined)
  assert.equal(publicUrlProblem('https://172.32.0.1'), undefined, '172.32 is public, only 172.16 to 172.31 is private')
})

test('/join is a stable page that waits for a listing and forwards the room to it', async () => {
  const res = await fetch(`${local}/join`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /Waiting for the seller to list an item/)
  assert.match(html, /location\.replace\('\/l\/'/, 'it forwards to the current listing')
  assert.match(html, /location\.replace\('\/market'\)/, 'and to the marketplace when that channel is on')
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/)
})

test('the state advertises the room link and the QR points at /join, not at one listing', async () => {
  const idle = (await (await fetch(`${local}/api/state`)).json()) as { phase: string; join_url: string; url_warning: string | null }
  assert.equal(idle.phase, 'idle')
  assert.equal(idle.join_url, `${PUBLIC}/join`)
  assert.equal(idle.url_warning, null)

  await relay.loadRehearsal()
  assert.equal(relay.open(), undefined)
  const live = (await (await fetch(`${local}/api/state`)).json()) as { qr_url: string; join_url: string; listing: { id: string } }
  assert.equal(live.qr_url, `${PUBLIC}/join`, 'the QR code never changes between listings')
  assert.ok(!live.qr_url.includes(live.listing.id))

  const qr = await fetch(`${local}/api/qr.svg`)
  assert.equal(qr.status, 200)
  assert.match(qr.headers.get('content-type') ?? '', /svg/)
  assert.match(await qr.text(), /<svg/)
})

test('the admin state carries the room link and warns when the public URL cannot work', async () => {
  const r = await fetch(`${local}/api/admin/state`, { headers: { 'x-admin-token': 'test-admin-token' } })
  const s = (await r.json()) as { join_url: string; warnings: string[] }
  assert.equal(s.join_url, `${PUBLIC}/join`)
  assert.deepEqual(s.warnings, [], 'a good https URL produces no warning')
})

test('preflight (stub): a localhost QR target is a failure, an https tunnel passes', async () => {
  const bad = await preflight({ stub: true, publicUrl: 'http://localhost:8787', checkReachable: false, needCloudflared: false })
  assert.ok(bad.some((c) => c.name === 'Public URL' && c.level === 'fail'))
  const good = await preflight({ stub: true, publicUrl: PUBLIC, checkReachable: false, needCloudflared: false })
  assert.ok(!good.some((c) => c.level === 'fail'), JSON.stringify(good.filter((c) => c.level === 'fail')))
  assert.ok(good.some((c) => c.name === 'Node version' && c.level === 'pass'))
})

test('preflight: reaches the relay, and catches a relay started with a different PUBLIC_BASE_URL', async () => {
  // The relay believes it is at PUBLIC; here we ask it through the local address, so the QR target must be reported as wrong.
  const checks = await preflight({ stub: true, publicUrl: local, checkReachable: true, needCloudflared: false })
  assert.ok(checks.some((c) => c.name === 'Relay through the tunnel' && c.level === 'pass'))
  const qr = checks.find((c) => c.name === 'QR target')
  assert.equal(qr?.level, 'fail')
  assert.match(qr?.detail ?? '', /Restart the relay with PUBLIC_BASE_URL/)
})

test('preflight: a tunnel that does not answer is reported, not hidden', async () => {
  const checks = await preflight({ stub: true, publicUrl: 'http://127.0.0.1:1', checkReachable: true, needCloudflared: false })
  const c = checks.find((x) => x.name === 'Relay through the tunnel')
  assert.equal(c?.level, 'fail')
  assert.match(c?.detail ?? '', /could not reach/)
})
