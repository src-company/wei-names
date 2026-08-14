// Run the real handler against the real chain and print what it would serve.
//
//   node live-check.mjs zswap.wei.limo
//   node live-check.mjs zswap.wei.limo/tokenlist.json 0xabc….wei.limo
//
// No stubs: this hits public RPCs (override with RPC_URLS) and does exactly
// what the deployed gateway does, so it's the check to run after touching
// handler.js / onchain.js, and after a contract deploy or a name repoint.
//
// Unlike `npm test`, this needs network and its output depends on chain state.

import { handleRequest } from './handler.js'

const targets = process.argv.slice(2)
if (!targets.length) {
  console.error('usage: node live-check.mjs <host[/path]> [host[/path] …]')
  process.exit(2)
}

// ZONE has to cover whatever was passed, so derive it from the arguments
// rather than making the caller set it.
const zones = [...new Set(targets.map((t) => t.split('/')[0].split('.').slice(-2).join('.')))]
const env = { ...process.env, ZONE: zones.join(',') }

let bad = 0
for (const target of targets) {
  const url = 'https://' + target + (target.includes('/') ? '' : '/')
  const started = Date.now()
  let res
  try {
    res = await handleRequest(new Request(url), env)
  } catch (e) {
    console.log(`\n${url}\n  THREW  ${e?.message || e}`)
    bad++
    continue
  }
  const body = res.body ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array()
  const ms = Date.now() - started

  console.log(`\n${url}`)
  console.log(`  ${res.status}  ${body.length.toLocaleString()} bytes  ${ms}ms`)
  for (const [k, v] of [...res.headers].sort()) console.log(`  ${k}: ${v}`)
  if (body.length) {
    const head = new TextDecoder().decode(body.subarray(0, 96)).replace(/\s+/g, ' ')
    console.log(`  body: ${head}…`)
  }

  // The two things most worth eyeballing, called out rather than left in the
  // header dump: whether the page claims to be immutable (an address surface
  // should, a name that follows the chain should not), and whether anything
  // the contract authored leaked past the whitelist.
  const cc = res.headers.get('cache-control') || ''
  if (res.headers.get('x-wns-contract')) {
    console.log(`  -> ${/immutable/.test(cc) ? 'IMMUTABLE (cache forever)' : 'mutable (' + cc + ')'}`)
  }
  const leaked = [...res.headers.keys()].filter(
    (k) =>
      !['content-type', 'cache-control', 'content-length', 'x-content-type-options', 'x-wns-name',
        'x-wns-contract', 'x-ipfs-cid', 'x-ipns-name', 'location', 'etag', 'last-modified'].includes(k),
  )
  if (leaked.length) {
    console.log(`  !! unexpected headers: ${leaked.join(', ')}`)
    bad++
  }
  if (res.status >= 500) bad++
}

console.log()
process.exit(bad ? 1 : 0)
