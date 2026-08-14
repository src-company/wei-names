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
const PAGE = '0x0000000000000000000000000000000000decafe'
const NOTAPAGE = '0x0000000000000000000000000000000000bad000'
const RESOLVER = '0x000000000000000000000000000000000000c0de'

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

globalThis.fetch = async (url, init) => {
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

routes = nameRoutes(1, RESOLVER, {
  [`${RESOLVER}:${RESOLVE_MODE}`]: mode('5219'),
  [`${RESOLVER}:${REQUEST}`]: RET_IMMUTABLE,
})
let res = await get('zswap.wei.limo/')
eq('5219 name: 200', res.status, 200)
eq('5219 name: body from the contract', await res.text(), '<!doctype html><h1>hi</h1>')
eq('5219 name: content-type from the contract', res.headers.get('content-type'), 'text/html; charset=utf-8')
// Rule 3: the header is the contract's, not the gateway's.
eq('5219 name: cache-control from the contract', res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
eq('5219 name: nosniff', res.headers.get('x-content-type-options'), 'nosniff')
eq('5219 name: records the contract served', res.headers.get('x-wns-contract'), RESOLVER)
eq('5219 name: no redirect to a web3:// gateway', res.headers.get('location'), null)

// --- 2. Rule 2: an address label skips WNS entirely -------------------------

routes = {
  [`${PAGE}:${RESOLVE_MODE}`]: mode('5219'),
  [`${PAGE}:${REQUEST}`]: RET_IMMUTABLE,
}
res = await get(PAGE + '.wei.limo/')
eq('address label: 200', res.status, 200)
eq('address label: serves that contract', res.headers.get('x-wns-contract'), PAGE)
eq('address label: never touches the registry', calls.some((c) => c.to === WNS), false)

// --- 3. deep paths reach the contract as ERC-5219 resource segments ---------

routes = nameRoutes(2, RESOLVER, {
  [`${RESOLVER}:${RESOLVE_MODE}`]: mode('5219'),
  [`${RESOLVER}:${REQUEST}`]: RET_IMMUTABLE,
})
res = await get('paths.wei.limo/tokenlist.json?v=2')
const requestCall = calls.find((c) => c.selector === REQUEST)
eq('deep path: 200', res.status, 200)
// 'tokenlist.json' and the query pair 'v'/'2', hex-encoded in the calldata.
eq('deep path: segment in calldata', requestCall.data.includes('746f6b656e6c6973742e6a736f6e'), true)
eq('deep path: query key in calldata', requestCall.data.includes('76'.padEnd(64, '0')), true)

// --- 4. Rule 4 end to end: hostile headers never leave the gateway ----------

routes = nameRoutes(3, RESOLVER, {
  [`${RESOLVER}:${RESOLVE_MODE}`]: mode('5219'),
  [`${RESOLVER}:${REQUEST}`]: RET_HOSTILE_HEADERS,
})
res = await get('evil.wei.limo/')
eq('hostile: no Set-Cookie', res.headers.get('set-cookie'), null)
eq('hostile: no Location', res.headers.get('location'), null)
eq('hostile: no X-Evil', res.headers.get('x-evil'), null)
eq('hostile: content-type still honoured', res.headers.get('content-type'), 'application/json')
eq('hostile: cache-control still honoured', res.headers.get('cache-control'), 'public, max-age=300')

// --- 5. ERC-8244 html() when there is no 4804 mode --------------------------

routes = nameRoutes(4, PAGE, {
  [`${PAGE}:${RESOLVE_MODE}`]: '0x',
  [`${PAGE}:${HTML}`]: RET_HTML,
})
res = await get('legacy.wei.limo/')
eq('html(): 200', res.status, 200)
eq('html(): body', await res.text(), '<html>ok</html>')
eq('html(): served as html', res.headers.get('content-type'), 'text/html; charset=utf-8')
eq('html(): conservative default cache', res.headers.get('cache-control'), 'public, max-age=300')
// The probe that classified it is also the read that served it.
eq('html(): read exactly once', calls.filter((c) => c.selector === HTML).length, 1)

// --- 6. auto/manual still go to the web3:// gateway -------------------------

routes = nameRoutes(5, PAGE, { [`${PAGE}:${RESOLVE_MODE}`]: mode('manual') })
res = await get('manual.wei.limo/x')
eq('manual mode: 302', res.status, 302)
eq('manual mode: to the web3 gateway', res.headers.get('location'), `https://${PAGE}.1.w3link.io/x`)

// --- 7. a contract that is not a page falls through -------------------------

routes = nameRoutes(6, PAGE, { [`${PAGE}:${HTML}`]: 'revert' })
res = await get('eoa.wei.limo/')
eq('not a page: 404', res.status, 404)

routes = { [`${NOTAPAGE}:${HTML}`]: 'revert' }
res = await get(NOTAPAGE + '.wei.limo/')
eq('address label, not a page: 404', res.status, 404)
eq('address label, not a page: says why', (await res.text()).includes('not an on-chain page'), true)

// --- 8. Rule 3 corollary: RPC failure is a 502, never something cached ------

routes = nameRoutes(7, RESOLVER, {
  [`${RESOLVER}:${RESOLVE_MODE}`]: mode('5219'),
  [`${RESOLVER}:${REQUEST}`]: 'down',
})
res = await get('broken.wei.limo/')
eq('rpc down: 502', res.status, 502)
eq('rpc down: not cacheable', res.headers.get('cache-control'), 'no-store')

// --- 9. a null-body status with a body attached must not throw --------------

// Same fixture, status word patched 200 -> 204. `new Response(body, {status:204})`
// throws, so an unguarded gateway would 500 on a contract that does this.
const RET_204 = '0x' + 'cc'.padStart(64, '0') + RET_IMMUTABLE.slice(66)
routes = nameRoutes(8, RESOLVER, {
  [`${RESOLVER}:${RESOLVE_MODE}`]: mode('5219'),
  [`${RESOLVER}:${REQUEST}`]: RET_204,
})
res = await get('nobody.wei.limo/')
eq('204 with a body: status kept', res.status, 204)
eq('204 with a body: body dropped, no throw', await res.text(), '')

// --- 10. HEAD, and unregistered names ---------------------------------------

routes = {
  [`${PAGE}:${RESOLVE_MODE}`]: mode('5219'),
  [`${PAGE}:${REQUEST}`]: RET_IMMUTABLE,
}
res = await get(PAGE + '.wei.limo/', 'HEAD')
eq('HEAD: 200', res.status, 200)
eq('HEAD: no body', await res.text(), '')
eq('HEAD: content-length of the page', res.headers.get('content-length'), '26')

routes = { [`${WNS}:${COMPUTE_ID}`]: uint(0) }
res = await get('nope.wei.limo/')
eq('unregistered: 404', res.status, 404)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
