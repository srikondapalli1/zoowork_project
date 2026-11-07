// The real thing: the Lister, Negotiator and Closer run on ZooWork Managed Agents.
// The relay holds one event stream per session, runs custom tools here, and resolves them back to ZooWork.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ZooworkError,
  assistantText,
  createZooworkClient,
  customToolUse,
  isRunFinished,
  runOutcome,
  toolCall,
  type SessionEvent,
  type ZooworkClient,
} from '@zoowork-ai/sdk'
import { config } from './config.ts'
import type { Buyer, Listing } from './engine.ts'
import type { AgentIO, CloserEvent, Relay } from './relay.ts'
import type { NegotiatorEvent } from './turns.ts'
import { handleTool, type Role } from './tools.ts'

export interface AgentIds {
  lister: string
  negotiator: string
  closer: string
  /** The marketplace browser agent; only needed when the marketplace channel is used. */
  responder?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** One line for the big screen: tool name plus a short, sanitized hint of its arguments. */
function summarize(toolName: string, args: Record<string, unknown> | undefined): string {
  const hint = args && (args.query ?? args.keyword ?? args.url ?? args.path ?? args.command)
  const text = typeof hint === 'string' ? hint : Array.isArray(hint) ? hint.join(' ') : ''
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 90)
  return clean ? `${toolName}: ${clean}` : toolName
}

export class LiveIO implements AgentIO {
  private relay: Relay
  private client: ZooworkClient
  private ids!: AgentIds
  private pumps = new Map<string, AbortController>()
  private negotiatorReady = new Map<string, Promise<string>>()
  private handledCalls = new Set<string>()
  private approvalAgent = new Map<string, string>()
  private closerText = ''
  private marketReady: Promise<void> | undefined

  constructor(relay: Relay) {
    this.relay = relay
    this.client = createZooworkClient()
  }

  async init(): Promise<void> {
    try {
      this.ids = JSON.parse(await readFile(join(config.agentsDir, 'ids.json'), 'utf8')) as AgentIds
    } catch {
      throw new Error('agents/ids.json not found. Run `npm run create-agents` first (it creates and starts the three agents).')
    }
  }

  // ---------- streams ----------

  private startPump(role: Role, agentId: string, sessionId: string, buyerId?: string): void {
    this.pumps.get(sessionId)?.abort()
    const ctl = new AbortController()
    this.pumps.set(sessionId, ctl)
    const engine = this.relay.engine
    void (async () => {
      let attempt = 0
      while (!ctl.signal.aborted) {
        try {
          for await (const ev of this.client.streamEvents(agentId, sessionId, {
            ...(engine.state.cursors[sessionId] ? { cursor: engine.state.cursors[sessionId] as string } : {}),
            signal: ctl.signal,
          })) {
            attempt = 0
            await this.onEvent(role, agentId, sessionId, buyerId, ev)
            if (ev.cursor) engine.state.cursors[sessionId] = ev.cursor
          }
        } catch (e) {
          if (ctl.signal.aborted) break
          if (e instanceof ZooworkError && e.status >= 400 && e.status < 500) {
            console.error(`[live] ${role} stream ${sessionId} stopped: ${e.status} ${e.type ?? ''}`)
            break
          }
        }
        await sleep(Math.min(1000 * 2 ** attempt++, 15_000))
      }
    })()
  }

  private async onEvent(role: Role, agentId: string, sessionId: string, buyerId: string | undefined, ev: SessionEvent): Promise<void> {
    const relay = this.relay

    const call = customToolUse(ev)
    if (call?.phase === 'requested' && call.name) {
      if (!this.handledCalls.has(call.callId)) {
        this.handledCalls.add(call.callId)
        void this.runTool(role, agentId, buyerId, call.callId, call.name, call.input)
      }
      return
    }

    if (ev.eventType === 'agent.approval') {
      const p = ev.payload as { phase?: string; approvalId?: string; toolName?: string; arguments?: unknown }
      if (p.phase === 'requested' && p.approvalId) {
        this.approvalAgent.set(p.approvalId, agentId)
        const args = p.arguments && typeof p.arguments === 'object' ? (p.arguments as Record<string, unknown>) : {}
        relay.onPlatformApproval({ approvalId: p.approvalId, toolName: String(p.toolName ?? ''), args })
      } else if (p.phase === 'resolved' && p.approvalId) {
        relay.dropApproval(p.approvalId)
      }
      return
    }

    if (role === 'lister') {
      const t = toolCall(ev)
      if (t?.phase === 'start') relay.engine.listerLog(summarize(t.toolName, t.args), Date.now())
    }
    if (role === 'closer') {
      const text = assistantText(ev)
      if (text) this.closerText = text // the last assistant message of the run is the one-line summary
    }

    if (isRunFinished(ev)) {
      const outcome = runOutcome(ev)
      if (role === 'negotiator' && buyerId) relay.turns.finish(buyerId)
      else if (role === 'closer') {
        relay.onCloserFinished(outcome === 'succeeded' ? this.closerText.trim() : undefined)
        this.closerText = ''
      } else if (role === 'lister') {
        relay.engine.listerLog(`Lister run ${outcome ?? 'ended'}.`, Date.now())
      }
    }
  }

  private async runTool(role: Role, agentId: string, buyerId: string | undefined, callId: string, name: string, input: unknown): Promise<void> {
    let result: { value: unknown; isError?: boolean }
    try {
      result = await handleTool(this.relay, role, { buyerId }, name, input ?? {})
    } catch (e) {
      result = { value: { error: `Tool failed: ${(e as Error).message}` }, isError: true }
    }
    try {
      await this.client.resolveCustomToolCall(agentId, callId, {
        content: [{ type: 'json', value: result.value }],
        isError: result.isError === true,
        resolvedBy: 'relay',
      })
    } catch (e) {
      console.error(`[live] could not resolve ${name} (${callId}):`, (e as Error).message)
    }
  }

  // ---------- AgentIO ----------

  async startLister(listing: Listing, photo: Buffer, description: string): Promise<void> {
    const engine = this.relay.engine
    const session = await this.client.createSession(this.ids.lister, { metadata: { listing_id: listing.id } }, `lister-${listing.id}`)
    engine.state.lister_session_id = session.session_id
    this.startPump('lister', this.ids.lister, session.session_id)
    engine.listerLog('Uploading the photo to the Lister.', Date.now())
    const path = `listings/${listing.id}/photo.jpg`
    await this.client.uploadFile(this.ids.lister, path, photo)
    const receipt = await this.client.postEvents(this.ids.lister, session.session_id, [
      {
        type: 'user.message',
        content:
          `Seller description (trusted; this is exactly what the item is): ${JSON.stringify(description)}\n` +
          `The photo is at /workspace/${path}. Open it with the image tool to confirm color and visible condition.\n` +
          'Follow your instructions, then call publish_listing once.',
        idempotency_key: `lister-${listing.id}`,
      },
    ])
    if (receipt.events[0]?.accepted !== true) throw new Error('The Lister did not accept the message.')
  }

  /** The agent that talks to this buyer: the Responder (browser) for marketplace DMs, the Negotiator for the QR page. */
  private agentFor(buyer: Buyer): string {
    if (buyer.channel === 'market') {
      if (!this.ids.responder) throw new Error('agents/ids.json has no responder. Run `npm run create-agents` to create it.')
      return this.ids.responder
    }
    return this.ids.negotiator
  }

  async startNegotiator(buyer: Buyer): Promise<void> {
    const market = buyer.channel === 'market'
    const agentId = this.agentFor(buyer)
    const ready = (async () => {
      const session = await this.client.createSession(agentId, { metadata: { buyer_id: buyer.id } }, `${market ? 'resp' : 'neg'}-${buyer.id}`)
      buyer.session_id = session.session_id
      this.startPump(market ? 'responder' : 'negotiator', agentId, session.session_id, buyer.id)
      return session.session_id
    })()
    this.negotiatorReady.set(buyer.id, ready)
    await ready
    if (!market) this.relay.turns.enqueue(buyer.id, { event: 'join' }) // marketplace buyers have no join turn: their first DM wakes the Responder
  }

  /**
   * Put the browser helper and its settings into the Responder's sandbox and start Chromium, so the first DM
   * does not pay a cold start. The sandbox reaches the marketplace through PUBLIC_BASE_URL.
   */
  prepareMarket(): Promise<void> {
    this.marketReady ??= (async () => {
      const agentId = this.ids.responder
      if (!agentId) throw new Error('no responder agent: run `npm run create-agents`')
      const feed = this.relay.feed
      if (/localhost|127\.0\.0\.1/.test(config.publicBaseUrl)) {
        feed.push(undefined, 'PUBLIC_BASE_URL is localhost: the ZooWork sandbox cannot reach it. Start a tunnel and set PUBLIC_BASE_URL.', Date.now())
      }
      feed.push(undefined, 'Preparing the agent\'s browser in its sandbox', Date.now())
      await this.client.uploadFile(agentId, 'market/b.cjs', await readFile(join(config.agentsDir, 'market', 'b.cjs'), 'utf8'))
      await this.client.uploadFile(agentId, 'market/config.json', JSON.stringify({ base: config.publicBaseUrl, key: config.marketKey }))
      const r = await this.client.exec(agentId, ['node', 'market/b.cjs', 'inbox'])
      feed.push(undefined, r.exit_code === 0 ? 'The agent\'s browser is ready' : `Browser warm-up exited ${r.exit_code}: ${r.stderr.slice(0, 120) || r.stdout.slice(0, 120)}`, Date.now())
    })().catch((e: unknown) => {
      this.marketReady = undefined // let the next attempt retry
      throw e
    })
    return this.marketReady
  }

  async postNegotiator(buyer: Buyer, ev: NegotiatorEvent, _seq: number): Promise<void> {
    const sessionId = await (this.negotiatorReady.get(buyer.id) ?? Promise.resolve(buyer.session_id))
    if (!sessionId) throw new Error('No Negotiator session for this buyer.')
    const receipt = await this.client.postEvents(this.agentFor(buyer), sessionId, [
      { type: 'user.message', content: JSON.stringify(ev), idempotency_key: randomUUID() },
    ])
    if (receipt.events[0]?.accepted !== true) throw new Error('The agent did not accept the event.')
  }

  async interruptNegotiator(buyer: Buyer): Promise<void> {
    if (!buyer.session_id) return
    await this.client.postEvents(this.agentFor(buyer), buyer.session_id, [{ type: 'user.interrupt' }])
  }

  async startCloser(listing: Listing): Promise<void> {
    const engine = this.relay.engine
    const session = await this.client.createSession(this.ids.closer, { metadata: { listing_id: listing.id } }, `closer-${listing.id}`)
    engine.state.closer_session_id = session.session_id
    this.startPump('closer', this.ids.closer, session.session_id)
    await this.postCloser({ event: 'close' })
  }

  async postCloser(ev: CloserEvent): Promise<void> {
    const sessionId = this.relay.engine.state.closer_session_id
    if (!sessionId) throw new Error('No Closer session.')
    const receipt = await this.client.postEvents(this.ids.closer, sessionId, [
      { type: 'user.message', content: JSON.stringify(ev), idempotency_key: randomUUID() },
    ])
    if (receipt.events[0]?.accepted !== true) throw new Error('The Closer did not accept the event.')
  }

  async resolveApproval(approvalId: string, decision: 'allow-once' | 'deny'): Promise<void> {
    const agentId = this.approvalAgent.get(approvalId)
    if (!agentId) throw new Error('Unknown approval.')
    await this.client.resolveApproval(agentId, approvalId, { decision, resolvedBy: 'presenter' })
  }

  async stop(): Promise<void> {
    for (const c of this.pumps.values()) c.abort()
    this.pumps.clear()
    this.negotiatorReady.clear()
    this.handledCalls.clear()
    this.marketReady = undefined
  }
}
