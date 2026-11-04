// Posts on .wei names and subnames (posts/SPEC.md): text carried by EIP-4844 blobs and vouched for
// on WeiPosts by the name's owner.
//
// A fork of gwei-names' post index (their gateway/posts-store.js) for one long-running Node process
// instead of a Durable Object. The index is in memory, rebuilt from public data alone (the
// contract's events, the blobs they name, IPFS), and kept across restarts in POSTS_DIR when one is
// set. Every publisher's blobs count the same, and no blob source is taken on its word: a fetched
// blob is used only if its KZG commitment matches the versioned hash Ethereum recorded.
//
// Off unless POSTS_CONTRACT is set. A name the index has never seen an authorization for costs
// nothing to ask about, so a forged Host or path never buys an RPC call.

import { ethCall, rpcSend } from './wns.js'
import { keccak256 } from './keccak.js'
import { MAX_POST_BYTES, BLOB_BYTES, decodeBlob, encodeBlob, hexToBytes, parsePost, postCid, postHash } from './posts-format.js'

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const sig = (s) => '0x' + toHex(keccak256(new TextEncoder().encode(s)))

export const T_AUTHORIZED = sig('PostAuthorized(uint256,bytes32,address,bytes32,address,uint256)')
export const T_PUBLISHED = sig('BlobPublished(bytes32,address,uint256)')
export const T_REMOVED = sig('PostRemoved(uint256,bytes32,address)')
const SEL_OWNER_OF = sig('ownerOf(uint256)').slice(0, 10)
const SEL_RESOLVE = sig('resolve(uint256)').slice(0, 10) // zero unless the name (and every parent) is active
const SEL_FULL_NAME = sig('getFullName(uint256)').slice(0, 10)

const CONFIRMATIONS = 2n // index up to head - 2, so a one-block reorg can't leave a phantom event
const LOG_RANGE = 2000n // blocks per eth_getLogs; public RPCs cap ranges
const LOG_RANGES_PER_SYNC = 10
const SYNC_EVERY_MS = 60_000
const FORCED_SYNC_GAP_MS = 10_000 // POST /api/sync, at most this often
const PENDING_SECONDS = 86_400 // an authorized post shows for a day while it waits for its blob
const UPLOAD_TTL_SECONDS = 86_400 // uploaded bytes nobody authorized are dropped after this
const AUTHORIZED_TTL_SECONDS = 3 * 86_400 // authorized bytes that never reach a blob, after this
const MAX_UNCLAIMED_BYTES = 64 * 1024 * 1024
const UPLOADS_PER_HOUR = 20 // per client key; bytes an owner already authorized skip this
const OWNER_TTL_MS = 60_000
const NAME_TTL_MS = 86_400_000
const RECENT_TTL_MS = 30_000
const RECENT_PER_NAME = 2
const MAX_LIST = 200
const BLOB_FETCHES_PER_SYNC = 6
const REBUILDS_PER_SYNC = 12 // each is a KZG commitment, ~200 ms
const BLOB_MAX_TRIES = 60 // with the 6-hour backoff cap, about two weeks
const BLOB_TIMEOUT_MS = 15_000
const IPFS_TIMEOUT_MS = 8_000
const BEACON_GENESIS = 1606824023 // mainnet beacon genesis; slots are 12 s
export const DEFAULT_BLOB_SOURCES = {
  blobscan: 'https://api.blobscan.com',
  beacons: ['https://ethereum-beacon-api.publicnode.com'],
}
const DEFAULT_IPFS = 'https://ipfs.filebase.io'

const word = (hex, i) => hex.slice(2 + 64 * i, 2 + 64 * (i + 1))
const topicAddress = (t) => '0x' + t.slice(26).toLowerCase()

async function readCapped(res, cap) {
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function decodeString(data) {
  if (!data || data.length < 130) return ''
  const length = Number.parseInt(word(data, 1), 16)
  const hex = data.slice(130, 130 + 2 * length)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(hex))
  } catch {
    return ''
  }
}

let kzgModule
async function versionedHashOf(blob) {
  // The dapp's vendored KZG (dapp/vendor/kzg.bundle.mjs), loaded only once a blob needs checking.
  kzgModule ||= import('../dapp/vendor/kzg.bundle.mjs')
  return (await kzgModule).blobVersionedHash(blob)
}

export class PostIndex {
  // `rpc(method, params)` and `call(to, data)` talk to Ethereum; `fetchImpl` reaches blob sources
  // and IPFS; `dir` (Node only) keeps the index across restarts. Injected so tests run offline.
  constructor({ contract, fromBlock = 0, nameNFT, rpc, call, fetchImpl = fetch, now = () => Date.now(), dir = null,
    blobSources = DEFAULT_BLOB_SOURCES, ipfs = DEFAULT_IPFS, versionedHash = versionedHashOf }) {
    this.contract = contract.toLowerCase()
    this.nameNFT = nameNFT
    this.rpc = rpc
    this.call = call
    this.fetchImpl = fetchImpl
    this.now = now
    this.dir = dir
    this.blobSources = blobSources
    this.ipfs = ipfs
    this.versionedHash = versionedHash
    this.cursor = BigInt(fromBlock) - 1n
    this.auths = [] // every PostAuthorized, in chain order
    this.published = new Map() // blob -> its first BlobPublished { block, tx, publisher, order }
    this.removed = new Map() // `${token}|${hash}|${author}` -> order of the latest PostRemoved
    this.times = new Map() // block -> timestamp
    this.carried = new Map() // blob -> Set of post hashes it was checked to carry
    this.checked = new Map() // blob -> Set of claims it was checked against, carried or not
    this.archive = [] // { hash, blob } in the order posts were found in blobs (GET /api/posts)
    this.blobState = new Map() // blob -> { tries, next } while it can't be fetched
    this.bytes = new Map() // post hash -> { bytes, source: 'blob' | 'upload', at }
    this.byHash = new Map() // post hash -> its authorizations
    this.byToken = new Map() // token -> Set of post hashes
    this.byBlob = new Map() // blob -> Set of post hashes claimed for it
    this.owners = new Map() // token -> { owner, at }
    this.names = new Map() // token -> { name, at }
    this.uploads = new Map() // client key -> recent upload times
    this.lastSync = 0
    this.syncing = null
    this.loaded = null
    this.dirty = false
  }

  // --- events ---------------------------------------------------------------------------------

  apply(log) {
    const block = Number(BigInt(log.blockNumber))
    const order = block * 100_000 + Number(BigInt(log.logIndex))
    const [topic, a, b, c] = log.topics.map((t) => t.toLowerCase())
    const data = log.data.toLowerCase()
    if (topic === T_AUTHORIZED) {
      this.addAuth({
        token: a, hash: b, author: topicAddress(c), blob: '0x' + word(data, 0),
        publisher: '0x' + word(data, 1).slice(24), fee: BigInt('0x' + word(data, 2)).toString(),
        block, tx: log.transactionHash.toLowerCase(), order,
      })
    } else if (topic === T_PUBLISHED) {
      if (!this.published.has(a)) {
        this.published.set(a, { block, tx: log.transactionHash.toLowerCase(), publisher: topicAddress(b), order })
      }
    } else if (topic === T_REMOVED) {
      this.removed.set(`${a}|${b}|${topicAddress(c)}`, order)
    }
    return block
  }

  addAuth(auth) {
    this.auths.push(auth)
    const list = this.byHash.get(auth.hash) || []
    list.push(auth)
    this.byHash.set(auth.hash, list)
    if (!this.byToken.has(auth.token)) this.byToken.set(auth.token, new Set())
    this.byToken.get(auth.token).add(auth.hash)
    if (!this.byBlob.has(auth.blob)) this.byBlob.set(auth.blob, new Set())
    this.byBlob.get(auth.blob).add(auth.hash)
  }

  // Run a sync unless one ran in the last minute; never two at once.
  maybeSync(force = false) {
    if (this.syncing) return this.syncing
    const gap = force ? FORCED_SYNC_GAP_MS : SYNC_EVERY_MS
    if (this.now() - this.lastSync < gap) return Promise.resolve(false)
    this.syncing = (async () => {
      try {
        await this.load()
        await this.syncLogs()
        await this.checkBlobs()
        this.prune()
        await this.save()
        return true
      } catch (e) {
        console.error(JSON.stringify({ event: 'posts_sync_failed', error: e?.message || String(e) }))
        return false
      } finally {
        this.lastSync = this.now()
        this.syncing = null
      }
    })()
    return this.syncing
  }

  async syncLogs() {
    const head = BigInt(await this.rpc('eth_blockNumber', []))
    const target = head - CONFIRMATIONS
    let range = LOG_RANGE
    for (let n = 0; n < LOG_RANGES_PER_SYNC && this.cursor < target; n++) {
      const from = this.cursor + 1n
      const to = from + range - 1n < target ? from + range - 1n : target
      let logs
      try {
        logs = await this.rpc('eth_getLogs', [{
          address: this.contract,
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16),
          topics: [[T_AUTHORIZED, T_PUBLISHED, T_REMOVED]],
        }])
      } catch (e) {
        // Too many logs or too wide a range for this node: try a narrower one.
        if (range > 1n) { range /= 4n; if (range < 1n) range = 1n; continue }
        throw e
      }
      if (!Array.isArray(logs)) throw new Error('eth_getLogs: not a list')
      logs.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)))
      const blocks = new Set()
      for (const log of logs) {
        if (log.removed || String(log.address).toLowerCase() !== this.contract) continue
        blocks.add(this.apply(log))
      }
      for (const block of blocks) {
        if (this.times.has(block)) continue
        const b = await this.rpc('eth_getBlockByNumber', ['0x' + block.toString(16), false])
        this.times.set(block, Number(BigInt(b.timestamp)))
      }
      this.cursor = to
      this.dirty = true
      if (logs.length) this.recentCache = null
    }
  }

  // --- blobs ----------------------------------------------------------------------------------

  carry(blob, hash) {
    if (!this.carried.has(blob)) this.carried.set(blob, new Set())
    const set = this.carried.get(blob)
    if (set.has(hash)) return
    set.add(hash)
    this.archive.push({ hash, blob })
    this.recentCache = null
    this.dirty = true
  }

  isCarried(blob, hash) {
    return !!this.carried.get(blob)?.has(hash)
  }

  keep(hash, bytes, source) {
    const held = this.bytes.get(hash)
    if (held && (held.source === 'blob' || source !== 'blob')) return
    this.bytes.set(hash, { bytes, source, at: Math.floor(this.now() / 1000) })
    this.dirty = true
    this.writeBytes(hash, bytes)
  }

  // Each published blob is checked against every post claimed for it. A claim whose bytes the index
  // holds is checked by rebuilding that post's own blob (no network). The rest need the blob itself,
  // from Blobscan or a beacon node, kept only if it matches its versioned hash.
  async checkBlobs() {
    let fetches = 0, rebuilds = 0
    for (const [blob, claims] of this.byBlob) {
      const pub = this.published.get(blob)
      if (!pub) continue
      if (!this.checked.has(blob)) this.checked.set(blob, new Set())
      const checked = this.checked.get(blob)
      const open = [...claims].filter((h) => !checked.has(h))
      if (!open.length) continue
      const needBlob = []
      for (const hash of open) {
        const held = this.bytes.get(hash)
        if (!held || rebuilds >= REBUILDS_PER_SYNC) { needBlob.push(hash); continue }
        rebuilds++
        const own = encodeBlob([held.bytes])
        if (own && (await this.versionedHash(own)) === blob) {
          this.keep(hash, held.bytes, 'blob')
          this.carry(blob, hash)
          checked.add(hash)
          this.dirty = true
        } else {
          needBlob.push(hash) // maybe it shares a blob with other posts
        }
      }
      if (!needBlob.length) continue
      const state = this.blobState.get(blob) || { tries: 0, next: 0 }
      if (state.tries >= BLOB_MAX_TRIES || state.next > this.now() || fetches >= BLOB_FETCHES_PER_SYNC) continue
      fetches++
      const bytes = await this.fetchBlob(blob, this.times.get(pub.block))
      if (bytes) {
        const inside = new Map(decodeBlob(bytes).map((entry) => [postHash(entry), entry]))
        for (const hash of needBlob) {
          const entry = inside.get(hash)
          if (entry && parsePost(entry)) {
            this.keep(hash, entry, 'blob')
            this.carry(blob, hash)
          }
          checked.add(hash)
        }
        this.blobState.delete(blob)
        this.dirty = true
        continue
      }
      // No source has the blob (beacon nodes keep them ~18 days). Bytes from IPFS, where anyone can
      // pin a post under its hash, let the next sync rebuild the post's own blob instead.
      state.tries++
      state.next = this.now() + Math.min(6 * 3600_000, 60_000 * 2 ** state.tries)
      this.blobState.set(blob, state)
      for (const hash of needBlob) if (!this.bytes.has(hash)) await this.fetchIpfs(hash)
    }
  }

  async getJson(url, cap) {
    try {
      const res = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'wei.domains posts index' },
        signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
      })
      if (!res.ok) { res.body?.cancel().catch(() => {}); return null }
      const body = await readCapped(res, cap)
      return body ? JSON.parse(new TextDecoder().decode(body)) : null
    } catch {
      return null
    }
  }

  async fetchBlob(blob, time) {
    const cap = 2 * BLOB_BYTES * 2 + 4096
    const attempts = []
    if (this.blobSources.blobscan) attempts.push(() => this.getJson(`${this.blobSources.blobscan}/blobs/${blob}/data`, cap))
    if (Number.isFinite(time)) {
      const slot = Math.floor((time - BEACON_GENESIS) / 12)
      for (const beacon of this.blobSources.beacons || []) {
        attempts.push(async () => (await this.getJson(`${beacon}/eth/v1/beacon/blobs/${slot}?versioned_hashes=${blob}`, cap))?.data?.[0])
      }
    }
    for (const attempt of attempts) {
      const hex = await attempt()
      if (typeof hex !== 'string' || hex.length !== 2 + 2 * BLOB_BYTES || !/^0x[0-9a-fA-F]+$/.test(hex)) continue
      const bytes = hexToBytes(hex.slice(2))
      if ((await this.versionedHash(bytes)) === blob) return bytes
      console.error(JSON.stringify({ event: 'posts_blob_mismatch', blob }))
    }
    return null
  }

  async fetchIpfs(hash) {
    if (!this.ipfs) return
    try {
      const res = await this.fetchImpl(`${this.ipfs}/ipfs/${postCid(hash)}`, { signal: AbortSignal.timeout(IPFS_TIMEOUT_MS) })
      if (!res.ok) { res.body?.cancel().catch(() => {}); return }
      const bytes = await readCapped(res, MAX_POST_BYTES)
      if (bytes && postHash(bytes) === hash && parsePost(bytes)) this.keep(hash, bytes, 'upload')
    } catch {}
  }

  // Bytes that never made it into a blob expire: a day if nobody authorized them, three if someone
  // did. Posts a blob carries are kept for good.
  prune() {
    const now = Math.floor(this.now() / 1000)
    for (const [hash, held] of this.bytes) {
      if (held.source === 'blob') continue
      const ttl = this.byHash.has(hash) ? AUTHORIZED_TTL_SECONDS : UPLOAD_TTL_SECONDS
      if (now - held.at > ttl) {
        this.bytes.delete(hash)
        this.dirty = true
        this.removeBytes(hash)
      }
    }
  }

  // --- uploads --------------------------------------------------------------------------------

  // Anyone may upload a post's bytes: what the owner authorized is their hash, so the source doesn't
  // matter. Bytes nobody authorized yet are capped per client and in total.
  upload(bytes, client = 'unknown') {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_POST_BYTES) return { status: 413, error: 'A post is at most 126,968 bytes.' }
    if (!parsePost(bytes)) return { status: 400, error: 'Not a post: expected {"v":1,"title":…,"body":…}.' }
    const hash = postHash(bytes)
    if (this.bytes.has(hash)) return { status: 200, hash }
    if (!this.byHash.has(hash)) {
      const now = this.now()
      const recent = (this.uploads.get(client) || []).filter((t) => now - t < 3600_000)
      if (recent.length >= UPLOADS_PER_HOUR) return { status: 429, error: 'Too many uploads from here; try again later.' }
      let unclaimed = 0
      for (const [h, held] of this.bytes) if (held.source !== 'blob' && !this.byHash.has(h)) unclaimed += held.bytes.length
      if (unclaimed + bytes.length > MAX_UNCLAIMED_BYTES) return { status: 503, error: 'Upload space is full; try again later.' }
      recent.push(now)
      this.uploads.set(client, recent)
      if (this.uploads.size > 10_000) this.uploads.delete(this.uploads.keys().next().value)
    }
    this.keep(hash, bytes, 'upload')
    return { status: 200, hash }
  }

  // --- reads ----------------------------------------------------------------------------------

  async ownerOf(token) {
    const hit = this.owners.get(token)
    if (hit && this.now() - hit.at < OWNER_TTL_MS) return hit.owner
    const arg = token.slice(2)
    const [owner, resolved] = await Promise.all([
      this.call(this.nameNFT, SEL_OWNER_OF + arg).catch((e) => (e?.rpcError ? '0x' : Promise.reject(e))),
      this.call(this.nameNFT, SEL_RESOLVE + arg),
    ])
    // An inactive name (expired, or a subname whose parent moved on) shows nothing.
    const active = resolved && !/^0x0*$/.test(resolved)
    const value = active && owner.length >= 66 ? topicAddress(owner.slice(0, 66)) : null
    this.owners.set(token, { owner: value, at: this.now() })
    if (this.owners.size > 20_000) this.owners.delete(this.owners.keys().next().value)
    return value
  }

  async nameOf(token) {
    const hit = this.names.get(token)
    if (hit && this.now() - hit.at < NAME_TTL_MS) return hit.name
    const name = decodeString(await this.call(this.nameNFT, SEL_FULL_NAME + token.slice(2)).catch(() => ''))
    this.names.set(token, { name, at: this.now() })
    return name
  }

  knows(token) {
    return this.byToken.has(token)
  }

  // The posts shown for a name (posts/SPEC.md, Validity), newest first: authorized by its current
  // owner, not removed since, bytes in hand, and in a blob or authorized within the last day.
  async postsFor(token) {
    const hashes = this.byToken.get(token)
    if (!hashes) return []
    const owner = await this.ownerOf(token)
    if (!owner) return []
    const now = Math.floor(this.now() / 1000)
    const out = []
    for (const hash of hashes) {
      const mine = this.byHash.get(hash).filter((a) => a.token === token && a.author === owner)
      if (!mine.length) continue
      const latest = mine[mine.length - 1]
      if ((this.removed.get(`${token}|${hash}|${owner}`) ?? -1) > latest.order) continue
      const held = this.bytes.get(hash)
      const post = held && parsePost(held.bytes)
      if (!post) continue
      let onchain = null
      for (const a of mine) {
        const pub = this.published.get(a.blob)
        if (pub && this.isCarried(a.blob, hash) && (!onchain || pub.order < onchain.order)) {
          onchain = { block: pub.block, blob: a.blob, tx: pub.tx, publisher: pub.publisher, order: pub.order }
        }
      }
      const authorizedAt = this.times.get(mine[0].block) ?? now
      if (!onchain && now - authorizedAt > PENDING_SECONDS) continue
      const time = onchain ? this.times.get(onchain.block) ?? authorizedAt : authorizedAt
      out.push({
        hash, ...post, time,
        onchain: onchain && { block: onchain.block, blob: onchain.blob, tx: onchain.tx, publisher: onchain.publisher },
      })
    }
    return out.sort((x, y) => y.time - x.time || (x.hash < y.hash ? -1 : 1))
  }

  // Newest posts across all names, a couple per name so one prolific name can't fill the list.
  async recent(limit = 20) {
    if (this.recentCache && this.now() - this.recentCache.at < RECENT_TTL_MS) return this.recentCache.posts.slice(0, limit)
    const all = []
    for (const token of this.byToken.keys()) {
      const shown = await this.postsFor(token).catch(() => [])
      if (!shown.length) continue
      const name = await this.nameOf(token)
      if (!name) continue
      for (const p of shown.slice(0, RECENT_PER_NAME)) all.push({ ...p, token, name })
    }
    all.sort((x, y) => y.time - x.time)
    this.recentCache = { at: this.now(), posts: all.slice(0, MAX_LIST) }
    return this.recentCache.posts.slice(0, limit)
  }

  // The n-th picture stored in a post (1-based, in the order its body has them), for /img: the way a
  // post shows pictures kept in another post's blob (posts/SPEC.md, "Images in other posts"). Only an
  // authorized post's pictures are served, so uploads alone never make this an image host. Whether the
  // post is shown doesn't matter: an image post is usually removed from its name's list on purpose.
  imageOf(hash, n) {
    if (!this.byHash.has(hash)) return null
    const held = this.bytes.get(hash)
    const post = held && parsePost(held.bytes)
    if (!post) return null
    const images = [...post.body.matchAll(/!\[[^\]\n]{0,300}\]\(\s*data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})\s*\)/g)]
    const m = images[n - 1]
    if (!m) return null
    try {
      return { type: m[1], bytes: Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)) }
    } catch {
      return null
    }
  }

  postInfo(hash) {
    const held = this.bytes.get(hash)
    const post = held && parsePost(held.bytes)
    const auths = this.byHash.get(hash) || []
    if (!post && !auths.length) return null
    return {
      hash, cid: postCid(hash),
      ...(post ? { title: post.title, body: post.body } : {}),
      authorizations: auths.map((a) => ({
        tokenId: a.token, author: a.author, blob: a.blob, publisher: a.publisher, fee: a.fee, block: a.block, tx: a.tx,
        time: this.times.get(a.block) ?? null,
        removed: (this.removed.get(`${a.token}|${hash}|${a.author}`) ?? -1) > a.order,
        published: this.published.has(a.blob),
        onchain: this.published.has(a.blob) && this.isCarried(a.blob, hash)
          ? { block: this.published.get(a.blob).block, tx: this.published.get(a.blob).tx } : null,
      })),
    }
  }

  // Fees an address put in escrow, latest per (blob, publisher): where to look for refunds. The
  // contract says what is actually left.
  paidBy(author) {
    const latest = new Map()
    for (const a of this.auths) {
      if (a.author !== author || a.fee === '0') continue
      latest.set(`${a.blob}|${a.publisher}`, a)
    }
    return [...latest.values()].map((a) => ({
      tokenId: a.token, hash: a.hash, blob: a.blob, publisher: a.publisher, fee: a.fee, block: a.block,
      delivered: this.published.get(a.blob)?.publisher === a.publisher,
    }))
  }

  // --- persistence (Node, POSTS_DIR) ----------------------------------------------------------

  async fs() {
    if (!this.dir) return null
    this.fsModule ||= import('node:fs/promises')
    return this.fsModule
  }

  load() {
    this.loaded ||= (async () => {
      const fs = await this.fs()
      if (!fs) return
      await fs.mkdir(`${this.dir}/bytes`, { recursive: true })
      let state
      try {
        state = JSON.parse(await fs.readFile(`${this.dir}/index.json`, 'utf8'))
      } catch {
        return
      }
      // An index bound to another contract would mix two event logs.
      if (state.contract !== this.contract) return
      this.cursor = BigInt(state.cursor)
      for (const a of state.auths) this.addAuth(a)
      this.published = new Map(state.published)
      this.removed = new Map(state.removed)
      this.times = new Map(state.times)
      this.checked = new Map(state.checked.map(([b, hs]) => [b, new Set(hs)]))
      for (const { hash, blob } of state.archive) this.carry(blob, hash)
      for (const [hash, source, at] of state.bytes) {
        try {
          const bytes = new Uint8Array(await fs.readFile(`${this.dir}/bytes/${hash}`))
          if (postHash(bytes) === hash) this.bytes.set(hash, { bytes, source, at })
        } catch {}
      }
      this.dirty = false
    })()
    return this.loaded
  }

  async save() {
    const fs = await this.fs()
    if (!fs || !this.dirty) return
    const state = {
      contract: this.contract,
      cursor: this.cursor.toString(),
      auths: this.auths,
      published: [...this.published],
      removed: [...this.removed],
      times: [...this.times],
      checked: [...this.checked].map(([b, hs]) => [b, [...hs]]),
      archive: this.archive,
      bytes: [...this.bytes].map(([hash, held]) => [hash, held.source, held.at]),
    }
    const tmp = `${this.dir}/index.json.tmp`
    await fs.writeFile(tmp, JSON.stringify(state))
    await fs.rename(tmp, `${this.dir}/index.json`)
    this.dirty = false
  }

  writeBytes(hash, bytes) {
    if (!this.dir) return
    this.fs().then((fs) => fs.writeFile(`${this.dir}/bytes/${hash}`, bytes)).catch(() => {})
  }

  removeBytes(hash) {
    if (!this.dir) return
    this.fs().then((fs) => fs.rm(`${this.dir}/bytes/${hash}`, { force: true })).catch(() => {})
  }
}

// --- the process's index, from env --------------------------------------------------------------

let shared = null
export function postIndex(env, read, nameNFT) {
  const contract = read(env, 'POSTS_CONTRACT', '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return null
  if (shared && shared.contract === contract.toLowerCase()) return shared
  const rpcUrls = String(read(env, 'RPC_URLS', '')).split(',').map((s) => s.trim()).filter(Boolean)
  const opts = { rpc: rpcUrls, maxResponseBytes: 8 * 1024 * 1024, timeoutMs: 10_000 }
  shared = new PostIndex({
    contract,
    nameNFT,
    fromBlock: Number(read(env, 'POSTS_FROM_BLOCK', 0)) || 0,
    dir: read(env, 'POSTS_DIR', '') || null,
    ipfs: String(read(env, 'IPFS_PATH_GATEWAY', DEFAULT_IPFS)).split(',')[0].trim() || null,
    rpc: (method, params) => rpcSend(method, params, opts),
    call: (to, data) => ethCall(data, { rpc: rpcUrls, contract: to }),
  })
  return shared
}
