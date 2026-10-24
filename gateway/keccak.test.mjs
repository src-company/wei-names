// keccak-256 vectors, and the local computeId pinned to ids read from the
// mainnet registry — if either drifts, names resolve to the wrong token.

import { keccak256 } from './keccak.js'
import { localComputeId, normalizeName } from './wns.js'

let pass = 0, fail = 0
const eq = (label, got, want) => {
  if (got === want) { pass++; console.log('ok   ', label) }
  else { fail++; console.log('FAIL ', label, JSON.stringify(got), '!==', JSON.stringify(want)) }
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const utf8 = (s) => new TextEncoder().encode(s)

eq('keccak: empty', hex(keccak256(utf8(''))), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
eq('keccak: abc', hex(keccak256(utf8('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')

// computeId('<name>') on 0x0000000000696760E15f265e828DB644A0c242EB, 2026-10-24.
const ONCHAIN = {
  zswap: 'd3b4fffb6f68cf4b3cc6177e40489588b1f862a9aad19fa1b64eaee55ace74eb',
  '02.zswap': 'abebfa79a9959aaf7c875d1c01f3eccedc69c7167be94b2435bb32c2bc62cbd8',
  'ünïcödé': 'e2ae89dd223931e1b1fd4890eea4bc86b81909ae9d245211317612ad75d4ae12',
  ['q'.repeat(300)]: '5062236ead87b99aad60ce7e34f7f7113a6222aaadcc2765984f95f8966e6331',
}
for (const [name, id] of Object.entries(ONCHAIN)) {
  eq(`computeId: ${name.length > 20 ? '300-byte label (multi-block)' : name}`, localComputeId(normalizeName(name)).toString(16), id)
}
eq('computeId: case-insensitive like the contract', localComputeId('ZSWAP.wei'), localComputeId('zswap.wei'))
eq('computeId: the empty name is WEI_NODE', localComputeId('').toString(16), 'a82820059d5df798546bcc2985157a77c3eef25eba9ba01899927333efacbd6f')
eq('computeId: an empty label is what the contract reverts on', localComputeId('a..b.wei'), null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
