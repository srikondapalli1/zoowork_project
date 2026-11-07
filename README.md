# Snap & Sell

One photo and a one-line description of a used fashion item become a priced live listing. An agent then
negotiates with the whole room at once and closes the sale on its own. Built on ZooWork Managed Agents.
The full spec is the "Snap & Sell — Build Spec" PDF; this README covers running what is built.

## How it fits together

```
relay/    index.ts (entry), web.ts (pages + API), engine.ts (offer book), book.ts (money rules), check.ts (reply check),
          tools.ts (custom tools), turns.ts (concurrency), relay.ts (orchestration), live.ts (ZooWork), stub.ts (local agents)
pages/    admin.html (seller console), buyer.html (the QR page), screen.html (big screen, Chart.js from cdnjs)
agents/   lister.md, negotiator.md, closer.md, create-agents.ts
bot/      attack.ts
data/rehearsal/  saved listing and photo for "Load rehearsal listing"
```

Three ZooWork agents write words and make judgments: **Lister** (research and copy), **Negotiator** (one session per
buyer) and **Closer** (proposes the sale). The relay owns every number that moves money. Agents propose; only the
offer book makes anything count. Buyers can only send `{amount, intent}`, so no buyer text ever reaches a model.

**No payment step.** When the presenter approves the sale the sale is final and the winner is displayed on the big
screen and on the winner's phone.

## Run it

```bash
npm install
cp .env.example .env     # then fill in values on your own machine
```

`ZOOWORK_MODE=stub` (the default) runs the three agents as local code: free, and it runs the same rules.

```bash
ADMIN_TOKEN=pick-something npm run relay
node bot/attack.ts --setup --token pick-something     # all personas, in a second terminal
```

At 3x speed while building: `AUCTION_SECONDS=30 TIME_SCALE=3 npm run relay`.

### Live on ZooWork

```bash
npm run create-agents -- --dry-run   # read-only: checks the model aliases and prints the configs
npm run create-agents                # creates and starts the three agents (uses your prepaid balance)
ZOOWORK_MODE=live ADMIN_TOKEN=... PUBLIC_BASE_URL=https://<your tunnel> npm run relay
```

Check **Usage** in ZooWork Platform for actual charges.

### Environment variables

| Variable | Purpose |
|---|---|
| `ZOOWORK_API_KEY` | ZooWork key (server side only) |
| `ZOODATA_API_KEY` | Optional ZooData retail lookup; without it the Lister uses `web_search` |
| `ADMIN_TOKEN` | Required header/query token for the seller console and admin API |
| `PUBLIC_BASE_URL` | Your cloudflared/ngrok URL (used in the QR code) |
| `AUCTION_SECONDS` (90), `FEE_PCT` (0.10), `MAX_BUYERS` (150), `PORT` (8787) | Tuning |
| `TIME_SCALE`, `TURN_DEADLINE_MS`, `GLOBAL_TURN_CAP`, `ZOOWORK_MODE` | Testing and rehearsal |

Keep every key out of the repo and off the slides.

## Tests

```bash
npm test          # 26 tests: rules, reply check, turn concurrency, fallback, sale flow, snapshots
npm run typecheck
```

## Decisions beyond the spec

- **Thin-data band:** with fewer than 3 usable comparables the spec fixes only the mid (retail x condition factor).
  This build uses mid +/- 20% for low and high.
- **Photo upload:** the sandbox upload runs at about 100 KB/s, so the relay shrinks every photo to at most 1024 px
  JPEG (about 150 KB) before it goes to the Lister.
- **Studio-style image:** not built. The docs describe no image-generation tool; the original photo is used (this is
  first in the spec's cut order).
- **Sale approval:** the Closer calls `confirm_sale` (approval policy `always_ask`) in place of `create_payment_link`.
- **Join turn:** the Negotiator is told to greet with `record_counter` label `leading` and no amount.
- **ZooData:** the endpoint is from the spec; the request body (`{"keyword": ...}`) and Bearer auth are assumptions.
