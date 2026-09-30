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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
