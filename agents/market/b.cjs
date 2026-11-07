#!/usr/bin/env node
/* Browser helper for the Snap & Sell marketplace agent.
 *
 * It runs inside the agent's ZooWork sandbox (Chromium + playwright-core are preinstalled there) and lets
 * the agent work the seller inbox like a person would, one short command at a time:
 *
 *   node market/b.cjs inbox                 list chats and unread counts
 *   node market/b.cjs read <thread>         open a chat and print the conversation
 *   node market/b.cjs send <thread> "text"  type text in the composer and click Send
 *   node market/b.cjs stop                  close the browser
 *
 * A small background daemon keeps one logged-in Chromium alive between commands (one tab per chat), and starts
 * itself on demand, because an idle sandbox is paused and takes the daemon with it.
 * It also pushes browser frames and a plain-language action log to the relay, which powers the live
 * "agent's browser" view. Settings: market/config.json {"base": "https://...", "key": "..."}.
 * CommonJS on purpose: the sandbox resolves playwright-core through NODE_PATH, which ESM imports ignore.
 */
'use strict'
const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

const PORT = Number(process.env.B_PORT || 9333)
const cfgPath = path.join(__dirname, 'config.json')
const cfg = Object.assign({}, fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}, process.env.B_BASE ? { base: process.env.B_BASE } : {}, process.env.B_KEY ? { key: process.env.B_KEY } : {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ----------------------------------------------------------------------------- daemon
async function daemon() {
  let pw
  try { pw = require('playwright-core') } catch { pw = require('playwright') }
  if (!cfg.base || !cfg.key) throw new Error('market/config.json needs base and key')
  const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
  const context = await browser.newContext({ viewport: { width: 1100, height: 680 } })
  const pages = new Map()
  let active = null
  let activeAt = 0
  const url = (hash) => `${cfg.base}/market/inbox?key=${encodeURIComponent(cfg.key)}${hash ? '#' + hash : ''}`

  async function push(page, action) {
    try {
      const body = { action }
      if (page) body.frame = (await page.screenshot({ type: 'jpeg', quality: 55 })).toString('base64')
      await fetch(`${cfg.base}/api/market/feed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-market-key': cfg.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) })
    } catch { /* the feed is best effort and must never break a command */ }
  }

  async function pageFor(thread) {
    let p = pages.get(thread)
    if (!p) {
      p = await context.newPage()
      pages.set(thread, p)
      await p.goto(url(thread), { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('#conversation .msg, #conversation .empty', { timeout: 10000 })
    }
    active = p; activeAt = Date.now()
    return p
  }

  async function transcript(page) {
    await page.evaluate(() => window.__refresh && window.__refresh())
    return page.evaluate(() => ({
      who: document.getElementById('who').textContent,
      messages: [...document.querySelectorAll('#conversation .msg')].map((m) => ({ from: m.dataset.from, text: m.firstChild ? m.firstChild.textContent : m.textContent })),
    }))
  }

  const ops = {
    async inbox() {
      const p = (pages.get('_inbox') || (pages.set('_inbox', await context.newPage()), pages.get('_inbox')))
      if (p.url() === 'about:blank') await p.goto(url(''), { waitUntil: 'domcontentloaded' })
      await p.evaluate(() => window.__refresh && window.__refresh())
      await p.waitForSelector('#threads', { timeout: 10000 })
      const rows = await p.$$eval('#threads button[data-thread]', (bs) => bs.map((b) => ({ id: b.dataset.thread, unread: Number(b.dataset.unread), name: b.querySelector('strong').textContent.replace(/ \(\d+ new\)$/, ''), last: b.querySelector('small').textContent })))
      active = p; activeAt = Date.now()
      await push(p, `Looked at the inbox: ${rows.filter((r) => r.unread > 0).length} chats waiting`)
      return { out: rows.length ? rows.map((r) => `${r.id}  ${r.name}  unread=${r.unread}  last: ${r.last}`).join('\n') : '(no chats yet)', code: 0 }
    },
    async read([thread]) {
      if (!thread) return { out: 'usage: read <thread>', code: 2 }
      const p = await pageFor(thread)
      const t = await transcript(p)
      await push(p, `Opened the chat with ${t.who} and read ${t.messages.length} message${t.messages.length === 1 ? '' : 's'}`)
      const lines = t.messages.map((m) => `[${m.from === 'buyer' ? 'buyer' : 'you'}] ${m.text}`)
      return { out: `CHAT ${thread} with ${t.who}\n${lines.join('\n')}`, code: 0 }
    },
    async send([thread, ...rest]) {
      const text = rest.join(' ')
      if (!thread || !text) return { out: 'usage: send <thread> "text"', code: 2 }
      const p = await pageFor(thread)
      await p.fill('#composer', text)
      await push(p, `Typed a reply (${text.length} characters)`)
      await p.click('#send')
      try {
        await p.waitForFunction(() => !document.getElementById('error').hidden || document.getElementById('composer').value === '', null, { timeout: 8000 })
      } catch { /* fall through to the checks below */ }
      const err = await p.evaluate(() => { const e = document.getElementById('error'); return e.hidden ? '' : e.textContent })
      if (err) {
        await push(p, `Send blocked by the marketplace: ${err.slice(0, 120)}`)
        return { out: `ERROR: ${err}`, code: 2 }
      }
      await push(p, 'Clicked Send: message delivered')
      return { out: 'SENT', code: 0 }
    },
    async stop() { setTimeout(() => process.exit(0), 50); return { out: 'stopped', code: 0 } },
  }

  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    try {
      const { cmd, args } = JSON.parse(body || '{}')
      const op = ops[cmd]
      const r = op ? await op(args || []) : { out: `unknown command ${cmd}`, code: 2 }
      res.end(JSON.stringify(r))
    } catch (e) {
      res.end(JSON.stringify({ out: `ERROR: ${e.message}`, code: 1 }))
    }
  })
  server.listen(PORT, '127.0.0.1')

  // A gentle 2 fps heartbeat of whatever tab was used last, for the live view.
  setInterval(async () => { if (active && Date.now() - activeAt < 20000) await push(active) }, 500)
}

// ----------------------------------------------------------------------------- CLI
function call(cmd, args) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', timeout: 60000 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    })
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('daemon timed out')))
    req.end(JSON.stringify({ cmd, args }))
  })
}

async function cli() {
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd || cmd === 'help') { console.log('usage: node market/b.cjs inbox | read <thread> | send <thread> "text" | stop'); return }
  let r
  try {
    r = await call(cmd, args)
  } catch (e) {
    if (cmd === 'stop') { console.log('not running'); return }
    // No daemon (first use, or the sandbox was paused): start one and retry.
    const child = spawn(process.execPath, [__filename, 'daemon'], { detached: true, stdio: 'ignore', env: process.env })
    child.unref()
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      try { r = await call(cmd, args); break } catch { /* not up yet */ }
    }
    if (!r) { console.log('ERROR: the browser did not start'); process.exit(1) }
  }
  console.log(r.out)
  process.exit(r.code || 0)
}

if (process.argv[2] === 'daemon') daemon().catch((e) => { console.error(e); process.exit(1) })
else cli()
