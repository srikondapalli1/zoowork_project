// npm run preflight [-- --url https://<tunnel> --stub --no-reach]
// Checks everything a live demo depends on, without starting anything or spending anything.
import { preflight, printChecks } from './lib/preflight.ts'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const stub = process.argv.includes('--stub')
const url = (arg('--url') ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '') || undefined

const checks = await preflight({ stub, publicUrl: url, checkReachable: !process.argv.includes('--no-reach') && !!url, needCloudflared: false })
printChecks(checks)
const failed = checks.filter((c) => c.level === 'fail').length
console.log(failed ? `\n${failed} problem${failed === 1 ? '' : 's'} to fix before the demo.` : '\nReady.')
process.exit(failed ? 1 : 0)
