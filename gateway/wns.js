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
// COOLDOWN_MS forever. Re-check with live-check.mjs before adding one back.
const DEFAULT_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://mainnet.gateway.tenderly.co',
]

const RPC_TIMEOUT_MS = 5_000

// --- endpoint health + load shaping -----------------------------------------
//
// Two failure modes learned the hard way, both from traffic rather than bugs:
//
//   1. A fixed endpoint order means endpoint[0] takes every request and gets
//      rate-limited first, while the rest sit idle. `rrCursor` rotates the
//      starting point so load spreads across the list.
//   2. Once an endpoint starts refusing, retrying it on every request costs a
//      full timeout each time — with four endpoints that is 20s of dead wait
//      per request, and connections pile up faster than they drain. A failing
//      endpoint is benched for COOLDOWN_MS instead.
//
// Reverts do NOT bench an endpoint: the node answered correctly, the contract
// just said no. Only transport failures and rate limits count against it.
const COOLDOWN_MS = 30_000
const unhealthyUntil = new Map()
let rrCursor = 0

// Cap on concurrent outbound RPCs. Without one, a spike opens a socket per
// request and every call times out together; with one, excess calls queue and
// the service degrades in latency instead of failing outright.
// Beyond this many *queued* calls the gateway sheds load instead of queueing
// deeper. A queue that grows without bound just converts a traffic spike into
// a slower, longer outage where every request times out; refusing early keeps
// the requests that are already in progress finishing.
const MAX_INFLIGHT = 24
const MAX_QUEUE = 200
let inflight = 0
const waiting = []

async function acquire() {
  if (inflight < MAX_INFLIGHT) {
    inflight++
    return
  }
  if (waiting.length >= MAX_QUEUE) {
    const e = new Error('gateway busy: RPC queue full')
    e.overloaded = true
    throw e
  }
  await new Promise((resolve) => waiting.push(resolve))
  inflight++
}

function release() {
  inflight--
  const next = waiting.shift()
  if (next) next()
}

function isRateLimited(message) {
  return /rate|limit|429|too many|capacity|quota|exceeded/i.test(message || '')
}

// Healthy endpoints first (rotated), benched ones last as a last resort — if
// every endpoint is benched we still try rather than failing outright.
function orderEndpoints(endpoints, now) {
  const start = rrCursor++ % endpoints.length
  const rotated = [...endpoints.slice(start), ...endpoints.slice(0, start)]
  const healthy = []
  const benched = []
  for (const url of rotated) {
    ;((unhealthyUntil.get(url) || 0) > now ? benched : healthy).push(url)
  }
  return [...healthy, ...benched]
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
  if (!length) return null
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
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
  })

  let lastErr
  await acquire()
  try {
    for (const url of orderEndpoints(endpoints, Date.now())) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        let res
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
        }
        if (!res.ok) {
          // 429/5xx never carries a usable body — bench and move on.
          unhealthyUntil.set(url, Date.now() + COOLDOWN_MS)
          lastErr = new Error(`rpc http ${res.status}`)
          continue
        }
        const json = await res.json()
        if (json.error) {
          // The node answered — the call itself failed (a revert, a rate limit,
          // an unsupported method). Still worth trying the next endpoint, but
          // tag it: callers probing for an optional function need to tell "this
          // contract said no" apart from "no endpoint would talk to us".
          const message = json.error?.message || 'rpc error'
          if (isRateLimited(message)) unhealthyUntil.set(url, Date.now() + COOLDOWN_MS)
          lastErr = new Error(message)
          lastErr.rpcError = true
          continue
        }
        unhealthyUntil.delete(url)
        return json.result ?? '0x'
      } catch (e) {
        // Timeout or transport failure: the endpoint itself is the problem.
        unhealthyUntil.set(url, Date.now() + COOLDOWN_MS)
        lastErr = e
      }
    }
  } finally {
    release()
  }
  throw lastErr || new Error('all RPC endpoints failed')
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
// address has no code, doesn't implement it, or reverts). Never throws for a
// non-web3 address: a reverting call just means "not an on-chain dapp".
export async function resolveMode(address, opts) {
  try {
    const res = await ethCall(RESOLVE_MODE, { ...opts, contract: address })
    return decodeBytes32Ascii(res)
  } catch {
    return ''
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
