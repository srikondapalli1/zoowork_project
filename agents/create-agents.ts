// Creates (or updates) the three Snap & Sell agents on ZooWork Managed Agents and starts them.
//
//   node agents/create-agents.ts --dry-run   print the configs and check the model aliases (read-only, free)
//   node agents/create-agents.ts             create or update the agents, start them, write agents/ids.json
//
// Creating and starting agents uses the organization's prepaid balance. Check Usage in ZooWork Platform.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZooworkClient, type AgentResource, type CustomToolDeclaration, type ThinkingLevel } from '@zoowork-ai/sdk'

const here = dirname(fileURLToPath(import.meta.url))
const dryRun = process.argv.includes('--dry-run')

// Models were picked from the live catalog (client.listModels()); override with env vars if one is retired.
const MODELS = {
  lister: process.env.LISTER_MODEL ?? 'litellm/claude-opus-5-5', // strong vision model
  negotiator: process.env.NEGOTIATOR_MODEL ?? 'litellm/claude-haiku-5-5', // fast, cheap
  closer: process.env.CLOSER_MODEL ?? 'litellm/claude-sonnet-5-5', // mid
  responder: process.env.RESPONDER_MODEL ?? 'litellm/claude-sonnet-5-5', // marketplace: multi-step browser work
} as const

const THINKING: Record<keyof typeof MODELS, ThinkingLevel> = { lister: 'low', negotiator: 'off', closer: 'low', responder: 'low' }

// Built-in tools the Negotiator and Closer never need. They only call the relay's custom tools.
const NO_BUILTINS = ['read', 'write', 'edit', 'apply_patch', 'exec', 'process', 'web_fetch', 'web_search', 'web_image_search', 'image', 'pdf', 'artifact_publish', 'agent_db', 'cron', 'message']

const emptyObject = { type: 'object', additionalProperties: false, properties: {} } as const

const tools: Record<string, CustomToolDeclaration> = {
  zoodata_search: {
    name: 'zoodata_search',
    description:
      'Look up the retail price of a product in ZooData. Call it once with the exact product name from the seller description. Returns up to 5 products with title, asin, price, rating and image. Returns an empty list or a note if ZooData has nothing; then use web_search for the brand price.',
    input_schema: { type: 'object', required: ['keyword'], additionalProperties: false, properties: { keyword: { type: 'string', maxLength: 80 } } },
  },
  publish_listing: {
    name: 'publish_listing',
    description:
      'Submit the researched item, the retail anchor, every comparable price you found and the listing copy. Call it exactly once. It waits for the seller to approve, then the relay computes the fair value with outliers excluded and sets the ask, floor and offer band. Returns {listing_id, fair_value, kept, excluded, ask, thin_data}. Never put a price in the copy.',
    input_schema: {
      type: 'object',
      required: ['item', 'comps', 'copy'],
      additionalProperties: false,
      properties: {
        item: {
          type: 'object',
          required: ['category', 'color', 'condition', 'photo_matches_description'],
          properties: {
            brand: { type: 'string' },
            category: { type: 'string' },
            model: { type: 'string' },
            color: { type: 'string' },
            size: { type: 'string' },
            condition: { enum: ['new_with_tags', 'excellent', 'good', 'fair'] },
            material: { type: 'string' },
            notes: { type: 'string', maxLength: 300 },
            photo_matches_description: { type: 'boolean' },
          },
        },
        retail_anchor: {
          type: 'object',
          properties: { title: { type: 'string' }, url: { type: 'string' }, price: { type: 'number', exclusiveMinimum: 0 } },
        },
        comps: {
          type: 'array',
          minItems: 3,
          maxItems: 15,
          items: {
            type: 'object',
            required: ['title', 'url', 'price', 'kind', 'match'],
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
              price: { type: 'number', exclusiveMinimum: 0 },
              kind: { enum: ['resale', 'new'] },
              match: { enum: ['exact', 'similar', 'loose'] },
            },
          },
        },
        copy: {
          type: 'object',
          required: ['title', 'description', 'bullets'],
          properties: {
            title: { type: 'string', maxLength: 70 },
            description: { type: 'string', maxLength: 300 },
            bullets: { type: 'array', items: { type: 'string', maxLength: 90 }, maxItems: 5 },
          },
        },
        image_url: { type: 'string' },
      },
    },
  },
  get_state: {
    name: 'get_state',
    description:
      "Read the current auction state for this session's buyer: the listing (title, condition, fair-value band, ask, offer band), the buyer's offers, the best offer on the board, seconds_left, rounds_used and suggested_counter. Call it first on every turn. Its numbers are the only truth; every dollar figure you write must come from it.",
    input_schema: emptyObject,
  },
  record_counter: {
    name: 'record_counter',
    description:
      'Record your reply to this buyer. label is countered (include amount >= suggested_counter), held (all rounds used; restate your last price) or leading (this buyer has the best valid offer). line is what the buyer sees: under 220 characters, no links or markup, and every dollar figure must come from get_state. Returns {ok, min_allowed?, reason?}. If ok is false, fix the line or amount using the reason and call it once more.',
    input_schema: {
      type: 'object',
      required: ['label', 'line'],
      additionalProperties: false,
      properties: { amount: { type: 'number' }, label: { enum: ['countered', 'held', 'leading'] }, line: { type: 'string', maxLength: 220 } },
    },
  },
  responder_record_counter: {
    name: 'record_counter',
    description:
      'Record your reply to this buyer BEFORE sending it. label is countered (include amount >= suggested_counter), held (all rounds used; restate your last price), leading (this buyer has the best valid offer) or answered (the buyer asked a question with no price: no round is used and no amount is needed). line is the exact text you will send: under 220 characters, no links or markup, and every dollar figure must come from get_state. Returns {ok, min_allowed?, reason?}. If ok is false, fix the line or amount using the reason and call it again. Only the line it approves can be sent.',
    input_schema: {
      type: 'object',
      required: ['label', 'line'],
      additionalProperties: false,
      properties: { amount: { type: 'number' }, label: { enum: ['countered', 'held', 'leading', 'answered'] }, line: { type: 'string', maxLength: 220 } },
    },
  },
  get_final_book: {
    name: 'get_final_book',
    description:
      "Read every buyer's best offer with its status (valid or below_floor), plus fair_value, floor and ask. Excluded outlier offers are not included. Call it once when the auction closes.",
    input_schema: emptyObject,
  },
  propose_sale: {
    name: 'propose_sale',
    description:
      'Propose the winner: the buyer with the highest valid offer (ties go to the earliest). The relay checks that your pick is the top valid offer and rejects anything else. Include one sentence of reasoning. Returns {ok, reason?}.',
    input_schema: {
      type: 'object',
      required: ['buyer_id', 'amount', 'reason'],
      additionalProperties: false,
      properties: { buyer_id: { type: 'string' }, amount: { type: 'number' }, reason: { type: 'string', maxLength: 200 } },
    },
  },
  confirm_sale: {
    name: 'confirm_sale',
    description:
      'Make the proposed sale final for the same buyer_id and amount you passed to propose_sale. It waits for the presenter to approve. Once approved the sale is final and the winner is shown on the big screen. Returns {sold, winner, amount}.',
    input_schema: {
      type: 'object',
      required: ['buyer_id', 'amount'],
      additionalProperties: false,
      properties: { buyer_id: { type: 'string' }, amount: { type: 'number' } },
    },
  },
  notify: {
    name: 'notify',
    description:
      'Show a message to the winner and one to everyone else on the buyer pages. Each message is under 220 characters with no links or markup; any dollar figure must be the sale amount, the fair-value band or the ask. Returns {ok, reason?}; if ok is false, fix the messages and call it once more.',
    input_schema: {
      type: 'object',
      required: ['winner', 'others'],
      additionalProperties: false,
      properties: { winner: { type: 'string', maxLength: 220 }, others: { type: 'string', maxLength: 220 } },
    },
  },
}

async function resource(role: keyof typeof MODELS): Promise<AgentResource> {
  const instructions = await readFile(join(here, `${role}.md`), 'utf8')
  const custom =
    role === 'lister'
      ? [tools.zoodata_search, tools.publish_listing]
      : role === 'negotiator'
        ? [tools.get_state, tools.record_counter]
        : role === 'responder'
          ? [tools.get_state, tools.responder_record_counter]
          : [tools.get_final_book, tools.propose_sale, tools.confirm_sale, tools.notify]
  return {
    name: `snap-sell-${role}`,
    model: { primary: MODELS[role], thinking: THINKING[role], ...(role === 'negotiator' ? { max_tokens: 600 } : {}) },
    persona: { docs: [{ name: 'AGENTS.md', content: instructions }] },
    custom_tools: custom as CustomToolDeclaration[],
    tool_policy:
      role === 'lister'
        ? { deny: ['write', 'edit', 'apply_patch', 'process', 'pdf', 'artifact_publish', 'agent_db', 'cron', 'message'], permissions: { publish_listing: 'always_ask' } }
        : role === 'closer'
          ? { deny: NO_BUILTINS, permissions: { confirm_sale: 'always_ask' } }
          : role === 'responder'
            ? // exec stays available for the browser helper only: every call waits for the relay, which approves just the three helper commands.
              { deny: NO_BUILTINS.filter((t) => t !== 'exec'), permissions: { exec: 'always_ask' } }
            : { deny: NO_BUILTINS },
    labels: { app: 'snap-and-sell', role },
  } as AgentResource
}

const client = createZooworkClient()
const allRoles = ['lister', 'negotiator', 'closer', 'responder'] as const
// --only lister,negotiator,closer: touch just those agents (the QR room flow does not use the Responder).
const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx >= 0 ? String(process.argv[onlyIdx + 1] ?? '').split(',') : undefined
const roles = only ? allRoles.filter((r) => only.includes(r)) : allRoles
if (roles.length === 0) throw new Error(`--only must name some of: ${allRoles.join(', ')}`)

// Read-only: confirm each model alias is selectable in this deployment's catalog.
const catalog = await client.listModels()
for (const role of roles) {
  const row = catalog.find((m) => m.model === MODELS[role])
  if (!row || row.selectable === false) {
    throw new Error(`${role}: ${MODELS[role]} is not selectable. Pick another alias from listModels() and set ${role.toUpperCase()}_MODEL.`)
  }
  const levels = row.thinking?.levels ?? []
  console.log(`${role.padEnd(10)} ${MODELS[role]}  thinking=${THINKING[role]}  (model levels: ${levels.join(', ') || 'n/a'})`)
}

if (dryRun) {
  for (const role of roles) {
    const r = await resource(role)
    console.log(`\n--- ${role} ---\n${JSON.stringify({ ...r, persona: { docs: [{ name: 'AGENTS.md', content: '(…instructions…)' }] } }, null, 2)}`)
  }
  console.log('\nDry run: no agents were created or started.')
  process.exit(0)
}

let ids: Partial<Record<(typeof roles)[number], string>> = {}
try {
  ids = JSON.parse(await readFile(join(here, 'ids.json'), 'utf8'))
} catch {
  // first run
}

// Create one at a time: concurrent createAgent calls in one organization can fail.
for (const role of roles) {
  const res = await resource(role)
  const existing = ids[role]
  if (existing) {
    await client.updateAgent(existing, res as never)
    console.log(`${role}: updated ${existing}`)
  } else {
    const created = await client.createAgent({ resource: res }, `snap-sell-${role}-v1`)
    ids[role] = created.agent_id
    console.log(`${role}: created ${created.agent_id}`)
  }
  const id = ids[role] as string
  await client.startAgent(id)
  await client.waitUntilRunning(id)
  console.log(`${role}: running`)
  await writeFile(join(here, 'ids.json'), JSON.stringify(ids, null, 2) + '\n')
}
console.log('\nDone. agents/ids.json written. Start the relay with: ZOOWORK_MODE=live npm run relay')
