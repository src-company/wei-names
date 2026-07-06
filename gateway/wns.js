// Minimal WNS (Wei Name Service) read client — zero dependencies.
//
// The gateway only needs two read calls:
//   computeId(string fullName) -> uint256   (0xfb021939)
//   contenthash(uint256 tokenId) -> bytes   (0xcb323d76)
//
// ABI encoders/decoders below are ported from the `wns-utils` package
// (github: wns-utils), which is unit-tested against viem. Kept inline so the
// gateway stays a self-contained, build-free file like zFi's other workers.

// Canonical WNS registry on Ethereum mainnet.
export const WNS_CONTRACT = '0x0000000000696760E15f265e828DB644A0c242EB'

// Function selectors.
const COMPUTE_ID = '0xfb021939'
const CONTENTHASH = '0xcb323d76'

// Public mainnet RPCs with fallback (same set zFi already allows in its CSP).
const DEFAULT_RPCS = [
  'https://eth.llamarpc.com',
  'https://ethereum.publicnode.com',
  'https://1rpc.io/eth',
  'https://eth.drpc.org',
]

const RPC_TIMEOUT_MS = 5_000

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

// --- RPC -------------------------------------------------------------------

async function ethCall(data, opts) {
  const to = opts?.contract || WNS_CONTRACT
  const endpoints = opts?.rpc?.length ? opts.rpc : DEFAULT_RPCS
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
  })

  let lastErr
  for (const url of endpoints) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      })
      clearTimeout(timer)
      const json = await res.json()
      if (json.error) {
        lastErr = new Error(json.error?.message || 'rpc error')
        continue
      }
      return json.result ?? '0x'
    } catch (e) {
      lastErr = e
    }
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

// Resolve a `.wei` name to its raw contenthash (0x-hex bytes), or null if the
// name is unregistered or has no contenthash set.
export async function resolveContenthash(name, opts) {
  const fullName = normalizeName(name)

  const tokenIdRes = await ethCall(COMPUTE_ID + encodeString(fullName), opts)
  const tokenId = decodeUint256(tokenIdRes)
  if (tokenId === 0n) return null

  const chRes = await ethCall(CONTENTHASH + encodeUint256(tokenId), opts)
  return decodeBytes(chRes)
}
