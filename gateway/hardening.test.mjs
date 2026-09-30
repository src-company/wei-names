// Regressions for the gateway's cost and failure rules: forged hosts cost no
// RPC, a revert is asked once, a broken or unreachable node is never read as
// an empty answer. Stubbed fetch; no network.

import { handleRequest } from './handler.js'
import { ethCall, resolveMode } from './wns.js'

let pass = 0, fail = 0
const eq = (label, got, want) => {
  if (got === want) { pass++; console.log('ok   ', label) }
  else { fail++; console.log('FAIL ', label, JSON.stringify(got), '!==', JSON.stringify(want)) }
}

let calls = []
let reply = () => ({ result: '0x' })
globalThis.fetch = async (url, init) => {
  calls.push(String(url))
  const r = reply(String(url), init)
  if (r instanceof Error) throw r
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...r }), { status: 200 })
}

const ENV = { RPC_URLS: 'https://a.invalid,https://b.invalid,https://c.invalid', ZONE: 'wei.limo', RATE_LIMIT_RPS: 0 }
const get = (host) => handleRequest(new Request('https://' + host + '/'), ENV)

// --- forged hosts ------------------------------------------------------------
{
  calls = []
  const res = await get('a..wei.limo')
  eq('empty label: 404', res.status, 404)
  eq('empty label: no rpc', calls.length, 0)
}
calls = []
{
  const res = await handleRequest(new Request('https://' + 'a'.repeat(64) + '.wei.limo/'), ENV)
  eq('over-long label: 404', res.status, 404)
  eq('over-long label: no rpc', calls.length, 0)
}

// --- ethCall -----------------------------------------------------------------
const rpc = ['https://a.invalid', 'https://b.invalid', 'https://c.invalid']
calls = []
reply = () => ({ error: { code: 3, message: 'execution reverted' } })
{
  let err = null
  try { await ethCall('0x12345678', { rpc, contract: '0x' + '1'.repeat(40) }) } catch (e) { err = e }
  eq('revert: thrown as an rpc error', err?.rpcError, true)
  eq('revert: asked once, not once per node', calls.length, 1)
}

calls = []
reply = (url) => (url.includes('a.invalid') ? {} : { result: '0x' + '00'.repeat(31) + '07' })
eq('missing result: next node answers', BigInt(await ethCall('0x12345678', { rpc: ['https://a.invalid', 'https://b.invalid'] })), 7n)

// --- resolveMode -------------------------------------------------------------
reply = () => ({ error: { code: 3, message: 'execution reverted' } })
eq('resolveMode: a revert means "not a web3 contract"', await resolveMode('0x' + '2'.repeat(40), { rpc: ['https://d.invalid'] }), '')
reply = () => new Error('connect ECONNREFUSED')
{
  let threw = false
  try { await resolveMode('0x' + '3'.repeat(40), { rpc: ['https://e.invalid'] }) } catch { threw = true }
  eq('resolveMode: an unreachable node throws (502), not ""', threw, true)
}

// --- ipfs fallbacks ------------------------------------------------------------
// A CID label skips the registry, so these need no rpc.
const CID = 'bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4'
let upstream = () => new Response('', { status: 404 })
const seen = []
globalThis.fetch = async (u, init) => {
  seen.push(String(u))
  const r = upstream(new URL(String(u)), init)
  if (r instanceof Error) throw r
  return r
}
const page = (host, env, nav = true) =>
  handleRequest(new Request('https://' + host, { headers: nav ? { 'sec-fetch-mode': 'navigate', accept: 'text/html' } : {} }),
    { ZONE: 'wei.limo', RATE_LIMIT_RPS: 0, GATEWAY_MODE: 'proxy', ...env })

{
  // Subdomain fleet rate-limited, the pinning node doesn't hold it
  upstream = (u) => new Response('', { status: u.host.endsWith('sub1.gw') ? 429 : 404 })
  const env = { IPFS_SUBDOMAIN_GATEWAY: 'sub1.gw', IPFS_PATH_GATEWAY: 'https://pin1.gw' }
  let res = await page(CID + '.wei.limo/', env)
  eq('unpinned page load: sent to the browser gateway', res.status, 302)
  eq('unpinned page load: at its own cid origin', res.headers.get('location'), `https://${CID}.ipfs.inbrowser.link/`)
  eq('unpinned page load: says why', res.headers.get('x-wns-fallback'), 'not-pinned')
  eq('unpinned page load: never cached', res.headers.get('cache-control'), 'no-store')
  res = await page(CID + '.wei.limo/app.js', env, false)
  eq('unpinned subresource: the upstream answer, no redirect', res.status, 404)
}
{
  // The pinning node is tried first (the fleet is benched) and misses; the next one has it
  upstream = (u) => new Response(u.host.endsWith('sub2.gw') ? 'bytes' : '', { status: u.host.endsWith('sub2.gw') ? 200 : 404 })
  const env = { IPFS_SUBDOMAIN_GATEWAY: 'sub2.gw', IPFS_PATH_GATEWAY: 'https://pin2.gw' }
  const first = upstream
  upstream = (u) => (u.host.endsWith('sub2.gw') ? new Response('', { status: 429 }) : first(u))
  await page(CID + '.wei.limo/x', env, false)   // benches sub2.gw
  upstream = first
  seen.length = 0
  const res = await page(CID + '.wei.limo/x', env, false)
  eq('path 404 is not final while others remain: asked next', res.status, 200)
  eq('path 404 is not final: pin node first, then the subdomain gateway',
    seen.map((u) => new URL(u).host.split('.').slice(-2).join('.')).join(','), 'pin2.gw,sub2.gw')
}
{
  upstream = () => new TypeError('fetch failed')
  const res = await page(CID + '.wei.limo/', { IPFS_SUBDOMAIN_GATEWAY: 'sub3.gw' })
  eq('every upstream unreachable: page load goes to the browser gateway', res.headers.get('x-wns-fallback'), 'unreachable')
}
{
  seen.length = 0
  upstream = () => new Response('ok', { status: 200 })
  await page(CID + '.wei.limo/', { IPFS_SUBDOMAIN_GATEWAY: 'inbrowser.link,sub4.gw' })
  eq('proxy never fetches the browser gateway (it serves a loader page)',
    seen.some((u) => u.includes('inbrowser.link')), false)
}
{
  const res = await page(CID + '.wei.limo/docs?x=1', { GATEWAY_MODE: 'redirect', IPFS_SUBDOMAIN_GATEWAY: 'inbrowser.link' })
  eq('redirect mode: the browser gateway is a plain subdomain target', res.headers.get('location'), `https://${CID}.ipfs.inbrowser.link/docs`)
}
{
  upstream = () => new Response('', { status: 503 })
  const res = await page(CID + '.wei.limo/off', { IPFS_BROWSER_GATEWAY: 'off', IPFS_SUBDOMAIN_GATEWAY: 'sub5.gw' })
  eq('browser fallback can be switched off', res.status, 503)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
