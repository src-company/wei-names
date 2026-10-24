// Minimal WNS (Wei Name Service) read client — zero dependencies.
//
// The gateway needs these read calls:
//   computeId(string fullName) -> uint256   (0xfb021939)
//   contenthash(uint256 tokenId) -> bytes   (0xcb323d76)
//   resolve(uint256 tokenId) -> address     (0x4f896d4f)  — the name's addr record
//   resolveMode() -> bytes32                (0xdd473fae)  — ERC-4804, on the addr
//
// `ethCall` is exported for onchain.js, which adds the two page-reading calls
// (ERC-5219 `request()`, ERC-8244 `html()`) on top of the same RPC failover.
//
// The last two let the gateway serve *on-chain* dapps: a `.wei` name whose addr
// record points to an ERC-4804 contract (`resolveMode()` = manual/auto/5219) is
// served live from chain through a web3:// gateway, so deep paths and raw files
// (e.g. token.list.wei/tokenlist.json) work — an IPFS contenthash can only carry
// the ERC-8244 loader HTML, which bootstraps `/` in a browser but has no paths.
//
// ABI encoders/decoders below are ported from the `wns-utils` package
// (github: wns-utils), which is unit-tested against viem. Kept inline so the
// gateway stays a self-contained, build-free file like zFi's other workers.

// Canonical WNS registry on Ethereum mainnet.
export const WNS_CONTRACT = '0x0000000000696760E15f265e828DB644A0c242EB'

// Function selectors.
const COMPUTE_ID = '0xfb021939'
const CONTENTHASH = '0xcb323d76'
const RESOLVE = '0x4f896d4f' // resolve(uint256) -> address
const RESOLVE_MODE = '0xdd473fae' // resolveMode() -> bytes32 (ERC-4804)

// ERC-4804 resolve modes a web3:// gateway can serve. 'auto'/'manual' are the
// two standard modes; '5219' is the ERC-5219 request extension (what the WNS
// on-chain dapps use). A resolved address reporting any of these is treated as
// an on-chain dapp and served via a web3:// gateway rather than IPFS.
export const WEB3_MODES = new Set(['auto', 'manual', '5219'])

// Public mainnet RPCs, every one verified to serve `eth_call` server-side —
// a stricter bar than the dapp's list in dapp/wallet.js, so the two are
// deliberately NOT identical. Measured 2026-08-14 against the WNS registry:
//   - eth.llamarpc.com    a Cloudflare HTML page, never JSON      (was first!)
//   - 1rpc.io/eth         403 "forbidden" — dropped for the dapp in 762bab8
//   - cloudflare-eth.com  answers eth_chainId, but -32603 on eth_call, which is
//                         the only method this gateway ever issues
//   - eth.merkle.io       edge rate-limit (HTTP 1015) from a single server IP
//   - blastapi.io         connects, then hangs until the timeout — the worst
//                         kind, since benching still pays one full timeout first
// The benching below covers an endpoint that rots later; it does not make a
// permanently dead one free, because a benched endpoint is re-probed every
// bench interval (backing off to 2min) forever. Re-check with live-check.mjs before adding one back.
//
// 2026-10-24, after an outage where every name 502'd: tenderly's public
// gateway 429s after ~15 calls in a burst. The three added below each served
// the full 667 KB zswap.wei page and took 60 concurrent calls without a 429.
// (blastapi passed too this time, but stays out on its hang history.)
const DEFAULT_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.mevblocker.io',
  'https://eth.rpc.blxrbdn.com',
  'https://eth-pokt.nodies.app',
  'https://mainnet.gateway.tenderly.co',
]

const RPC_TIMEOUT_MS = 5_000

// Most an RPC reply may be before it is refused unread. A registry answer is a
// few hundred bytes; page reads (onchain.js) pass their own, larger cap. Without
// one, `res.json()` buffers whatever a contract returns — and anybody can point
// `0x<address>.<zone>` at a contract that returns as much as the node will run.
const RPC_MAX_RESPONSE_BYTES = 1024 * 1024

// --- endpoint pool: adaptive limits + load shaping ---------------------------
//
// Failure modes learned the hard way, all from traffic rather than bugs:
//
//   1. A fixed endpoint order means endpoint[0] takes every request and gets
//      rate-limited first, while the rest sit idle.
//   2. Once an endpoint starts refusing, retrying it on every request costs a
//      full timeout each time, and connections pile up faster than they drain.
//   3. A fixed global cap is wrong in both directions: too high for one healthy
//      endpoint, a ceiling on throughput with six.
//
// So each endpoint carries its own state. `limit` is how many calls it may
// have in flight, found by AIMD the way TCP finds a window: +1/limit per
// success, halved on a rate limit or a timeout. The gateway's total capacity
// is the sum over healthy endpoints, so it grows with what the nodes actually
// sustain and shrinks the moment one pushes back. A refusing endpoint is
// benched — for its own Retry-After when it sends one, else 5s doubling per
// consecutive strike up to 2min — and comes back at the limit it left with, so
// it ramps up again instead of being slammed.
//
// Selection: configured RPC_URLS first, then the public pool; within each,
// endpoints with room before saturated ones, ranked by measured latency times
// load, jittered so equals share. Benched endpoints are still tried last —
// nothing is ever unreachable.
//
// Reverts do NOT count against an endpoint: the node answered correctly, the
// contract just said no. Only transport failures and rate limits do.
const LIMIT_START = 8
const LIMIT_MAX = 64
const BENCH_BASE_MS = 5_000
const BENCH_MAX_MS = 120_000
const RETRY_AFTER_MAX_MS = 300_000
const pool = new Map()

function endpoint(url) {
  let ep = pool.get(url)
  if (!ep) {
    // Unmeasured endpoints start at a middling latency so they get tried.
    ep = { url, limit: LIMIT_START, inflight: 0, ewmaMs: 300, benchedUntil: 0, strikes: 0 }
    pool.set(url, ep)
  }
  return ep
}

// Log by host only: an RPC_URLS path is usually an API key.
function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'rpc'
  }
}

function reward(ep, ms) {
  ep.strikes = 0
  ep.benchedUntil = 0
  if (ms !== undefined) ep.ewmaMs = 0.8 * ep.ewmaMs + 0.2 * ms
  const before = Math.floor(ep.limit)
  ep.limit = Math.min(LIMIT_MAX, ep.limit + 1 / ep.limit)
  if (Math.floor(ep.limit) > before) drain()
}

function penalize(ep, reason, retryAfterMs) {
  const wasHealthy = ep.benchedUntil <= Date.now()
  ep.limit = Math.max(1, ep.limit / 2)
  const backoff = Math.min(BENCH_MAX_MS, BENCH_BASE_MS * 2 ** ep.strikes)
  ep.strikes = Math.min(ep.strikes + 1, 10)
  const ms = retryAfterMs ? Math.min(RETRY_AFTER_MAX_MS, retryAfterMs) : backoff
  ep.benchedUntil = Date.now() + ms
  if (wasHealthy) console.warn(`rpc: benched ${hostOf(ep.url)} for ${Math.round(ms / 1000)}s (${reason}), limit ${Math.floor(ep.limit)}`)
}

// Retry-After as milliseconds: delta-seconds or an HTTP date. 0 if absent.
function retryAfterMs(res) {
  const v = res.headers?.get?.('retry-after')
  if (!v) return 0
  const s = Number(v)
  if (Number.isFinite(s)) return Math.max(1_000, s * 1000)
  const at = Date.parse(v)
  return Number.isFinite(at) ? Math.max(1_000, at - Date.now()) : 0
}

// Next endpoint to try for one call: configured with room, public with room,
// configured saturated, public saturated, then benched soonest-back first.
function pickEndpoint(primary, backup, tried, now) {
  let best
  let bestScore = Infinity
  for (let tier = 0; tier < 2; tier++) {
    for (const url of tier === 0 ? primary : backup) {
      if (tried.has(url)) continue
      const ep = endpoint(url)
      const benched = ep.benchedUntil > now
      const cls = benched ? 4 + tier : ep.inflight >= Math.floor(ep.limit) ? 2 + tier : tier
      const within = benched
        ? ep.benchedUntil - now
        : ep.ewmaMs * (1 + ep.inflight / ep.limit) * (0.85 + 0.3 * Math.random())
      const score = cls * 1e9 + within
      if (score < bestScore) {
        bestScore = score
        best = url
      }
    }
  }
  return best
}

// Global gate. Excess calls queue rather than opening a socket each, so a spike
// degrades into latency instead of every call timing out together. Beyond
// MAX_QUEUE the gateway sheds load: an unbounded queue just converts a traffic
// spike into a slower, longer outage where every request times out.
const MIN_INFLIGHT = 8
const MAX_INFLIGHT = 192
const MAX_QUEUE = 200
let inflight = 0
const waiting = []

function capacity(now) {
  let sum = 0
  for (const ep of pool.values()) if (ep.benchedUntil <= now) sum += Math.floor(ep.limit)
  return Math.min(MAX_INFLIGHT, Math.max(MIN_INFLIGHT, sum))
}

async function acquire() {
  if (inflight < capacity(Date.now())) {
    inflight++
    return
  }
  if (waiting.length >= MAX_QUEUE) {
    const e = new Error('gateway busy: RPC queue full')
    e.overloaded = true
    throw e
  }
  // Woken by drain() with the slot already counted, so nobody can take it
  // between the wake-up and the caller resuming.
  await new Promise((resolve) => waiting.push(resolve))
}

function drain() {
  const cap = capacity(Date.now())
  while (waiting.length && inflight < cap) {
    inflight++
    waiting.shift()()
  }
}

function release() {
  inflight--
  drain()
}

// True while the pool has plenty of room. Background work (refresh-ahead in
// handler.js) runs only then, so it never competes with visitors for capacity.
export function rpcIdle() {
  return waiting.length === 0 && inflight < capacity(Date.now()) / 2
}

// Parse a JSON body, refusing it once it passes `cap` bytes. Oversize is the
// contract's answer, not the node's fault: tagged so the caller neither benches
// the endpoint nor asks the next one for the same bytes.
async function readJson(res, cap) {
  if (!res.body) return res.json()
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      reader.cancel().catch(() => {})
      const e = new Error('rpc: response exceeds size cap')
      e.tooLarge = true
      throw e
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.length
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

function isRateLimited(message) {
  return /rate|limit|429|too many|capacity|quota|exceeded/i.test(message || '')
}

// --- ABI encoding (subset) -------------------------------------------------

// Encode a string argument: offset(0x20) + length + right-padded utf8 data.
function encodeString(value) {
  const bytes = new TextEncoder().encode(value)
  const len = bytes.length
  const paddedLen = 32 * Math.ceil(len / 32)
  const buf = new Uint8Array(64 + paddedLen)
  writeUint(buf, 0, 32n) // offset
  writeUint(buf, 32, BigInt(len)) // length
  buf.set(bytes, 64) // data
  return bytesToHex(buf)
}

// Encode a uint256 argument (left-padded to 32 bytes, no 0x).
function encodeUint256(value) {
  return value.toString(16).padStart(64, '0')
}

// Write a big-endian uint into a 32-byte word at `offset` in `buf`.
function writeUint(buf, offset, value) {
  let v = value
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(v & 0xffn)
    v >>= 8n
  }
}

function bytesToHex(bytes) {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

// --- ABI decoding (subset) -------------------------------------------------

function decodeUint256(data) {
  if (!data || data === '0x') return 0n
  return BigInt(data.slice(0, 66))
}

// Decode an ABI dynamic `bytes` return value into a 0x-hex string, or null.
function decodeBytes(data) {
  if (!data || data === '0x' || data.length < 130) return null
  const hex = data.slice(2)
  const length = Number.parseInt(hex.slice(64, 128), 16)
  if (!length || hex.length < 128 + 2 * length) return null
  return `0x${hex.slice(128, 128 + 2 * length)}`
}

// Decode an ABI `address` (right-aligned in the first 32-byte word). Returns a
// lowercase 0x-address, or null for the zero address / empty data.
function decodeAddress(data) {
  if (!data || data === '0x' || data.length < 66) return null
  const addr = '0x' + data.slice(26, 66).toLowerCase()
  if (/^0x0{40}$/.test(addr)) return null
  return addr
}

// Decode a `bytes32` into its trimmed ASCII string (trailing zero bytes removed),
// e.g. the "5219" / "manual" / "auto" tags returned by ERC-4804 resolveMode().
function decodeBytes32Ascii(data) {
  if (!data || data === '0x') return ''
  const hex = data.slice(2, 66).replace(/(00)+$/, '')
  let out = ''
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16))
  return out
}

// --- RPC -------------------------------------------------------------------

// One `eth_call`, tried across the endpoint list until one answers. Exported so
// the ERC-5219 / ERC-8244 page reader (onchain.js) shares the same failover,
// timeout and endpoint config instead of opening its own RPC path.
// `opts.timeoutMs` overrides the per-endpoint timeout — page reads return whole
// documents (hundreds of KB) and want longer than a plain registry lookup.
export async function ethCall(data, opts) {
  const to = opts?.contract || WNS_CONTRACT
  const endpoints = opts?.rpc?.length ? opts.rpc : DEFAULT_RPCS
  const timeoutMs = opts?.timeoutMs || RPC_TIMEOUT_MS
  const maxBytes = opts?.maxResponseBytes || RPC_MAX_RESPONSE_BYTES
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
  })

  // A configured list (RPC_URLS) goes first; the built-in public endpoints
  // back it up, so a dead or exhausted key degrades to public RPC instead of
  // 502ing every name, and take its overflow when it is saturated.
  const backup = endpoints === DEFAULT_RPCS ? [] : DEFAULT_RPCS.filter((u) => !endpoints.includes(u))
  for (const url of endpoints) endpoint(url)
  for (const url of backup) endpoint(url)
  // Page reads move hundreds of KB; only plain lookups feed the latency estimate.
  const measure = !opts?.timeoutMs

  let lastErr
  await acquire()
  try {
    const tried = new Set()
    for (let url; (url = pickEndpoint(endpoints, backup, tried, Date.now())); ) {
      tried.add(url)
      const ep = endpoint(url)
      ep.inflight++
      const started = Date.now()
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        let res, json
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: controller.signal,
          })
          // Read the body under the same timer: a node that sends headers and
          // then stalls must not hold an inflight slot forever.
          if (res.ok) json = await readJson(res, maxBytes)
          else res.body?.cancel().catch(() => {})
        } finally {
          clearTimeout(timer)
        }
        if (!res.ok) {
          // 429/5xx never carries a usable body — bench and move on.
          penalize(ep, `http ${res.status}`, retryAfterMs(res))
          lastErr = new Error(`rpc http ${res.status}`)
          continue
        }
        if (json?.error) {
          // The node answered — the call itself failed (a revert, a rate limit,
          // an unsupported method). Still worth trying the next endpoint, but
          // tag it: callers probing for an optional function need to tell "this
          // contract said no" apart from "no endpoint would talk to us".
          const message = json.error?.message || 'rpc error'
          lastErr = new Error(message)
          lastErr.rpcError = true
          if (isRateLimited(message)) {
            penalize(ep, 'rate limited')
            continue
          }
          // A revert is deterministic: every other node would say the same
          if (json.error?.code === 3 || /revert/i.test(message)) {
            reward(ep, measure ? Date.now() - started : undefined)
            break
          }
          continue
        }
        // A reply with no hex result is a broken node, not an empty answer
        if (typeof json?.result !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(json.result)) {
          penalize(ep, 'malformed result')
          lastErr = new Error('rpc: malformed result')
          continue
        }
        reward(ep, measure ? Date.now() - started : undefined)
        return json.result
      } catch (e) {
        lastErr = e
        // Every node would return the same oversized answer.
        if (e?.tooLarge) break
        // Timeout or transport failure: the endpoint itself is the problem.
        penalize(ep, e?.name === 'AbortError' ? 'timeout' : 'unreachable')
      } finally {
        ep.inflight--
      }
    }
  } finally {
    release()
  }
  if (!lastErr?.rpcError && !lastErr?.tooLarge) console.error('rpc: all endpoints failed:', lastErr?.message || lastErr)
  throw lastErr || new Error('all RPC endpoints failed')
}

// --- Multicall3 ---------------------------------------------------------------
//
// A name's registry records are two calls, and a name pointing at a contract
// needs that contract's resolveMode() too — three round-trips, each one counted
// against an RPC's rate limit, repeated every time the resolution expires.
// Multicall3's aggregate3 folds them into a single eth_call. Deployed at the
// same address on mainnet (and every major chain) since 2022.
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const AGGREGATE3 = '0x82ad56cb'

const hexWord = (n) => n.toString(16).padStart(64, '0')

// aggregate3((address target, bool allowFailure, bytes callData)[]), every call
// allowed to fail so one revert does not take the others with it.
function encodeAggregate3(calls) {
  const tuples = calls.map(({ target, data }) => {
    const bytes = data.replace(/^0x/, '')
    const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')
    return target.replace(/^0x/, '').toLowerCase().padStart(64, '0') +
      hexWord(1) + hexWord(0x60) + hexWord(bytes.length / 2) + padded
  })
  let offset = 32 * calls.length
  const offsets = tuples.map((t) => {
    const at = offset
    offset += t.length / 2
    return hexWord(at)
  })
  return AGGREGATE3 + hexWord(0x20) + hexWord(calls.length) + offsets.join('') + tuples.join('')
}

// (bool success, bytes returnData)[] -> [{ success, data }], or null for
// anything that is not well-formed, so the caller falls back to plain calls.
function decodeAggregate3(result) {
  const hex = String(result || '').replace(/^0x/, '')
  const word = (byte) => {
    if (byte < 0 || 2 * byte + 64 > hex.length) return NaN
    return Number.parseInt(hex.slice(2 * byte, 2 * byte + 64), 16)
  }
  const head = word(0)
  const n = word(head)
  if (!Number.isSafeInteger(n) || n > 16) return null
  const base = head + 32
  const out = []
  for (let i = 0; i < n; i++) {
    const at = base + word(base + 32 * i)
    const success = word(at)
    const len = word(at + word(at + 32))
    const start = at + word(at + 32) + 32
    if (![at, success, len].every(Number.isSafeInteger) || 2 * (start + len) > hex.length) return null
    out.push({ success: success === 1, data: '0x' + hex.slice(2 * start, 2 * (start + len)) })
  }
  return out
}

// A name's addr and contenthash in one eth_call, plus resolveMode() of `guess`
// (the address the name pointed at last time) speculatively in the same call:
// names rarely move, so a re-resolution of a contract page costs one round-trip
// instead of three. Returns null when the batch can't be read — the node
// lacks Multicall3, or a registry call itself failed — and the caller asks the
// plain way, so batching can only ever save calls, never change an answer.
export async function registryRecords(tokenId, guess, opts) {
  const registry = opts?.contract || WNS_CONTRACT
  const calls = [
    { target: registry, data: RESOLVE + encodeUint256(tokenId) },
    { target: registry, data: CONTENTHASH + encodeUint256(tokenId) },
  ]
  if (guess) calls.push({ target: guess, data: RESOLVE_MODE })
  let out
  try {
    out = decodeAggregate3(await ethCall(encodeAggregate3(calls), { ...opts, contract: MULTICALL3 }))
  } catch (e) {
    // Transport failure: the plain calls would hit the same wall.
    if (!e?.rpcError) throw e
    return null
  }
  if (!out || out.length !== calls.length || !out[0].success || !out[1].success) return null
  return {
    address: decodeAddress(out[0].data),
    contenthash: decodeBytes(out[1].data),
    // A failed resolveMode() is a revert: "not an on-chain dapp", as below.
    mode: guess ? { address: guess, value: out[2].success ? decodeBytes32Ascii(out[2].data) : '' } : null,
  }
}

// --- Public API ------------------------------------------------------------

// Normalize to a full `.wei` name: lowercase, trimmed, `.wei` suffix ensured.
export function normalizeName(name) {
  let n = String(name).toLowerCase().trim()
  if (!n.endsWith('.wei')) n += '.wei'
  return n
}

// Compute a full `.wei` name's WNS tokenId (0n if the name has no id).
export async function computeId(name, opts) {
  const res = await ethCall(COMPUTE_ID + encodeString(normalizeName(name)), opts)
  return decodeUint256(res)
}

// Raw contenthash (0x-hex bytes) for a tokenId, or null if none is set.
export async function contenthashOf(tokenId, opts) {
  if (!tokenId) return null
  const res = await ethCall(CONTENTHASH + encodeUint256(tokenId), opts)
  return decodeBytes(res)
}

// The tokenId's addr record (lowercase 0x-address), or null if unset/zero.
export async function resolveAddress(tokenId, opts) {
  if (!tokenId) return null
  const res = await ethCall(RESOLVE + encodeUint256(tokenId), opts)
  return decodeAddress(res)
}

// ERC-4804 resolveMode() of a contract, as a trimmed ASCII tag ('' if the
// address has no code, doesn't implement it, or reverts). A revert just means
// "not an on-chain dapp"; a transport failure throws, so it becomes a 502
// rather than a cached "not a page".
export async function resolveMode(address, opts) {
  try {
    const res = await ethCall(RESOLVE_MODE, { ...opts, contract: address })
    return decodeBytes32Ascii(res)
  } catch (e) {
    if (e?.rpcError && /revert|invalid opcode|out of gas|execution/i.test(e.message || '')) return ''
    throw e
  }
}

// Resolve a `.wei` name to its raw contenthash (0x-hex bytes), or null if the
// name is unregistered or has no contenthash set. Kept for callers that only
// need contenthash; the gateway uses the granular helpers above.
export async function resolveContenthash(name, opts) {
  const tokenId = await computeId(name, opts)
  if (tokenId === 0n) return null
  return contenthashOf(tokenId, opts)
}
