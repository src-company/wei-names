// Posts (posts/SPEC.md): byte formats, the index's validity rules, blob checks, the API and pages.
//
// Offline: Ethereum is a scripted list of logs plus a table of owners, Blobscan is a stub, and blob
// checks run the real vendored KZG (dapp/vendor/kzg.bundle.mjs), so a versioned hash here is the
// one mainnet would record.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blobVersionedHash } from '../dapp/vendor/kzg.bundle.mjs'
import { PostIndex, T_AUTHORIZED, T_PUBLISHED, T_REMOVED } from './posts.js'
import { serveNamePosts, servePostsHost, POST_CSP } from './posts-page.js'
import { decodeBlob, encodeBlob, encodePost, parsePost, postCid, postHash, postPath, MAX_POST_BYTES } from './posts-format.js'
import { renderMarkdown } from './markdown.js'
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

const POSTS = '0x00000000000000000000000000000000000b10b5'
const NFT = '0x0000000000696760e15f265e828db644a0c242eb'
const ALICE = '0x' + 'a1'.repeat(20)
const BOB = '0x' + 'b0'.repeat(20)
const PUBLISHER = '0x' + '9b'.repeat(20)
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0')
const token = (n) => '0x' + n.toString(16).padStart(64, '0')
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const T_ALICE = token(0xa11ce)
const T_SUB = token(0xb1061) // blog.alice.wei

// --- formats ----------------------------------------------------------------------------------

const first = encodePost({ title: 'Exploring the blobspace', body: '# Hi\n\nSome **bold** text, $x^2$, and <script>alert(1)</script>.' })
const firstHash = postHash(first)
const firstBlob = blobVersionedHash(encodeBlob([first]))
eq('format: a post parses', parsePost(first)?.title, 'Exploring the blobspace')
eq('format: its own blob carries exactly it', decodeBlob(encodeBlob([first])).map(hex), [hex(first)])
eq('format: a versioned hash starts with 0x01', firstBlob.slice(0, 4), '0x01')
eq('format: CID is the keccak multihash, raw codec', postCid(firstHash).startsWith('bafkrwi'), true)
eq('format: post path is id + slug', postPath(firstHash, 'Exploring the blobspace'), `/posts/${firstHash.slice(2, 14)}-exploring-the-blobspace`)
eq('format: not a post', parsePost(new TextEncoder().encode('{"v":2,"title":"x","body":""}')), null)
eq('format: empty title refused', parsePost(new TextEncoder().encode('{"v":1,"title":"  ","body":""}')), null)
eq('markdown: html is escaped, never passed through', renderMarkdown('<img src=x onerror=alert(1)>').includes('<img'), false)
eq('markdown: javascript: links stay text', renderMarkdown('[x](javascript:alert(1))').includes('href'), false)

// --- a scripted chain -------------------------------------------------------------------------

let head = 5 // each scripted log moves the head past itself
let logs = []
let owners = { [T_ALICE]: ALICE, [T_SUB]: BOB }
let active = { [T_ALICE]: true, [T_SUB]: true }
const names = { [T_ALICE]: 'alice.wei', [T_SUB]: 'blog.alice.wei' }
let logIndex = 0
let calls = 0

function log(block, topics, data = '0x') {
  head = Math.max(head, block + 2)
  logs.push({ address: POSTS, blockNumber: '0x' + block.toString(16), logIndex: '0x' + (logIndex++).toString(16), transactionHash: '0x' + word(block.toString(16) + logIndex), topics, data })
}
const authorize = (block, tok, hash, author, blob, publisher = PUBLISHER, fee = 0n) =>
  log(block, [T_AUTHORIZED, tok, hash, '0x' + word(author)], '0x' + word(blob) + word(publisher) + word(fee.toString(16)))
const published = (block, blob, publisher = PUBLISHER) => log(block, [T_PUBLISHED, blob, '0x' + word(publisher)], '0x' + word('0'))
const removed = (block, tok, hash, author) => log(block, [T_REMOVED, tok, hash, '0x' + word(author)])

async function rpc(method, params) {
  if (method === 'eth_blockNumber') return '0x' + head.toString(16)
  if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + (1_800_000_000 + Number(BigInt(params[0])) * 12).toString(16) }
  if (method === 'eth_getLogs') {
    const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock))
    return logs.filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to })
  }
  throw new Error('unexpected ' + method)
}
function encodeString(s) {
  const b = Buffer.from(s)
  return '0x' + word('20') + word(b.length.toString(16)) + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0')
}
async function call(to, data) {
  calls++
  const tok = '0x' + data.slice(10)
  if (data.startsWith('0x6352211e')) return owners[tok] ? '0x' + word(owners[tok]) : '0x'
  if (data.startsWith('0x4f896d4f')) return '0x' + word(active[tok] ? owners[tok] || '0' : '0')
  if (data.startsWith('0x465411c1')) return encodeString(names[tok] || '')
  throw new Error('unexpected call')
}

let clock = 1_800_000_000_000 + 100 * 12_000
let blobscan = {}
const fetchImpl = async (url) => {
  const m = /\/blobs\/(0x[0-9a-f]{64})\/data$/.exec(url)
  if (m && blobscan[m[1]]) return new Response(JSON.stringify(blobscan[m[1]]))
  return new Response('not found', { status: 404 })
}
let dir = await mkdtemp(join(tmpdir(), 'wei-posts-'))
const make = () => new PostIndex({
  contract: POSTS, nameNFT: NFT, fromBlock: 1, rpc, call, fetchImpl, now: () => clock, dir,
  blobSources: { blobscan: 'https://blobscan.test', beacons: [] }, ipfs: null,
})
let index = make()
const sync = async () => { clock += 61_000; return index.maybeSync() }
const shown = async (tok = T_ALICE) => (await index.postsFor(tok)).map((p) => [p.title, !!p.onchain])

// --- uploads ----------------------------------------------------------------------------------

eq('upload: not a post is refused', index.upload(new TextEncoder().encode('hello')).status, 400)
eq('upload: too big is refused', index.upload(new Uint8Array(MAX_POST_BYTES + 1)).status, 413)
eq('upload: a post is kept under its hash', index.upload(first, 'ip1'), { status: 200, hash: firstHash })
for (let i = 0; i < 19; i++) index.upload(encodePost({ title: 'junk ' + i, body: '' }), 'spammer')
eq('upload: unclaimed uploads are limited per client', index.upload(encodePost({ title: 'junk 20', body: '' }), 'spammer').status, 200)
eq('upload: … to 20 an hour', index.upload(encodePost({ title: 'junk 21', body: '' }), 'spammer').status, 429)

// --- validity ---------------------------------------------------------------------------------

eq('index: nothing known before any event', index.knows(T_ALICE), false)
authorize(10, T_ALICE, firstHash, ALICE, firstBlob, PUBLISHER, 1000n)
await sync()
eq('index: an authorization makes the name known', index.knows(T_ALICE), true)
eq('index: authorized, no blob yet: shown as pending', await shown(), [['Exploring the blobspace', false]])

published(12, firstBlob)
await sync()
eq('index: once its blob is published and checked, it is on Ethereum', await shown(), [['Exploring the blobspace', true]])
eq('index: listed for mirrors once', index.archive, [{ hash: firstHash, blob: firstBlob }])
eq('index: the post is dated by its blob', (await index.postsFor(T_ALICE))[0].time, 1_800_000_000 + 12 * 12)

// A claim on someone else's blob: authorized against a published blob that doesn't carry it.
const liar = encodePost({ title: 'Not in that blob', body: 'x' })
index.upload(liar, 'ip2')
authorize(13, T_ALICE, postHash(liar), ALICE, firstBlob)
await sync()
eq('index: a post its blob does not carry is never on Ethereum', (await shown()).find(([t]) => t === 'Not in that blob'), ['Not in that blob', false])

// Pending ends after a day without a blob.
clock += 86_400_000
await sync()
eq('index: an authorized post with no blob drops after a day', (await shown()).map(([t]) => t), ['Exploring the blobspace'])

// A sold name doesn't carry its previous owner's posts.
owners[T_ALICE] = BOB
clock += 61_000
eq('validity: a new owner does not inherit posts', await shown(), [])
owners[T_ALICE] = ALICE
clock += 61_000
eq('validity: back with its author, back on the page', await shown(), [['Exploring the blobspace', true]])

// An expired name (resolve() is zero) shows nothing.
active[T_ALICE] = false
clock += 61_000
eq('validity: an inactive name shows nothing', await shown(), [])
active[T_ALICE] = true
clock += 61_000

removed(20, T_ALICE, firstHash, ALICE)
await sync()
eq('validity: removed is hidden', await shown(), [])
authorize(21, T_ALICE, firstHash, ALICE, firstBlob)
await sync()
eq('validity: authorized again after removal, shown again', await shown(), [['Exploring the blobspace', true]])

// --- subnames, and blobs fetched from a source --------------------------------------------------

const second = encodePost({ title: 'A subname post', body: 'From blog.alice.wei.' })
const secondHash = postHash(second)
const secondBlob = blobVersionedHash(encodeBlob([second]))
authorize(30, T_SUB, secondHash, BOB, secondBlob)
published(31, secondBlob)
// A source that lies: right length, wrong bytes.
blobscan[secondBlob] = hex(encodeBlob([encodePost({ title: 'forged', body: '' })]))
await sync()
eq('blobs: a blob that does not match its versioned hash is refused', await shown(T_SUB), [])
blobscan[secondBlob] = hex(encodeBlob([second]))
clock += 3 * 60_000 // past the retry backoff
await sync()
eq('blobs: bytes nobody uploaded come out of the blob itself', await shown(T_SUB), [['A subname post', true]])

// --- persistence ------------------------------------------------------------------------------

await index.save()
index = make()
await index.load()
eq('persist: a restarted index has the same posts', await shown(), [['Exploring the blobspace', true]])
eq('persist: … and the same subname posts', await shown(T_SUB), [['A subname post', true]])

// --- HTTP -------------------------------------------------------------------------------------

const tokenOf = (name) => ({ 'alice.wei': T_ALICE, 'blog.alice.wei': T_SUB }[name] || token(0xdead))
const host = (path, init) => servePostsHost(index, new Request('https://posts.wei.domains' + path, init), new URL('https://posts.wei.domains' + path), { client: 'c', tokenOf })

let res = await host('/api/posts/recent')
let body = await res.json()
eq('api: recent lists both names', body.posts.map((p) => p.name).sort(), ['alice.wei', 'blog.alice.wei'])
eq('api: recent links subnames to the posts host', body.posts.find((p) => p.name === 'blog.alice.wei').url, `https://posts.wei.domains/blog.alice.wei${postPath(secondHash, 'A subname post')}`)
eq('api: readable from any origin', res.headers.get('access-control-allow-origin'), '*')
res = await host(`/api/posts/${firstHash}/raw`)
eq('api: raw bytes are the exact bytes', hex(new Uint8Array(await res.arrayBuffer())), hex(first))
res = await host(`/api/posts/${firstHash}`)
body = await res.json()
eq('api: a post lists its authorizations', body.authorizations.length, 2)
res = await host('/api/posts?after=0&limit=10')
eq('api: the mirror list', (await res.json()).posts.map((p) => p.hash), [firstHash, secondHash])
res = await host(`/api/authors/${ALICE}/paid`)
eq('api: fees paid, for refunds', (await res.json()).paid.map((p) => [p.fee, p.delivered]), [['1000', true]])
const third = encodePost({ title: 'Upload me', body: '' })
res = await host('/api/posts', { method: 'POST', body: third })
eq('api: upload returns the hash', (await res.json()).hash, postHash(third))
res = await host('/api/posts/preview', { method: 'POST', body: first })
eq('api: preview renders escaped markdown', (await res.json()).html.includes('&lt;script&gt;'), true)
eq('api: preflight', (await host('/api/posts', { method: 'OPTIONS' })).status, 204)

res = await host(`/blog.alice.wei${postPath(secondHash, 'A subname post')}`)
let page = await res.text()
eq('page: a subname post on the posts host', res.status, 200)
eq('page: no scripts may run', res.headers.get('content-security-policy'), POST_CSP)
eq('page: … title and byline', page.includes('A subname post') && page.includes('blog.alice.wei'), true)
res = await host('/alice.wei/')
page = await res.text()
eq('page: a name lists its posts', page.includes(postPath(firstHash, 'Exploring the blobspace')), true)
res = await host('/alice.wei/feed.xml')
eq('page: atom feed', (await res.text()).includes(`urn:wei-post:${firstHash}`), true)
eq('page: a bare name redirects to its folder', (await host('/alice.wei')).status, 301)
calls = 0
eq('page: a name with no posts 404s', (await host('/nobody.wei/')).status, 404)
eq('page: … without an RPC call', calls, 0)
res = await host(`/alice.wei${postPath(firstHash, 'Exploring the blobspace')}`)
page = await res.text()
eq('page: post body is escaped', page.includes('<script>alert'), false)
eq('page: on Ethereum shows its blob', page.includes(firstBlob.slice(0, 10)), true)

res = await serveNamePosts(index, { name: 'alice.wei', token: T_ALICE, path: '/', base: '' })
page = await res.text()
eq('name host: the name page links posts relatively', page.includes(`href="${postPath(firstHash, 'Exploring the blobspace')}"`), true)
eq('name host: unknown name answers null (the caller 404s as before)', await serveNamePosts(index, { name: 'x.wei', token: token(1), path: '/', base: '' }), null)

// --- the handler -------------------------------------------------------------------------------

const env = { POSTS_CONTRACT: POSTS, RATE_LIMIT_RPS: '0' }
res = await handleRequest(new Request('https://alice.wei.limo/', { method: 'POST', body: 'x' }), env)
eq('handler: POST is refused on name hosts', res.status, 405)
res = await handleRequest(new Request('https://posts.wei.domains/api/posts', { method: 'OPTIONS' }), env)
eq('handler: the posts host answers a preflight', res.status, 204)
res = await handleRequest(new Request('https://posts.wei.domains/api/posts', { method: 'POST', body: 'x' }), {})
eq('handler: without POSTS_CONTRACT the posts host is a name like any other', res.status, 405)

await rm(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
