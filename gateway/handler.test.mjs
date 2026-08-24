// End-to-end handler tests against a stubbed JSON-RPC node.
//
// `globalThis.fetch` is replaced with a fake mainnet: it answers `eth_call` from
// a per-test routing table keyed by (to, selector) and records every call, so a
// test can assert not just the response but which calls were and weren't made.
// No network, no chain, no dependencies.

import { handleRequest } from './handler.js'

let pass = 0
let fail = 0
function eq(label, got, want) {
  const g = typeof got === 'object' ? JSON.stringify(got) : got
  const w = typeof want === 'object' ? JSON.stringify(want) : want
  if (g === w) {
    pass++
    console.log('ok   ', label)
  } else {
    fail++
    console.log('FAIL ', label, '\n  got ', g, '\n  want', w)
  }
}

// --- selectors + canned returns ---------------------------------------------

const COMPUTE_ID = '0xfb021939'
const CONTENTHASH = '0xcb323d76'
const RESOLVE = '0x4f896d4f'
const RESOLVE_MODE = '0xdd473fae'
const REQUEST = '0x1374c460'
const HTML = '0x33c34ac3'

const WNS = '0x0000000000696760e15f265e828db644a0c242eb'
// The page cache is keyed by address+path and lives for as long as the
// contract's Cache-Control says, so each scenario needs its own address —
// otherwise scenario 2 is served scenario 1's cached body. `addr(n)` keeps them
// distinct and makes that dependency explicit rather than accidental.
const addr = (n) => '0x' + n.toString(16).padStart(40, '0')
// R* = a resolver-ish 5219 contract, P* = a page, N* = not a page.
// The suffix is the scenario number.
const R1 = addr(0xc0de01)
const P2 = addr(0xdeca02)
const R3 = addr(0xc0de03)
const R4 = addr(0xc0de04)
const P5 = addr(0xdeca05)
const P6 = addr(0xdeca06)
const P7 = addr(0xdeca07)
const N7 = addr(0xbad07)
const R8 = addr(0xc0de08)
const R9 = addr(0xc0de09)
const P10 = addr(0xdeca10)

const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const uint = (n) => '0x' + n.toString(16).padStart(64, '0')
const addressWord = (a) => '0x' + word(a)
// bytes32 of an ascii tag, left-aligned, as ERC-4804 resolveMode() returns it.
const mode = (tag) =>
  '0x' + [...tag].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0')

// (200, '<!doctype html><h1>hi</h1>', [Content-Type: text/html, Cache-Control: immutable])
const RET_IMMUTABLE =
  '0x00000000000000000000000000000000000000000000000000000000000000c8000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000001a3c21646f63747970652068746d6c3e3c68313e68693c2f68313e00000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000c436f6e74656e742d5479706500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000018746578742f68746d6c3b20636861727365743d7574662d38000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000d43616368652d436f6e74726f6c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000237075626c69632c206d61782d6167653d33313533363030302c20696d6d757461626c650000000000000000000000000000000000000000000000000000000000'
// (200, 'x'*100, [content-type: application/json, X-Evil, Set-Cookie, Location, Cache-Control: max-age=300])
const RET_HOSTILE_HEADERS =
  '0x00000000000000000000000000000000000000000000000000000000000000c80000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000647878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787878787800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002e000000000000000000000000000000000000000000000000000000000000003a000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000c636f6e74656e742d74797065000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000106170706c69636174696f6e2f6a736f6e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000006582d4576696c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001310000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000a5365742d436f6f6b6965000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003613d6200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000084c6f636174696f6e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001468747470733a2f2f6576696c2e6578616d706c6500000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000d43616368652d436f6e74726f6c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000137075626c69632c206d61782d6167653d33303000000000000000000000000000'
// abi.encode('<html>ok</html>')
const RET_HTML =
  '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000f3c68746d6c3e6f6b3c2f68746d6c3e0000000000000000000000000000000000'

// --- fake node ---------------------------------------------------------------

let calls = []
// `routes` maps `to:selector` to a hex string, a function of the calldata, or
// the string 'revert' / 'down'.
let routes = {}

// Non-RPC fetches (proxy mode reaching the IPFS gateway) are answered from
// `proxyResponse`, which a test sets to a function of the target URL. RPC calls
// are the ones carrying a JSON-RPC body.
let proxyResponse = null
globalThis.fetch = async (url, init) => {
  if (!init?.body) {
    if (!proxyResponse) throw new Error('unexpected non-RPC fetch: ' + url)
    return proxyResponse(String(url), init)
  }
  const req = JSON.parse(init.body)
  const to = req.params[0].to.toLowerCase()
  const data = req.params[0].data
  const selector = data.slice(0, 10)
  calls.push({ to, selector, data })

  let hit = routes[`${to}:${selector}`]
  if (hit === undefined) hit = '0x' // no code / no such function — empty return
  if (hit === 'down') throw new Error('connect ECONNREFUSED')
  if (hit === 'revert') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  const result = typeof hit === 'function' ? hit(data) : hit
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    headers: { 'content-type': 'application/json' },
  })
}

const ENV = { RPC_URLS: 'https://node.invalid', ZONE: 'wei.limo' }

async function get(hostAndPath, method = 'GET') {
  calls = []
  return handleRequest(new Request('https://' + hostAndPath, { method }), ENV)
}

// A name whose addr record is `address`. Distinct hostnames per test keep the
// handler's 60s resolution cache from leaking between them.
function nameRoutes(tokenId, address, extra = {}) {
  return {
    [`${WNS}:${COMPUTE_ID}`]: uint(tokenId),
    [`${WNS}:${RESOLVE}`]: addressWord(address),
    [`${WNS}:${CONTENTHASH}`]: '0x',
    ...extra,
  }
}

// --- 1. a name pointing at a 5219 contract is served from chain -------------

routes = nameRoutes(1, R1, {
  [`${R1}:${RESOLVE_MODE}`]: mode('5219'),
  [`${R1}:${REQUEST}`]: RET_IMMUTABLE,
})
let res = await get('zswap.wei.limo/')
eq('5219 name: 200', res.status, 200)
eq('5219 name: body from the contract', await res.text(), '<!doctype html><h1>hi</h1>')
eq('5219 name: content-type from the contract', res.headers.get('content-type'), 'text/html; charset=utf-8')
// Rule 3: the header is the contract's, not the gateway's.
eq('5219 name: cache-control from the contract', res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
eq('5219 name: nosniff', res.headers.get('x-content-type-options'), 'nosniff')
eq('5219 name: records the contract served', res.headers.get('x-wns-contract'), R1)
eq('5219 name: no redirect to a web3:// gateway', res.headers.get('location'), null)

// --- 2. Rule 2: an address label skips WNS entirely -------------------------

routes = {
  [`${P2}:${RESOLVE_MODE}`]: mode('5219'),
  [`${P2}:${REQUEST}`]: RET_IMMUTABLE,
}
res = await get(P2 + '.wei.limo/')
eq('address label: 200', res.status, 200)
eq('address label: serves that contract', res.headers.get('x-wns-contract'), P2)
eq('address label: never touches the registry', calls.some((c) => c.to === WNS), false)

// --- 3. deep paths reach the contract as ERC-5219 resource segments ---------

routes = nameRoutes(2, R3, {
  [`${R3}:${RESOLVE_MODE}`]: mode('5219'),
  [`${R3}:${REQUEST}`]: RET_IMMUTABLE,
})
res = await get('paths.wei.limo/tokenlist.json?v=2')
const requestCall = calls.find((c) => c.selector === REQUEST)
eq('deep path: 200', res.status, 200)
// 'tokenlist.json' and the query pair 'v'/'2', hex-encoded in the calldata.
eq('deep path: segment in calldata', requestCall.data.includes('746f6b656e6c6973742e6a736f6e'), true)
eq('deep path: query key in calldata', requestCall.data.includes('76'.padEnd(64, '0')), true)

// --- 4. Rule 4 end to end: hostile headers never leave the gateway ----------

routes = nameRoutes(3, R4, {
  [`${R4}:${RESOLVE_MODE}`]: mode('5219'),
  [`${R4}:${REQUEST}`]: RET_HOSTILE_HEADERS,
})
res = await get('evil.wei.limo/')
eq('hostile: no Set-Cookie', res.headers.get('set-cookie'), null)
eq('hostile: no Location', res.headers.get('location'), null)
eq('hostile: no X-Evil', res.headers.get('x-evil'), null)
eq('hostile: content-type still honoured', res.headers.get('content-type'), 'application/json')
eq('hostile: cache-control still honoured', res.headers.get('cache-control'), 'public, max-age=300')

// --- 5. ERC-8244 html() when there is no 4804 mode --------------------------

routes = nameRoutes(4, P5, {
  [`${P5}:${RESOLVE_MODE}`]: '0x',
  [`${P5}:${HTML}`]: RET_HTML,
})
res = await get('legacy.wei.limo/')
eq('html(): 200', res.status, 200)
eq('html(): body', await res.text(), '<html>ok</html>')
eq('html(): served as html', res.headers.get('content-type'), 'text/html; charset=utf-8')
eq('html(): conservative default cache', res.headers.get('cache-control'), 'public, max-age=300')
// The probe that classified it is also the read that served it.
eq('html(): read exactly once', calls.filter((c) => c.selector === HTML).length, 1)

// --- 6. auto/manual still go to the web3:// gateway -------------------------

routes = nameRoutes(5, P6, { [`${P6}:${RESOLVE_MODE}`]: mode('manual') })
res = await get('manual.wei.limo/x')
eq('manual mode: 302', res.status, 302)
eq('manual mode: to the web3 gateway', res.headers.get('location'), `https://${P6}.1.w3link.io/x`)

// --- 7. a contract that is not a page falls through -------------------------

routes = nameRoutes(6, P7, { [`${P7}:${HTML}`]: 'revert' })
res = await get('eoa.wei.limo/')
eq('not a page: 404', res.status, 404)

routes = { [`${N7}:${HTML}`]: 'revert' }
res = await get(N7 + '.wei.limo/')
eq('address label, not a page: 404', res.status, 404)
eq('address label, not a page: says why', (await res.text()).includes('not an on-chain page'), true)

// --- 8. Rule 3 corollary: RPC failure is a 502, never something cached ------

routes = nameRoutes(7, R8, {
  [`${R8}:${RESOLVE_MODE}`]: mode('5219'),
  [`${R8}:${REQUEST}`]: 'down',
})
res = await get('broken.wei.limo/')
eq('rpc down: 502', res.status, 502)
eq('rpc down: not cacheable', res.headers.get('cache-control'), 'no-store')

// --- 9. a null-body status with a body attached must not throw --------------

// Same fixture, status word patched 200 -> 204. `new Response(body, {status:204})`
// throws, so an unguarded gateway would 500 on a contract that does this.
const RET_204 = '0x' + 'cc'.padStart(64, '0') + RET_IMMUTABLE.slice(66)
routes = nameRoutes(8, R9, {
  [`${R9}:${RESOLVE_MODE}`]: mode('5219'),
  [`${R9}:${REQUEST}`]: RET_204,
})
res = await get('nobody.wei.limo/')
eq('204 with a body: status kept', res.status, 204)
eq('204 with a body: body dropped, no throw', await res.text(), '')

// --- 10. HEAD, and unregistered names ---------------------------------------

routes = {
  [`${P10}:${RESOLVE_MODE}`]: mode('5219'),
  [`${P10}:${REQUEST}`]: RET_IMMUTABLE,
}
res = await get(P10 + '.wei.limo/', 'HEAD')
eq('HEAD: 200', res.status, 200)
eq('HEAD: no body', await res.text(), '')
eq('HEAD: content-length of the page', res.headers.get('content-length'), '26')

routes = { [`${WNS}:${COMPUTE_ID}`]: uint(0) }
res = await get('nope.wei.limo/')
eq('unregistered: 404', res.status, 404)


// --- 11. the page cache: a second read costs no RPC -------------------------

const R11 = addr(0xc0de11)
routes = nameRoutes(11, R11, {
  [`${R11}:${RESOLVE_MODE}`]: mode('5219'),
  [`${R11}:${REQUEST}`]: RET_IMMUTABLE,
})
res = await get('cached.wei.limo/')
eq('cache: first read is a 200', res.status, 200)
const firstCalls = calls.length
res = await get('cached.wei.limo/')
eq('cache: second read still 200', res.status, 200)
eq('cache: second read is identical', await res.text(), '<!doctype html><h1>hi</h1>')
eq('cache: first read did hit the chain', firstCalls > 0, true)
// The whole point: an immutable page is read once, not once per request.
eq('cache: second read makes zero eth_calls', calls.length, 0)

// A different path is a different response, so it must not be served the
// cached body for `/`.
res = await get('cached.wei.limo/other')
eq('cache: a different path re-reads', calls.filter((c) => c.selector === REQUEST).length, 1)

// --- 12. a page that forbids caching is re-read every time ------------------

// (200, 'fresh', [Cache-Control: no-store])
const RET_NOSTORE =
  '0x00000000000000000000000000000000000000000000000000000000000000c8000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000566726573680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000d43616368652d436f6e74726f6c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000086e6f2d73746f7265000000000000000000000000000000000000000000000000'
const R12 = addr(0xc0de12)
routes = nameRoutes(12, R12, {
  [`${R12}:${RESOLVE_MODE}`]: mode('5219'),
  [`${R12}:${REQUEST}`]: RET_NOSTORE,
})
res = await get('nostore.wei.limo/')
eq('no-store: served', await res.text(), 'fresh')
eq('no-store: header passed through', res.headers.get('cache-control'), 'no-store')
res = await get('nostore.wei.limo/')
eq('no-store: re-read, not cached', calls.filter((c) => c.selector === REQUEST).length, 1)

// --- 13. single-flight: a herd on a cold page is one RPC chain --------------

const R13 = addr(0xc0de13)
routes = nameRoutes(13, R13, {
  [`${R13}:${RESOLVE_MODE}`]: mode('5219'),
  [`${R13}:${REQUEST}`]: RET_IMMUTABLE,
})
calls = []
const herd = await Promise.all(
  Array.from({ length: 25 }, () => handleRequest(new Request('https://herd.wei.limo/'), ENV)),
)
eq('herd: every request served', herd.every((r) => r.status === 200), true)
// Without coalescing this is 25 resolutions and 25 page reads.
eq('herd: one computeId for 25 requests', calls.filter((c) => c.selector === COMPUTE_ID).length, 1)
eq('herd: one page read for 25 requests', calls.filter((c) => c.selector === REQUEST).length, 1)

// --- 14. depth guard: only what TLS could never reach is refused ------------

// `nosuch` has no wildcard cert, so this host can never have arrived through
// DNS + TLS. Deliberately NOT 02.zswap.wei.limo: that reads like a scan but is
// a real versioned build behind a real *.zswap.wei.limo cert, and using it as
// the junk example here is what made the guard drop a live name.
routes = {}
res = await get('02.nosuch.wei.limo/')
// It reaches the registry and 404s from there, not from a hardcoded list.
eq('depth: an unregistered sub-subdomain 404s', res.status, 404)
eq('depth: and it asked the chain first', calls.length > 0, true)

// A numeric label under any parent is the shape of a version scan AND of a real
// versioned build, so the guard must not judge it by shape. It may still 404 —
// but only after asking the chain. Refused-before-RPC is the bug; "asked and
// found nothing" is correct.
routes = {}
res = await get('02.zswap.wei.limo/')
eq('depth: a numeric label still reaches RPC', calls.length > 0, true)

// Three labels cannot be secured by any wildcard cert, so they are refused for
// free rather than costing a lookup.
routes = {}
res = await get('a.b.c.wei.limo/')
eq('depth: three labels 404', res.status, 404)
eq('depth: three labels make no eth_call', calls.length, 0)
// The refusal must not be cacheable. A cacheable error outlives the bug that
// produced it: the 300s max-age this once carried kept serving 404s from
// browser caches after the server itself was already fixed.
eq('depth: the refusal is not cacheable', res.headers.get('cache-control'), 'no-store')

// A registered sub-subdomain resolves on the chain's say-so.
const P14 = addr(0xdeca14)
routes = nameRoutes(14, P14, {
  [`${P14}:${RESOLVE_MODE}`]: mode('5219'),
  [`${P14}:${REQUEST}`]: RET_IMMUTABLE,
})
res = await get('alice.id.wei.limo/')
eq('depth: a registered sub-subdomain resolves', res.status, 200)

// A dotted name is an ordinary name, not a suspicious one. token.list.wei is
// the README's own example and was collateral damage from the allowlist that
// used to live here; there is no list any more, so nothing to fall off.
const P15 = addr(0xdeca15)
routes = nameRoutes(15, P15, {
  [`${P15}:${RESOLVE_MODE}`]: mode('5219'),
  [`${P15}:${REQUEST}`]: RET_IMMUTABLE,
})
res = await get('token.list.wei.limo/')
eq('depth: a dotted name resolves', res.status, 200)

// No env var can reintroduce the allowlist — the stale one on the running
// service is what kept enforcing it after the code stopped declaring it.
calls = []
res = await handleRequest(new Request('https://token.list.wei.limo/x'), { ...ENV, SUBDOMAIN_PARENTS: 'id' })
eq('depth: a stale SUBDOMAIN_PARENTS env var is inert', res.status, 200)

// --- proxy mode --------------------------------------------------------------

const PROXY_ENV = { ...ENV, GATEWAY_MODE: 'proxy' }
// An ipfs contenthash (ENSIP-7 0xe3 + CIDv1) so the name resolves to a gateway
// target rather than a contract page.
const IPFS_CH =
  '0x0000000000000000000000000000000000000000000000000000000000000020' +
  '0000000000000000000000000000000000000000000000000000000000000026' +
  'e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f' +
  '0000000000000000000000000000000000000000000000000000'
function ipfsName(tokenId) {
  return {
    [`${WNS}:${COMPUTE_ID}`]: uint(tokenId),
    [`${WNS}:${RESOLVE}`]: addressWord('0x' + '00'.repeat(20)),
    [`${WNS}:${CONTENTHASH}`]: IPFS_CH,
  }
}
async function proxyGet(hostAndPath, method = 'GET') {
  calls = []
  return handleRequest(new Request('https://' + hostAndPath, { method }), PROXY_ENV)
}

// A compressed upstream must not have its (compressed) content-length forwarded
// on top of the body fetch() already decoded — clients truncate there.
routes = ipfsName(20)
proxyResponse = async () =>
  new Response('x'.repeat(5000), {
    status: 200,
    headers: { 'content-type': 'text/html', 'content-length': '65', 'etag': '"abc"' },
  })
res = await proxyGet('p20.wei.limo/')
eq('proxy: serves upstream body', res.status, 200)
eq('proxy: does not forward content-length', res.headers.get('content-length'), null)
eq('proxy: keeps the safe subset', res.headers.get('etag'), '"abc"')
eq('proxy: body is intact', (await res.text()).length, 5000)

// An upstream failure must not be cacheable.
routes = ipfsName(21)
proxyResponse = async () => new Response('bad gateway', { status: 502 })
res = await proxyGet('p21.wei.limo/')
eq('proxy: upstream 5xx is not cached', res.headers.get('cache-control'), 'no-store')
eq('proxy: upstream status passes through', res.status, 502)

// A healthy upstream still gets the normal edge TTL.
routes = ipfsName(22)
proxyResponse = async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/html' } })
res = await proxyGet('p22.wei.limo/')
eq('proxy: healthy upstream is cacheable', res.headers.get('cache-control'), 'public, max-age=300')

// A null-body status must not blow up the Response constructor.
routes = ipfsName(23)
proxyResponse = async () => new Response(null, { status: 204 })
res = await proxyGet('p23.wei.limo/')
eq('proxy: 204 does not throw', res.status, 204)

// An unreachable IPFS gateway is upstream trouble, not a bare 500.
routes = ipfsName(24)
proxyResponse = async () => { throw new Error('connect ECONNREFUSED') }
res = await proxyGet('p24.wei.limo/')
eq('proxy: dead gateway is a 502', res.status, 502)
eq('proxy: dead gateway is not cached', res.headers.get('cache-control'), 'no-store')
proxyResponse = null

// --- 404 cacheability --------------------------------------------------------

// The 404 a name gets in the seconds before its owner sets a contenthash must
// not be pinnable by a browser cache.
routes = {
  [`${WNS}:${COMPUTE_ID}`]: uint(25),
  [`${WNS}:${RESOLVE}`]: addressWord('0x' + '00'.repeat(20)),
  [`${WNS}:${CONTENTHASH}`]: '0x' + '00'.repeat(64),
}
res = await get('p25.wei.limo/')
eq('404: no content set is a 404', res.status, 404)
eq('404: and it is not cacheable', res.headers.get('cache-control'), 'no-store')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
