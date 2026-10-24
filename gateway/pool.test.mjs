// Regressions for the adaptive RPC pool in wns.js: rate-limit benching with
// Retry-After, configured-first selection, overflow to the public pool, and
// capacity that scales with healthy endpoints. Stubbed fetch; no network.

import { ethCall, rpcIdle } from './wns.js'

let pass = 0, fail = 0
const eq = (label, got, want) => {
  if (got === want) { pass++; console.log('ok   ', label) }
  else { fail++; console.log('FAIL ', label, JSON.stringify(got), '!==', JSON.stringify(want)) }
}
console.warn = () => {}
console.error = () => {}

// Every RPC is answered by `node(host)`, after `delay(host)` ms.
let node = () => ({ status: 200, body: { result: '0x01' } })
let delay = () => 0
let hits = []
let live = 0
let peak = 0
globalThis.fetch = async (url, init) => {
  const host = new URL(String(url)).host
  hits.push(host)
  live++
  peak = Math.max(peak, live)
  try {
    const ms = delay(host)
    if (ms) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }
    const r = node(host)
    if (r instanceof Error) throw r
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...r.body }), {
      status: r.status,
      headers: r.headers || {},
    })
  } finally {
    live--
  }
}
const reset = () => { hits = []; peak = 0 }

// --- configured endpoints are preferred over the public pool -----------------
{
  reset()
  for (let i = 0; i < 10; i++) await ethCall('0x12345678', { rpc: ['https://mine.invalid'] })
  eq('configured: serves every call while healthy', hits.every((h) => h === 'mine.invalid'), true)
}

// --- a 429 benches the endpoint for its Retry-After, traffic moves on ---------
{
  reset()
  node = (h) => (h === 'limited.invalid'
    ? { status: 429, body: { error: { code: -32005, message: 'rate limit exceeded' } }, headers: { 'retry-after': '60' } }
    : { status: 200, body: { result: '0x02' } })
  const rpc = ['https://limited.invalid', 'https://spare.invalid']
  const first = await ethCall('0x12345678', { rpc })
  eq('429: the call still succeeds on another node', first, '0x02')
  reset()
  for (let i = 0; i < 10; i++) await ethCall('0x12345678', { rpc })
  eq('429: the benched node is not asked again inside Retry-After', hits.includes('limited.invalid'), false)
  node = () => ({ status: 200, body: { result: '0x01' } })
}

// --- a rate limit in a JSON error body counts the same ------------------------
{
  reset()
  node = (h) => (h === 'quota.invalid'
    ? { status: 200, body: { error: { code: -32005, message: 'daily request quota exceeded' } } }
    : { status: 200, body: { result: '0x03' } })
  const rpc = ['https://quota.invalid', 'https://other.invalid']
  await ethCall('0x12345678', { rpc })
  await ethCall('0x12345678', { rpc })
  reset()
  for (let i = 0; i < 5; i++) await ethCall('0x12345678', { rpc })
  eq('quota error: node benched', hits.includes('quota.invalid'), false)
  node = () => ({ status: 200, body: { result: '0x01' } })
}

// --- a revert is the contract's answer, not the node's fault ------------------
{
  reset()
  node = () => ({ status: 200, body: { error: { code: 3, message: 'execution reverted' } } })
  let threw = false
  try { await ethCall('0x12345678', { rpc: ['https://rev.invalid', 'https://rev2.invalid'] }) } catch (e) { threw = e.rpcError }
  eq('revert: surfaced as an rpcError', threw, true)
  eq('revert: asked once, not once per node', hits.length, 1)
  node = () => ({ status: 200, body: { result: '0x01' } })
  reset()
  await ethCall('0x12345678', { rpc: ['https://rev.invalid'] })
  eq('revert: the node is not benched for it', hits[0], 'rev.invalid')
}

// --- a saturated configured node overflows to the public pool -----------------
{
  reset()
  delay = (h) => (h === 'slow.invalid' ? 80 : 5)
  await Promise.all(Array.from({ length: 40 }, () => ethCall('0x12345678', { rpc: ['https://slow.invalid'] })))
  const mine = hits.filter((h) => h === 'slow.invalid').length
  eq('overflow: the configured node takes its share', mine > 0, true)
  eq('overflow: the rest went to the public pool, not a queue', hits.length - mine > 0, true)
  delay = () => 0
}

// --- capacity grows with healthy endpoints ------------------------------------
{
  reset()
  delay = () => 30
  const rpc = Array.from({ length: 6 }, (_, i) => `https://wide${i}.invalid`)
  await Promise.all(Array.from({ length: 120 }, () => ethCall('0x12345678', { rpc })))
  eq('capacity: well past the old fixed cap of 24 at once', peak > 24, true)
  eq('capacity: and idle again once drained', rpcIdle(), true)
  delay = () => 0
}

// --- one endpoint that only times out does not hold the call hostage ----------
{
  reset()
  delay = (h) => (h === 'hang.invalid' ? 60_000 : 0)
  const t = Date.now()
  const r = await ethCall('0x12345678', { rpc: ['https://hang.invalid'], timeoutMs: 100 })
  eq('timeout: answered by the public pool behind it', r, '0x01')
  eq('timeout: within about one timeout', Date.now() - t < 1_000, true)
  reset()
  await ethCall('0x12345678', { rpc: ['https://hang.invalid', 'https://ok.invalid'], timeoutMs: 100 })
  eq('timeout: the hung node is benched', hits[0], 'ok.invalid')
  delay = () => 0
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
