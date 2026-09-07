// End-to-end freshness checks with a fake clock and an entirely local RPC.
import assert from 'node:assert/strict'
import { handleRequest } from './handler.js'

const word = n => BigInt(n).toString(16).padStart(64, '0')
const string = s => {
  const hex = Buffer.from(s).toString('hex')
  return word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
}
function page(body, policy) {
  const key = string('Cache-Control'), value = string(policy), bytes = string(body)
  const headers = word(1) + word(32) + word(64) + word(64 + key.length / 2) + key + value
  return '0x' + word(200) + word(96) + word(96 + bytes.length / 2) + bytes + headers
}
const mode = s => '0x' + Buffer.from(s).toString('hex').padEnd(64, '0')
let now = 1_000_000
const originalNow = Date.now, originalFetch = globalThis.fetch
Date.now = () => now
const states = new Map()
globalThis.fetch = async (_url, init) => {
  const { to, data } = JSON.parse(init.body).params[0]
  const st = states.get(to)
  assert(st, 'only configured fake addresses are read')
  if (st.fail) throw new Error('RPC offline')
  let result
  if (data === '0xdd473fae') { now += st.probeDelay || 0; result = mode(st.mode) }
  else {
    st.reads++
    now += st.readDelay || 0
    result = st.mode === '5219' ? page(st.body, st.policy) : '0x' + word(32) + string(st.body)
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
}
const env = { RPC_URLS: 'https://offline.invalid', RATE_LIMIT_RPS: 0 }
function fixture(policy = 'public, max-age=300', extra = {}) {
  const address = '0x' + (states.size + 1).toString(16).padStart(40, '0')
  const st = { body: 'old', policy, mode: '5219', reads: 0, ...extra }
  states.set(address, st)
  const get = (method = 'GET') => handleRequest(new Request(`https://${address}.wei.limo/`, { method }), env)
  return { st, get }
}
try {
  const { st, get } = fixture()
  const first = await get()
  assert.equal(first.headers.get('age'), '0')
  now += 299000
  st.body = 'new'
  const hit = await get()
  assert.equal(await hit.text(), 'old')
  assert.equal(hit.headers.get('cache-control'), 'public, max-age=300')
  assert.equal(hit.headers.get('age'), '299')
  assert.equal(st.reads, 1)
  assert.equal((await get('HEAD')).headers.get('age'), '299')
  now += 1000
  assert.equal(await (await get()).text(), 'new')
  assert.equal(st.reads, 2)
  now += 300000
  st.fail = true
  assert.equal((await get()).status, 502, 'expired entries cannot mask RPC failure')

  for (const policy of [
    'max-age=300, s-maxage=0', 'max-age=300, no-store', 'max-age=300, private',
    'max-age=300, s-maxage=0, ext="https://example.com"', 'no-store, ext="a:b"',
    'no-store\r\nX-Evil: 1',
  ]) {
    const f = fixture(policy)
    await f.get(); f.st.body = 'new'
    assert.equal(await (await f.get()).text(), 'new')
    assert.equal(f.st.reads, 2, policy)
  }
  for (const policy of ['max-age=300, s-maxage=2', 's-maxage=2', 'max-age=0, s-maxage=2']) {
    const f = fixture(policy)
    await f.get(); f.st.body = 'new'; now += 1000
    assert.equal(await (await f.get()).text(), 'old')
    now += 1000
    assert.equal(await (await f.get()).text(), 'new')
  }

  const html = fixture('', { mode: '', readDelay: 1500 })
  const prefetched = await html.get()
  assert.equal(prefetched.headers.get('age'), '2', 'prefetched HTML carries read time, conservatively rounded')
  now += 1000
  assert.equal((await html.get('HEAD')).headers.get('age'), '3')
  assert.equal(html.st.reads, 1)

  // Reclassification can wait for RPC; its earlier timestamp must not be used
  // to look up a page that expires while resolution is in flight.
  const slow = fixture('max-age=65')
  await slow.get()
  now += 61000 // resolution TTL elapsed, page TTL not yet elapsed
  slow.st.probeDelay = 5000; slow.st.body = 'new'
  assert.equal(await (await slow.get()).text(), 'new')
  assert.equal(slow.st.reads, 2)
  console.log('Cache policy regressions passed (Age, shared directives, GET/HEAD, expiry, failure, slow resolution).')
} finally {
  Date.now = originalNow
  globalThis.fetch = originalFetch
}
