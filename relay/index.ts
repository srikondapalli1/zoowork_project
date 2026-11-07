// Snap & Sell relay: node relay/index.ts
//   ZOOWORK_MODE=stub  (default) runs the three agents as local code: free, for tests and rehearsal.
//   ZOOWORK_MODE=live  runs them on ZooWork Managed Agents (needs agents/ids.json and ZOOWORK_API_KEY).
import { config } from './config.ts'
import { LiveIO } from './live.ts'
import { Relay } from './relay.ts'
import { StubIO } from './stub.ts'
import { createWebServer } from './web.ts'

const relay = new Relay()
if (config.mode === 'live') {
  const io = new LiveIO(relay)
  await io.init()
  relay.io = io
} else {
  relay.io = new StubIO(relay)
}

if (await relay.restore()) console.log('Restored state from data/state.json')
relay.startSnapshots()

const server = createWebServer(relay)
server.listen(config.port, () => {
  const base = config.publicBaseUrl
  console.log(`Snap & Sell relay (${config.mode} mode) on port ${config.port}`)
  console.log(`  Big screen : ${base}/screen`)
  console.log(`  Seller     : ${base}/admin?token=${config.adminToken}${config.adminTokenGenerated ? '   (ADMIN_TOKEN was not set: generated for this run)' : ''}`)
  if (config.mode === 'stub') console.log('  Agents are local stubs (no ZooWork calls). Set ZOOWORK_MODE=live to use ZooWork Managed Agents.')
  if (!config.zoodataApiKey) console.log('  ZOODATA_API_KEY not set: the Lister will fall back to web_search for retail prices.')
})

const shutdown = async (): Promise<void> => {
  server.close()
  await relay.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
