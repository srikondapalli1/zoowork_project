// Integration tests for turn concurrency, the 8-second fallback, snapshots and the sale flow.
// A controllable fake replaces the agents, so no ZooWork calls are made.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.TURN_DEADLINE_MS = '300'
process.env.GLOBAL_TURN_CAP = '2'
process.env.TIME_SCALE = '100' // rate limit 30 ms
process.env.AUCTION_SECONDS = '60'
process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'snapsell-'))

const { Relay } = await import('../relay/relay.ts')
const { handleTool } = await import('../relay/tools.ts')
type Buyer = import('../relay/engine.ts').Buyer
type NegotiatorEvent = import('../relay/turns.ts').NegotiatorEvent

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class FakeIO {
  posts: Array<{ buyer: string; ev: NegotiatorEvent }> = []
  interrupts: string[] = []
  closers = 0
  async startLister() {}
  async startNegotiator(b: Buyer) {
    b.session_id = `s_${b.id}`
  }
  async postNegotiator(b: Buyer, ev: NegotiatorEvent) {
    this.posts.push({ buyer: b.id, ev })
  }
  async interruptNegotiator(b: Buyer) {
    this.interrupts.push(b.id)
  }
  async startCloser() {
    this.closers += 1
  }
  async postCloser() {}
  async resolveApproval() {}
  async stop() {}
}

async function liveRelay() {
  const relay = new Relay()
  const io = new FakeIO()
  relay.io = io as never
  await relay.loadRehearsal()
  assert.equal(relay.open(), undefined)
  return { relay, io }
}

const join_ = async (relay: InstanceType<typeof Relay>): Promise<Buyer> => {
  const r = await relay.joinBuyer(undefined)
  assert.ok('buyer' in r)
  return r.buyer
}

test('a turn that misses the deadline gets the template fallback, and the late reply is dropped', async () => {
  const { relay, io } = await liveRelay()
  const b = await join_(relay)
  relay.turns.enqueue(b.id, { event: 'join' })
  relay.turns.finish(b.id)
  assert.equal(relay.submit(b, 70, 'offer').kind, 'accepted')
  await sleep(20)
  assert.equal(io.posts.at(-1)?.ev.event, 'offer')
  await sleep(400) // past the 300 ms deadline
  assert.equal(b.reply?.kind, 'template')
  assert.match(b.reply?.line ?? '', /Can't go that low|You're leading/)
  assert.deepEqual(io.interrupts, [b.id])
  const late = await handleTool(relay, 'negotiator', { buyerId: b.id }, 'record_counter', { label: 'countered', amount: 99, line: 'Late line.' })
  assert.equal((late.value as { ok: boolean }).ok, false)
  assert.equal(b.rounds_used, 0) // the dropped reply did not use a round
  relay.turns.finish(b.id)
  await relay.stop()
})

test('a submit during a running turn replaces the queued event: the latest offer counts', async () => {
  const { relay, io } = await liveRelay()
  const b = await join_(relay)
  relay.submit(b, 70, 'offer')
  await sleep(20)
  assert.equal(io.posts.length, 1)
  await sleep(40)
  relay.submit(b, 75, 'offer')
  await sleep(40)
  relay.submit(b, 80, 'offer')
  await sleep(10)
  assert.equal(io.posts.length, 1, 'nothing new is posted while a turn is in flight')
  const ok = await handleTool(relay, 'negotiator', { buyerId: b.id }, 'get_state', {})
  assert.ok(!ok.isError)
  relay.turns.onRecorded(b.id)
  relay.turns.finish(b.id)
  await sleep(10)
  assert.equal(io.posts.length, 2)
  assert.deepEqual(io.posts[1]?.ev, { event: 'offer', amount: 80, intent: 'offer' })
  relay.turns.onRecorded(b.id)
  relay.turns.finish(b.id)
  await relay.stop()
})

test('an offer waiting behind a running turn still gets a reply within the deadline (template, then the agent replaces it)', async () => {
  const { relay, io } = await liveRelay()
  const b = await join_(relay)
  relay.submit(b, 70, 'offer')
  await sleep(20)
  relay.turns.onRecorded(b.id) // turn 1 is answered but its run has not finished yet
  await sleep(50)
  relay.submit(b, 80, 'offer') // waits behind the running turn
  assert.equal(io.posts.length, 1)
  await sleep(380) // past the 300 ms deadline, counted from the second submit
  assert.equal(b.reply?.kind, 'template', 'the waiting offer already has a template reply')
  assert.ok(relay.turns.metrics.some((m) => m.outcome === 'queue_timeout'))
  relay.turns.finish(b.id)
  await sleep(10)
  assert.deepEqual(io.posts[1]?.ev, { event: 'offer', amount: 80, intent: 'offer' }, 'the agent still gets to answer the queued offer')
  relay.turns.onRecorded(b.id)
  relay.turns.finish(b.id)
  await relay.stop()
})

test('a newer offer interrupts a turn that has not answered; the deadline counts from the submit', async () => {
  const { relay, io } = await liveRelay()
  const b = await join_(relay)
  relay.submit(b, 70, 'offer')
  await sleep(20)
  assert.equal(io.posts.length, 1)
  await sleep(60)
  relay.submit(b, 80, 'offer')
  assert.deepEqual(io.interrupts, [b.id], 'the unanswered turn is interrupted')
  assert.ok(relay.turns.metrics.some((m) => m.outcome === 'superseded'))
  // the interrupted turn can no longer record a reply
  const stale = await handleTool(relay, 'negotiator', { buyerId: b.id }, 'record_counter', { label: 'countered', amount: 99, line: 'Old news.' })
  assert.equal((stale.value as { ok: boolean }).ok, false)
  await sleep(150) // the interrupt takes a while to land, so the new turn starts late
  relay.turns.finish(b.id) // run.finished(aborted)
  await sleep(10)
  assert.deepEqual(io.posts[1]?.ev, { event: 'offer', amount: 80, intent: 'offer' })
  // The 300 ms promise counts from the second submit (about 170 ms ago), not from this turn's start:
  await sleep(60) // ~240 ms after the submit
  const replyOf = (): Buyer['reply'] => b.reply
  assert.equal(replyOf(), undefined, 'not yet')
  await sleep(110) // ~350 ms after the submit; a clock started at the turn start would not have fired yet (~530 ms)
  assert.equal(replyOf()?.kind, 'template')
  assert.ok(relay.turns.metrics.some((m) => m.outcome === 'timeout'))
  relay.turns.finish(b.id)
  await relay.stop()
})

test('the global cap holds turns in a FIFO queue', async () => {
  const { relay, io } = await liveRelay()
  const buyers = [await join_(relay), await join_(relay), await join_(relay)]
  for (const [i, b] of buyers.entries()) relay.submit(b, 70 + i, 'offer')
  await sleep(20)
  assert.equal(io.posts.length, 2, 'cap of 2 turns in flight')
  assert.equal(relay.turns.queueDepth, 1)
  const first = buyers[0] as Buyer
  relay.turns.onRecorded(first.id)
  relay.turns.finish(first.id)
  await sleep(10)
  assert.equal(io.posts.length, 3)
  assert.equal(io.posts[2]?.buyer, (buyers[2] as Buyer).id, 'the waiting buyer goes next')
  for (const b of buyers) {
    relay.turns.onRecorded(b.id)
    relay.turns.finish(b.id)
  }
  await relay.stop()
})

test('a failed reply check returns the reason once; the retry failing too sends the template', async () => {
  const { relay } = await liveRelay()
  const b = await join_(relay)
  relay.submit(b, 70, 'offer')
  await sleep(20)
  const bad = { label: 'countered', amount: 80, line: 'Another buyer offered $150 so beat that.' }
  const first = (await handleTool(relay, 'negotiator', { buyerId: b.id }, 'record_counter', bad)).value as { ok: boolean; reason?: string }
  assert.equal(first.ok, false)
  assert.match(first.reason ?? '', /not one the relay supplied/)
  const second = (await handleTool(relay, 'negotiator', { buyerId: b.id }, 'record_counter', bad)).value as { ok: boolean; replaced?: boolean }
  assert.equal(second.ok, true)
  assert.equal(second.replaced, true)
  assert.equal(b.reply?.kind, 'template')
  assert.doesNotMatch(b.reply?.line ?? '', /150/)
  relay.turns.finish(b.id)
  await relay.stop()
})

test('a counter below suggested_counter is rejected with min_allowed', async () => {
  const { relay } = await liveRelay()
  const b = await join_(relay)
  relay.submit(b, 70, 'offer')
  await sleep(20)
  const r = (await handleTool(relay, 'negotiator', { buyerId: b.id }, 'record_counter', { label: 'countered', amount: 56, line: 'How about 56?' })).value as {
    ok: boolean
    min_allowed?: number
  }
  assert.equal(r.ok, false)
  assert.ok((r.min_allowed ?? 0) > 56)
  relay.turns.finish(b.id)
  await relay.stop()
})

test('only the top valid offer can be proposed, and the sale needs the presenter', async () => {
  const { relay, io } = await liveRelay()
  const a = await join_(relay)
  const b = await join_(relay)
  relay.submit(a, 70, 'offer')
  relay.submit(b, 80, 'offer')
  await relay.close()
  assert.equal(io.closers, 1)
  assert.equal(relay.engine.listing?.status, 'closing')
  const wrong = (await handleTool(relay, 'closer', {}, 'propose_sale', { buyer_id: a.id, amount: 70, reason: 'x' })).value as { ok: boolean }
  assert.equal(wrong.ok, false)
  const right = (await handleTool(relay, 'closer', {}, 'propose_sale', { buyer_id: b.id, amount: 80, reason: 'Top offer.' })).value as { ok: boolean }
  assert.equal(right.ok, true)

  let settled = false
  const sale = handleTool(relay, 'closer', {}, 'confirm_sale', { buyer_id: b.id, amount: 80 }).then((r) => {
    settled = true
    return r
  })
  await sleep(50)
  assert.equal(settled, false, 'confirm_sale waits for the presenter')
  assert.equal(relay.engine.state.approvals.length, 1)
  assert.equal(await relay.decide('sale', 'allow-once'), true)
  const done = await sale
  assert.ok(!done.isError)
  assert.equal(relay.engine.listing?.status, 'sold')
  assert.equal(relay.engine.state.sold_amount, 80)
  assert.equal(relay.engine.buyerById(b.id)?.status, 'winner')
  assert.equal(relay.engine.buyerById(a.id)?.status, 'runner_up')
  const stats = relay.engine.computeStats() as { final_price: number; floor: number }
  assert.equal(stats.final_price, 80)
  await relay.stop()
})

test('a declined sale does not sell', async () => {
  const { relay } = await liveRelay()
  const a = await join_(relay)
  relay.submit(a, 80, 'offer')
  await relay.close()
  await handleTool(relay, 'closer', {}, 'propose_sale', { buyer_id: a.id, amount: 80, reason: 'Top offer.' })
  const sale = handleTool(relay, 'closer', {}, 'confirm_sale', { buyer_id: a.id, amount: 80 })
  await sleep(20)
  await relay.decide('sale', 'deny')
  const r = await sale
  assert.equal(r.isError, true)
  assert.equal(relay.engine.listing?.status, 'closing')
  await relay.stop()
})

test('state survives a restart: snapshot then restore', async () => {
  const { relay } = await liveRelay()
  const b = await join_(relay)
  relay.submit(b, 70, 'offer')
  await relay.snapshot()
  const again = new Relay()
  again.io = new FakeIO() as never
  assert.equal(await again.restore(), true)
  assert.equal(again.engine.listing?.id, relay.engine.listing?.id)
  assert.equal(again.engine.state.buyers[0]?.handle, 'Buyer 1')
  assert.equal(again.engine.state.offers.length, 1)
  await relay.stop()
  await again.stop()
})
