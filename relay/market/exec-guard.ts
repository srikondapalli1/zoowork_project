// The Responder agent has ZooWork's built-in `exec` tool, and a sandbox command can reach the open internet.
// So every exec call pauses for approval (permission policy `always_ask`) and the relay approves ONLY the three
// browser-helper commands, in exactly these shapes. Anything else, including anything a buyer talks the model
// into trying, is denied before it runs.
//
//   node market/b.cjs inbox
//   node market/b.cjs read t_0123456789
//   node market/b.cjs send t_0123456789 'the text'      (single quotes, "double quotes", or a mix; no expansions)

const THREAD = /^t_[0-9a-f]{10}$/
const MAX_TEXT = 300

/** Parse one shell word made only of quoted segments and escaped apostrophes. Returns its value, or undefined. */
export function parseQuotedWord(src: string): string | undefined {
  let i = 0
  let out = ''
  let sawSegment = false
  while (i < src.length) {
    const ch = src[i] as string
    if (ch === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) return undefined
      out += src.slice(i + 1, end) // nothing is special inside single quotes
      i = end + 1
    } else if (ch === '"') {
      i += 1
      for (;;) {
        const c = src[i]
        if (c === undefined) return undefined // unterminated
        if (c === '"') { i += 1; break }
        if (c === '$' || c === '`') return undefined // expansion: not allowed even inside quotes
        if (c === '\\') {
          const n = src[i + 1]
          if (n === '"' || n === '$' || n === '`' || n === '\\') { out += n; i += 2; continue }
          return undefined
        }
        out += c
        i += 1
      }
    } else if (ch === '\\' && src[i + 1] === "'") {
      out += "'" // the usual '\'' idiom for an apostrophe between single-quoted parts
      i += 2
    } else {
      return undefined // anything bare (spaces, ; & | < > ( ) newlines, ...) is not allowed
    }
    sawSegment = true
  }
  return sawSegment ? out : undefined
}

export type ExecVerdict = { ok: true; summary: string } | { ok: false; reason: string }

export function checkExecCommand(command: string): ExecVerdict {
  const cmd = command.trim().replace(/^cd \/workspace && /, '')
  if (cmd === 'node market/b.cjs inbox') return { ok: true, summary: 'Looked at the inbox' }
  let m = /^node market\/b\.cjs read (\S+)$/.exec(cmd)
  if (m) return THREAD.test(m[1] as string) ? { ok: true, summary: `Reading chat ${m[1]}` } : { ok: false, reason: 'bad thread id' }
  m = /^node market\/b\.cjs send (t_[0-9a-f]{10}) (.+)$/s.exec(cmd)
  if (m) {
    const text = parseQuotedWord(m[2] as string)
    if (text === undefined) return { ok: false, reason: 'the text must be one quoted word with no shell expansion' }
    if (text.length === 0 || text.length > MAX_TEXT) return { ok: false, reason: 'the text must be 1 to 300 characters' }
    if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: 'control characters are not allowed' }
    return { ok: true, summary: `Sending a reply to chat ${m[1]}` }
  }
  return { ok: false, reason: 'only the browser helper commands are allowed' }
}

/** Pull the command string out of an approval's arguments, whatever shape the runtime uses for exec. */
export function commandOf(args: Record<string, unknown>): string | undefined {
  for (const k of ['command', 'cmd', 'script']) if (typeof args[k] === 'string') return args[k] as string
  for (const k of ['argv', 'args']) {
    const v = args[k]
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(' ')
  }
  return undefined
}
