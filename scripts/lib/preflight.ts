// Pre-demo checks. Everything that has gone wrong on stage before: a QR code pointing at localhost, a tunnel that is not
// reachable from outside, agents that are stopped, a missing key. Read-only: nothing here creates or starts anything.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createZooworkClient } from '@zoowork-ai/sdk'
import { publicUrlProblem } from '../../relay/config.ts'

export interface Check {
  level: 'pass' | 'warn' | 'fail'
  name: string
  detail?: string
}

export interface PreflightOptions {
  /** Stub mode uses local stand-ins: no ZooWork key, agents or cost. */
  stub: boolean
  /** The address phones will use (the tunnel). */
  publicUrl?: string | undefined
  /** Also call the running relay through that address (needs the relay and tunnel to be up). */
  checkReachable: boolean
  /** Check that cloudflared is installed (when the demo will start the tunnel itself). */
  needCloudflared: boolean
}

const pass = (name: string, detail?: string): Check => ({ level: 'pass', name, ...(detail ? { detail } : {}) })
const warn = (name: string, detail: string): Check => ({ level: 'warn', name, detail })
const fail = (name: string, detail: string): Check => ({ level: 'fail', name, detail })

async function getJson(url: string): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' })
  const json = await r.json().catch(() => undefined)
  return { status: r.status, json }
}

export async function preflight(o: PreflightOptions): Promise<Check[]> {
  const out: Check[] = []

  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number]
  out.push(major > 22 || (major === 22 && minor >= 20) ? pass('Node version', process.versions.node) : fail('Node version', `${process.versions.node}: Node 22.20 or newer is required`))

  if (!o.stub) {
    if (!process.env.ZOOWORK_API_KEY) {
      out.push(fail('ZOOWORK_API_KEY', 'not set in this terminal. Set it yourself; never paste it into a chat.'))
    } else {
      out.push(pass('ZOOWORK_API_KEY', 'set'))
      try {
        const client = createZooworkClient()
        await client.listModels()
        out.push(pass('ZooWork API', 'key accepted'))
        if (!existsSync('agents/ids.json')) {
          out.push(fail('Agents', 'agents/ids.json not found. Run: npm run create-agents -- --only lister,negotiator,closer'))
        } else {
          const ids = JSON.parse(readFileSync('agents/ids.json', 'utf8')) as Record<string, string>
          for (const role of ['lister', 'negotiator', 'closer'] as const) {
            if (!ids[role]) { out.push(fail(`Agent: ${role}`, 'missing from agents/ids.json')); continue }
            try {
              const a = await client.getAgent(ids[role] as string)
              out.push(a.status?.desired_state === 'running' ? pass(`Agent: ${role}`, 'running') : fail(`Agent: ${role}`, `${a.status?.desired_state ?? 'unknown state'}. Run: npm run create-agents -- --only lister,negotiator,closer`))
            } catch (e) {
              out.push(fail(`Agent: ${role}`, `could not read it (${(e as Error).message})`))
            }
          }
        }
      } catch (e) {
        out.push(fail('ZooWork API', `${(e as Error).message}. Check the key and your balance in ZooWork Platform.`))
      }
    }
    out.push(process.env.ZOODATA_API_KEY ? pass('ZooData key', 'set') : warn('ZooData key', 'not set: the Lister will use web search for retail prices'))
  }

  out.push(process.env.ADMIN_TOKEN ? pass('ADMIN_TOKEN', 'set') : warn('ADMIN_TOKEN', 'not set: a random one is generated each run, so the seller console URL changes'))

  if (o.needCloudflared) {
    try {
      execFileSync('cloudflared', ['--version'], { stdio: 'ignore' })
      out.push(pass('cloudflared', 'installed'))
    } catch {
      out.push(fail('cloudflared', 'not installed. macOS: brew install cloudflared. Windows: winget install Cloudflare.cloudflared. Or run your own tunnel and set PUBLIC_BASE_URL.'))
    }
  }

  if (!o.publicUrl) {
    out.push(fail('Public URL', 'none yet: the demo launcher fills this in from the tunnel; with your own tunnel set PUBLIC_BASE_URL'))
  } else {
    const problem = publicUrlProblem(o.publicUrl)
    out.push(problem ? (problem.level === 'fail' ? fail('Public URL', problem.message) : warn('Public URL', problem.message)) : pass('Public URL', o.publicUrl))
  }

  if (o.checkReachable && o.publicUrl) {
    try {
      const st = await getJson(`${o.publicUrl}/api/state`)
      if (st.status !== 200 || !st.json || typeof st.json.phase !== 'string') {
        out.push(fail('Relay through the tunnel', `${o.publicUrl}/api/state answered ${st.status} without the relay's state. Is the tunnel pointing at the relay's port?`))
      } else {
        out.push(pass('Relay through the tunnel', 'answers from outside'))
        out.push(st.json.join_url === `${o.publicUrl}/join` ? pass('QR target', st.json.join_url) : fail('QR target', `the relay says ${st.json.join_url}, not ${o.publicUrl}/join. Restart the relay with PUBLIC_BASE_URL=${o.publicUrl}`))
      }
      const j = await fetch(`${o.publicUrl}/join`, { signal: AbortSignal.timeout(8000) })
      out.push(j.ok ? pass('Room link /join', 'opens') : fail('Room link /join', `answered ${j.status}`))
    } catch (e) {
      out.push(fail('Relay through the tunnel', `could not reach ${o.publicUrl} (${(e as Error).message}). The tunnel may still be starting, or it points at the wrong port.`))
    }
  }
  return out
}

export function printChecks(checks: Check[]): void {
  const tag = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const
  for (const c of checks) console.log(`${tag[c.level]}  ${c.name}${c.detail ? '  ' + c.detail : ''}`)
}
