// Used by test_poster.py: runs the gateway's post index (gateway/posts.js) against a local chain
// and prints what it shows for a name, so the end-to-end test can check the whole loop.
//   node index_check.mjs <rpc> <contract> <blobscan> <token> <owner> <post-bytes-hex>
import { PostIndex } from '../../gateway/posts.js'

const [rpcUrl, contract, blobscan, token, owner, postHex] = process.argv.slice(2)
const rpc = async (method, params) => {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message)
  return json.result
}
// The name's owner is the test's to say: ownerOf and resolve both answer it.
const word = '0x' + owner.slice(2).toLowerCase().padStart(64, '0')
const index = new PostIndex({
  contract, fromBlock: 1, nameNFT: '0x' + '0'.repeat(40), rpc, call: async () => word,
  blobSources: { blobscan, beacons: [] }, ipfs: null,
})
console.error(JSON.stringify(index.upload(Uint8Array.from(Buffer.from(postHex, 'hex')), 'test')))
console.error(JSON.stringify(await index.maybeSync()))
console.log(JSON.stringify(await index.postsFor('0x' + BigInt(token).toString(16).padStart(64, '0'))))
