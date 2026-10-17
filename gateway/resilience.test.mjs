// Regressions for proxy-mode resilience and per-client fairness: upstream
// redirects, stalled bodies, ranges and validators, the per-client gate, IPv6
// bucketing, stale resolution on RPC outage, and capped RPC replies. Stubbed
// fetch; no network.

import { handleRequest, clientKey, buckets } from './handler.js'
import { ethCall } from './wns.js'

let pass = 0, fail = 0
const eq = (label, got, want) => {
  if (got === want) { pass++; console.log('ok   ', label) }
  else { fail++; console.log('FAIL ', label, JSON.stringify(got), '!==', JSON.stringify(want)) }
}

// Upstream fetches are answered by `upstream(url, init)`; RPC by `rpc(body)`.
let upstream = () => new Response('x')
let rpc = () => ({ result: '0x' })
let fetches = []
globalThis.fetch = async (url, init) => {
  if (init?.body) {
    const r = rpc(JSON.parse(init.body))
    if (r instanceof Error) throw r
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...r }))
  }
  fetches.push({ url: String(url), init })
  return upstream(String(url), init)
}

const ENV = {
  ZONE: 'wei.limo',
  RATE_LIMIT_RPS: 0,
  GATEWAY_MODE: 'proxy',
  IPFS_PATH_GATEWAY: 'https://pin.gw',
  IPFS_BROWSER_GATEWAY: 'off',
  RPC_URLS: 'https://node.invalid',
}
let n = 0
// A fresh CID label per scenario, so no scenario reads another's cached body.
const cid = () => 'b' + 'a'.repeat(50) + (n++).toString(32).padStart(8, '2').replace(/[0189]/g, (d) => 'wxyz'['0189'.indexOf(d)])
const get = (host, path = '/', headers = {}, env = ENV) =>
  handleRequest(new Request(`https://${host}.wei.limo${path}`, { headers }), env)

// --- upstream redirects ------------------------------------------------------
{
  const c = cid()
  fetches = []
  upstream = (url) =>
    url.endsWith('/docs')
      ? new Response('moved', { status: 301, headers: { location: `/ipfs/${c}/docs/` } })
      : new Response('index')
  const res = await get(c, '/docs')
  eq('dir redirect: handed to the visitor', res.status, 301)
  eq('dir redirect: as a path on this origin', res.headers.get('location'), '/docs/')
  eq('dir redirect: never followed upstream', fetches.length, 1)
  eq('dir redirect: fetched with redirect manual', fetches[0].init.redirect, 'manual')
}
{
  const c = cid()
  upstream = () => new Response('', { status: 302, headers: { location: `/ipfs/${c}//evil.example/` } })
  const res = await get(c, '/x')
  eq('redirect: never protocol-relative', res.headers.get('location'), '/evil.example/')
}
{
  const c = cid()
  upstream = () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example/' } })
  const res = await get(c, '/x')
  eq('off-site redirect: not passed on', res.headers.get('location'), null)
  eq('off-site redirect: an upstream error', res.status, 502)
}

// --- stalled bodies ----------------------------------------------------------
{
  const c = cid()
  // Headers, one chunk, then nothing at all.
  upstream = () =>
    new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array([60])) }, pull() { return new Promise(() => {}) } }), {
      headers: { 'content-type': 'text/html' },
    })
  const env = { ...ENV, PROXY_IDLE_TIMEOUT_MS: 50 }
  const t = Date.now()
  const [a, b] = await Promise.all([get(c, '/', {}, env), get(c, '/', {}, env)])
  eq('stalled body: a 502, not a hang', a.status, 502)
  eq('stalled body: a joiner is released too', b.status === 502 || b.status === 200, true)
  eq('stalled body: within the idle timeout', Date.now() - t < 2000, true)
}
{
  const c = cid()
  upstream = () =>
    new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array([1])) }, pull() { return new Promise(() => {}) } }), {
      status: 206,
      headers: { 'content-range': 'bytes 0-0/9' },
    })
  const res = await get(c, '/v.mp4', { range: 'bytes=0-' }, { ...ENV, PROXY_IDLE_TIMEOUT_MS: 50 })
  let err = null
  try { await res.arrayBuffer() } catch (e) { err = e }
  eq('stalled stream: the body errors instead of hanging', /stalled/.test(String(err?.message || err?.cause?.message)), true)
}

// --- ranges and validators ---------------------------------------------------
{
  const c = cid()
  fetches = []
  upstream = (url, init) =>
    new Response('ab', { status: 206, headers: { 'content-range': 'bytes 0-1/10', 'accept-ranges': 'bytes' } })
  const res = await get(c, '/v.mp4', { range: 'bytes=0-1' })
  eq('range: forwarded', fetches[0].init.headers.range, 'bytes=0-1')
  eq('range: 206 passes through', res.status, 206)
  eq('range: content-range kept', res.headers.get('content-range'), 'bytes 0-1/10')
  await get(c, '/v.mp4', { range: 'bytes=0-1' })
  eq('range: never served from the cache', fetches.length, 2)
}
{
  const c = cid()
  fetches = []
  upstream = () => new Response('hello', { headers: { etag: `"${c}"`, 'content-type': 'text/plain' } })
  const first = await get(c, '/a.txt')
  eq('etag: first load is a 200', first.status, 200)
  const again = await get(c, '/a.txt', { 'if-none-match': `W/"${c}"` })
  eq('etag: revalidation is a 304', again.status, 304)
  eq('etag: answered from the cache', fetches.length, 1)
  eq('etag: 304 stays fresh', again.headers.get('cache-control'), 'public, max-age=300')
}
{
  // IPNS is never held, so validators go upstream and its 304 comes back.
  const k = 'k' + '5'.repeat(60)
  fetches = []
  upstream = () => new Response(null, { status: 304, headers: { etag: '"v1"' } })
  const res = await get(k, '/', { 'if-none-match': '"v1"' })
  eq('ipns: validator forwarded', fetches[0].init.headers['if-none-match'], '"v1"')
  eq('ipns: 304 passed back', res.status, 304)
  eq('ipns: 304 is not no-store', res.headers.get('cache-control'), 'public, max-age=300')
}

// --- client identity ---------------------------------------------------------
eq('ipv4: as-is', clientKey('203.0.113.9'), '203.0.113.9')
eq('ipv6: by /64', clientKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64')
eq('ipv6: compressed and full agree', clientKey('2001:db8:0:0:1::5'), clientKey('2001:0db8:0000:0000:ffff::9'))
eq('ipv6: suffix rotation is one client', clientKey('2001:db8::1'), clientKey('2001:db8::dead:beef'))
eq('ipv6: zone id ignored', clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64')
eq('unknown: one shared key', clientKey(undefined), 'unknown')

// --- per-client gate ---------------------------------------------------------
{
  buckets.clear()
  const env = { ...ENV, RATE_LIMIT_RPS: 1000, RATE_LIMIT_BURST: 1000 }
  let open = 0, peak = 0
  const gate = []
  upstream = () => {
    open++
    peak = Math.max(peak, open)
    return new Promise((resolve) => gate.push(() => { open--; resolve(new Response('ok')) }))
  }
  // Distinct CIDs so nothing coalesces: 8 run, 64 wait, the rest are refused.
  const reqs = Array.from({ length: 80 }, () =>
    handleRequest(new Request(`https://${cid()}.wei.limo/`), env, { clientIp: '198.51.100.7' }))
  await new Promise((r) => setTimeout(r, 20))
  const other = handleRequest(new Request(`https://${cid()}.wei.limo/`), env, { clientIp: '198.51.100.8' })
  await new Promise((r) => setTimeout(r, 20))
  eq('gate: another client is not queued behind', open, 9)
  const drain = setInterval(() => { while (gate.length) gate.shift()() }, 1)
  const all = await Promise.all([...reqs, other])
  clearInterval(drain)
  eq('gate: at most 8 in flight for one client (+1 other)', peak, 9)
  eq('gate: overflow refused with 429', all.filter((r) => r.status === 429).length, 8)
  eq('gate: the rest served', all.filter((r) => r.status === 200).length, 73)
  buckets.clear()
}

// --- stale resolution --------------------------------------------------------
{
  const IPFS_CH =
    '0x0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000026' +
    'e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f' +
    '0000000000000000000000000000000000000000000000000000'
  rpc = (body) => {
    const sel = body.params[0].data.slice(0, 10)
    if (sel === '0xfb021939') return { result: '0x' + '00'.repeat(31) + '2a' }
    if (sel === '0xcb323d76') return { result: IPFS_CH }
    return { result: '0x' }
  }
  upstream = () => new Response('site')
  const first = await get('stalecase', '/')
  eq('stale: first resolution serves', first.status, 200)
  // Age the 60s entry out without sleeping: the fallback must outlive it.
  const realNow = Date.now
  Date.now = () => realNow() + 120_000
  rpc = () => new Error('connect ECONNREFUSED')
  try {
    const res = await get('stalecase', '/other')
    eq('stale: RPC down still serves the last CID', res.status, 200)
    eq('stale: from the same CID', res.headers.get('x-ipfs-cid')?.startsWith('bafy'), true)
    const miss = await get('neverseen', '/')
    eq('stale: an unknown name still 502s', miss.status, 502)
  } finally {
    Date.now = realNow
  }
}

// --- capped RPC replies ------------------------------------------------------
{
  let asked = 0
  rpc = () => { asked++; return { result: '0x' + 'ab'.repeat(4096) } }
  let err = null
  try {
    await ethCall('0x12345678', { rpc: ['https://a.invalid', 'https://b.invalid'], maxResponseBytes: 1024 })
  } catch (e) { err = e }
  eq('oversize reply: refused', err?.tooLarge, true)
  eq('oversize reply: not re-asked of the next node', asked, 1)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
