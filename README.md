# Snap & Sell

One photo and a one-line description of a used fashion item become a priced live listing. An agent then
negotiates with the whole room at once and closes the sale on its own. Built on ZooWork Managed Agents.
The full spec is the "Snap & Sell — Build Spec" PDF; this README covers running what is built.

## How it fits together

```
relay/    index.ts (entry), web.ts (pages + API), engine.ts (offer book), book.ts (money rules), check.ts (reply check),
          tools.ts (custom tools), turns.ts (concurrency), relay.ts (orchestration), live.ts (ZooWork), stub.ts (local agents)
pages/    admin.html (seller console), buyer.html (the QR page), screen.html (big screen; Chart.js is vendored in pages/vendor),
          market.html / market-inbox.html (the Swapspot marketplace and the inbox the browser agent works), split.html (recording view)
agents/   lister.md, negotiator.md, closer.md, responder.md, create-agents.ts, market/b.cjs (the agent's browser helper)
bot/      attack.ts (QR room personas), marketplace-buyers.ts (30 fake marketplace buyers)
scripts/  record-marketplace.ts (split-screen recording)
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
| `MARKET_KEY` | Scoped key for the browser agent's seller inbox and live feed (cannot reach the admin API) |
| `PUBLIC_BASE_URL` | Your cloudflared/ngrok URL (used in the QR code) |
| `AUCTION_SECONDS` (90), `FEE_PCT` (0.10), `MAX_BUYERS` (150), `PORT` (8787) | Tuning |
| `TIME_SCALE`, `TURN_DEADLINE_MS`, `GLOBAL_TURN_CAP`, `ZOOWORK_MODE` | Testing and rehearsal |

Keep every key out of the repo and off the slides.

## Run the room demo on real phones

Phones can only open the QR code if the relay has a public https address, so the relay on your laptop needs a tunnel in front of it.
One command does all of it:

```bash
npm run demo -- --stub        # free rehearsal with local stand-ins: do this first, on real phones
npm run demo                  # live on ZooWork Managed Agents (needs ZOOWORK_API_KEY and `npm run create-agents`)
```

It checks your setup, starts a cloudflared tunnel and the relay with the right `PUBLIC_BASE_URL`, confirms the relay answers **from outside**,
and prints three URLs plus a QR code you can scan from the terminal:

| URL | Who |
|---|---|
| `<tunnel>/screen` | the projector |
| `<tunnel>/admin?token=...` | the presenter's phone (keep this URL private: it is the admin key) |
| `<tunnel>/join` | the room and the judges |

The QR code on the big screen encodes `/join`, a stable link that shows "waiting for the seller" until a listing is approved and then forwards
every phone to it. So the link can be shared or printed ahead of time, and a phone that arrives late lands on the live auction.
If the relay is told a public address that cannot work (for example `localhost`), the terminal, the seller console and the big screen all say so,
and `npm run demo` prints NOT READY instead of a QR code until the tunnel answers.

Other options: `--tunnel none` with your own tunnel via `PUBLIC_BASE_URL=https://...` (ngrok, a reserved cloudflared domain), `--seconds 60`,
`--max-buyers 40`, `--port 8787`. Check everything without starting anything: `npm run preflight -- --url https://<tunnel>`.

Each phone is a live agent session, so a big room costs more and sees more template fallbacks; the room is capped at 40 by default.

## Marketplace channel (browser-use agent)

A second way for buyers to arrive, next to the room QR: a fake marketplace, **Swapspot** (Facebook-Marketplace-style, deliberately
not Facebook), where buyers send free-text DMs. A fourth ZooWork agent, the **Responder**, works the seller inbox in a real
Chromium browser inside its own ZooWork sandbox, with the same negotiation pattern (counter schedule, rounds, floor never revealed).

Switch with the **Channel** card on the seller console (before the auction opens): *QR room* or *Marketplace*.

How a DM is handled:
1. The relay finds any price in the text itself (`relay/market/parse.ts`) and applies the same offer rules as the QR flow:
   outliers get an automatic reply and never reach an agent.
2. Otherwise it wakes that buyer's Responder session with `{"event":"message","thread":"t_x","has_offer":true}`. No buyer text is in the event.
3. The agent runs `node market/b.cjs read t_x` (browser), calls `get_state` and `record_counter` (custom tools, reply check), then
   `node market/b.cjs send t_x '<line>'`, which types in the composer and clicks Send.
4. The marketplace **server** refuses any text that is not the line `record_counter` approved, so the agent drives a real UI but can't
   put a figure, the floor or a promise of its own into a thread.
5. `exec` is `always_ask`: the relay approves only the three helper commands (`relay/market/exec-guard.ts`) and denies everything else.

Buyer text is untrusted data, so "no buyer text reaches a model" no longer holds on this channel. The guarantee is that
**injected text is powerless**: the agent never knows the floor, can't set a price, can't sell, and can't run another command.

```bash
# free rehearsal with local stand-ins (real Chromium drives the real helper):
ADMIN_TOKEN=x npm run relay &
node bot/marketplace-buyers.ts --setup --token x          # 30 fake buyers, one message every 10 to 15 s

# one-command split-screen recording (agent's browser left, seller dashboard right):
npm run record:marketplace -- --stub                      # labelled STUB RUN, no ZooWork calls
npm run record:marketplace -- --tunnel cloudflared        # the real thing (needs a tunnel and `npm run create-agents`)
```

The real run needs a public URL because ZooWork's sandbox has to reach the marketplace (`PUBLIC_BASE_URL`, or `--tunnel cloudflared`).
Replies take several model steps (read, `get_state`, `record_counter`, send), so marketplace DMs use a 12 s promise
(`MARKET_DEADLINE_MS`) instead of the QR page's 8 s; a template reply lands at the deadline.

## Tests

```bash
npm test          # rules, reply check, turn concurrency, fallback, sale flow, snapshots, marketplace DMs, exec guard
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
