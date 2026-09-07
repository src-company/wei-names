import assert from 'node:assert/strict'
import { createClientIdentity } from './client-ip.js'
import { handleRequest, buckets } from './handler.js'
import worker from './worker.js'

const direct = createClientIdentity()
const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers })
const env = { RATE_LIMIT_RPS: 0.000001, RATE_LIMIT_BURST: 2 }
const web = headers => new Request('https://wei.limo/', { headers }) // apex costs no RPC
buckets.clear()
for (let n = 0; n < 6; n++) {
  const headers = Object.fromEntries(['cf-connecting-ip', 'true-client-ip', 'x-forwarded-for', 'x-real-ip']
    .map(key => [key, `198.51.100.${n + 1}`]))
  const clientIp = direct(req('::ffff:192.0.2.1', headers))
  assert.equal(clientIp, '192.0.2.1')
  assert.equal((await handleRequest(web(headers), env, { clientIp })).status, n < 2 ? 302 : 429)
}
assert.equal(direct(req('192.0.2.1')), direct(req('::ffff:192.0.2.1')))
assert.equal(direct(req('2001:db8::1')), '2001:db8::1')
assert.equal(direct(req(null)), 'unknown')
assert.equal((await handleRequest(web({}), env, { clientIp: direct(req('192.0.2.2')) })).status, 302)

// A bare handler caller has no authority to promote forwarding headers.
buckets.clear()
for (let n = 0; n < 4; n++) {
  assert.equal((await handleRequest(web({ 'cf-connecting-ip': `198.51.100.${n}` }), env)).status, n < 2 ? 302 : 429)
}

const proxied = createClientIdentity({ TRUSTED_PROXY_CIDRS: '10.0.0.0/24, 2001:db8:1::/48' })
for (const spoof of ['1.1.1.1', '2.2.2.2', '10.0.0.99']) {
  assert.equal(proxied(req('10.0.0.1', { 'x-forwarded-for': `${spoof}, 192.0.2.8, 10.0.0.2` })), '192.0.2.8')
}
assert.equal(proxied(req('192.0.2.8', { 'x-forwarded-for': '1.1.1.1' })), '192.0.2.8', 'direct bypass of proxy cannot supply XFF')
assert.equal(proxied(req('2001:db8:1::1', { 'x-forwarded-for': '2001:db8:2::2' })), '2001:db8:2::2')
for (const value of ['', 'not-an-ip', '192.0.2.1,', ['192.0.2.1']]) {
  assert.equal(proxied(req('10.0.0.1', { 'x-forwarded-for': value })), '10.0.0.1')
}
assert.equal(proxied(req('10.0.0.1', { 'cf-connecting-ip': '1.1.1.1' })), '10.0.0.1', 'other headers cannot override policy')
for (const config of ['garbage', '10.0.0.1/33', '10.0.0.1/-1', '10.0.0.1/24/1', '10.0.0.1/24junk']) {
  assert.throws(() => createClientIdentity({ TRUSTED_PROXY_CIDRS: config }))
}

// Worker identity is platform-supplied; unrelated XFF cannot rotate it.
buckets.clear()
for (let n = 0; n < 4; n++) {
  assert.equal((await worker.fetch(web({ 'cf-connecting-ip': '192.0.2.50', 'x-forwarded-for': `spoof-${n}` }), env)).status, n < 2 ? 302 : 429)
}
assert.equal((await worker.fetch(web({ 'cf-connecting-ip': '192.0.2.51' }), env)).status, 302)
console.log('Client identity regressions passed (direct Node, trusted proxy chains, malformed headers, Worker).')
