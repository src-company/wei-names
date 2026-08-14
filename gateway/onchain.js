// Serve a contract's bytecode AS the page — ERC-5219 (via ERC-4804) and ERC-8244.
//
// The rest of the gateway hands a name to somebody else's bytes: a CID to an
// IPFS gateway, a web3:// URL to w3link. This file is the case where there is
// nobody else to hand it to. The page is the contract, so serving it means
// calling it, decoding the return value, and writing the response ourselves.
//
// Two interfaces, probed in this order (see handler.js):
//
//   ERC-5219  request(string[] resource, KeyValue[] params)
//               -> (uint16 statusCode, string body, KeyValue[] headers)
//             Signalled by ERC-4804 `resolveMode() == bytes32("5219")`. Carries
//             the request path and query, so deep paths and raw files work.
//
//   ERC-8244  html() -> string
//             No path, no status, no headers: one document at `/`.
//
// Both are pure reads of immutable bytecode — no state, no admin, no path to
// change what they answer. That is the whole reason the gateway can serve them
// straight rather than mirroring them somewhere first.
//
// HEADERS ARE UNTRUSTED. The returned header array is written by whoever
// deployed the contract, and anyone can deploy a contract and point a name at
// it. Only `Content-Type` and `Cache-Control` survive (see pickHeaders): a page
// must not be able to set a CSP, hand out cookies, or emit a `Location` through
// this gateway. That is a ceiling on what we pass, not a judgement about any
// particular contract.

import { ethCall } from './wns.js'

// Function selectors.
const REQUEST = '0x1374c460' // request(string[],(string,string)[])
const HTML = '0x33c34ac3' // html()

// Caps. A contract can return anything an `eth_call` will carry; these bound
// what a hostile one can make the gateway allocate. The real zSwap page is
// ~214 KB, so 8 MB is roughly 40x headroom rather than a tight fit.
export const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_HEADERS = 32
const MAX_HEADER_LEN = 200

// Longer than a registry lookup: a page read returns the whole document.
const PAGE_TIMEOUT_MS = 15_000

// What a page gets when it doesn't say. `html()` has nowhere to put a
// Cache-Control at all, and an ERC-5219 contract may simply omit one — 5
// minutes is short enough that a name repointed on chain goes live promptly.
const DEFAULT_CACHE_CONTROL = 'public, max-age=300'
const DEFAULT_CONTENT_TYPE = 'text/html; charset=utf-8'

// --- byte helpers ----------------------------------------------------------

function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (h.length % 2) throw new Error('odd-length hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(b)) throw new Error('bad hex')
    out[i] = b
  }
  return out
}

function bytesToHex(bytes) {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

// Read the 32-byte word at `off` as a Number, rejecting anything that isn't a
// plausible in-bounds offset/length. Malformed ABI is an upstream error, not
// something to paper over: every caller here treats a throw as "not a page".
function readWord(bytes, off, limit) {
  if (off < 0 || off + 32 > bytes.length) throw new Error('abi: word out of range')
  // Offsets and lengths that matter fit in the low 4 bytes; anything set above
  // that is either a huge value or a uint we shouldn't be reading as an offset.
  for (let i = 0; i < 28; i++) if (bytes[off + i] !== 0) throw new Error('abi: word too large')
  const v = (bytes[off + 28] << 24) | (bytes[off + 29] << 16) | (bytes[off + 30] << 8) | bytes[off + 31]
  const n = v >>> 0
  if (limit !== undefined && n > limit) throw new Error('abi: word exceeds limit')
  return n
}

// A dynamic `string`/`bytes` at absolute offset `at`: length word, then data.
// Returned as raw bytes — the body is served verbatim, never round-tripped
// through a JS string, so a page that emits non-UTF-8 bytes keeps them.
function readBytesAt(bytes, at, maxLen) {
  const len = readWord(bytes, at, maxLen)
  if (at + 32 + len > bytes.length) throw new Error('abi: bytes out of range')
  return bytes.subarray(at + 32, at + 32 + len)
}

function readStringAt(bytes, at, maxLen) {
  return new TextDecoder().decode(readBytesAt(bytes, at, maxLen))
}

// --- ABI encoding ----------------------------------------------------------

function word(n) {
  const buf = new Uint8Array(32)
  let v = BigInt(n)
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return buf
}

function concat(chunks) {
  let len = 0
  for (const c of chunks) len += c.length
  const out = new Uint8Array(len)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

// A dynamic string: length word + data right-padded to a 32-byte boundary.
function encString(s) {
  const data = new TextEncoder().encode(s)
  const padded = new Uint8Array(32 * Math.ceil(data.length / 32))
  padded.set(data)
  return concat([word(data.length), padded])
}

// `string[]`: length, then one offset per element (relative to just after the
// length word), then the elements.
function encStringArray(items) {
  const elems = items.map(encString)
  const head = []
  let off = 32 * elems.length
  for (const e of elems) {
    head.push(word(off))
    off += e.length
  }
  return concat([word(elems.length), ...head, ...elems])
}

// `KeyValue[]` where `struct KeyValue { string key; string value; }`. Each
// element is itself dynamic: two offset words relative to the element's own
// start, then the two strings.
function encKeyValueArray(pairs) {
  const elems = pairs.map(([k, v]) => {
    const key = encString(k)
    const val = encString(v)
    return concat([word(64), word(64 + key.length), key, val])
  })
  const head = []
  let off = 32 * elems.length
  for (const e of elems) {
    head.push(word(off))
    off += e.length
  }
  return concat([word(elems.length), ...head, ...elems])
}

// Calldata for `request(resource, params)`. Two dynamic args, so the head is
// two offset words followed by the two encoded arrays.
export function encodeRequestCall(resource, params) {
  const res = encStringArray(resource)
  const par = encKeyValueArray(params)
  return REQUEST + bytesToHex(concat([word(64), word(64 + res.length), res, par]))
}

// --- ABI decoding ----------------------------------------------------------

// Decode `(uint16 statusCode, string body, KeyValue[] headers)`.
// Throws on anything malformed; callers treat that as "not a servable page".
export function decodeRequestReturn(hex) {
  const bytes = hexToBytes(hex)
  if (bytes.length < 96) throw new Error('abi: return too short')

  const statusCode = readWord(bytes, 0, 0xffff)
  const bodyOff = readWord(bytes, 32, bytes.length)
  const headersOff = readWord(bytes, 64, bytes.length)

  const body = readBytesAt(bytes, bodyOff, MAX_BODY_BYTES)

  const count = readWord(bytes, headersOff, MAX_HEADERS)
  const base = headersOff + 32
  const headers = []
  for (let i = 0; i < count; i++) {
    const elem = base + readWord(bytes, base + 32 * i, bytes.length)
    const key = readStringAt(bytes, elem + readWord(bytes, elem, bytes.length), MAX_HEADER_LEN)
    const value = readStringAt(bytes, elem + readWord(bytes, elem + 32, bytes.length), MAX_HEADER_LEN)
    headers.push([key, value])
  }
  return { statusCode, body, headers }
}

// Decode a lone `string` return (ERC-8244 `html()`), as raw bytes.
//
// Strict, because this decoder doubles as the probe for "is this contract a
// page at all?". Plenty of contracts answer an unknown selector with a fallback
// that returns *something*, and a loose decoder would happily read a chunk of
// that as a document and serve it as HTML. A canonical `string` return is
// exactly `[offset=0x20][length][data padded to 32]` and nothing else, so
// requiring that shape rejects near enough all of it.
export function decodeStringReturn(hex) {
  const bytes = hexToBytes(hex)
  if (bytes.length < 64) throw new Error('abi: return too short')
  const off = readWord(bytes, 0, bytes.length)
  if (off !== 32) throw new Error('abi: non-canonical string offset')
  const out = readBytesAt(bytes, off, MAX_BODY_BYTES)
  if (bytes.length !== 64 + 32 * Math.ceil(out.length / 32)) {
    throw new Error('abi: trailing data after string')
  }
  return out
}

// --- header whitelist ------------------------------------------------------

// Reject anything that could break out of a header value: CR/LF (response
// splitting), NUL, and other control characters. Length-capped too.
function safeHeaderValue(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_HEADER_LEN && !/[\x00-\x1f\x7f]/.test(v)
}

// A media type, optionally with parameters. Deliberately narrow: we only need
// to let through the things a page legitimately serves.
function safeContentType(v) {
  return safeHeaderValue(v) && /^[!#$&^_.+a-z0-9-]+\/[!#$&^_.+a-z0-9-]+\s*(;[^,]*)?$/i.test(v)
}

function safeCacheControl(v) {
  return safeHeaderValue(v) && /^[a-z0-9 ,;="'._-]+$/i.test(v)
}

// The whole of Rule 4: two headers out of a contract-authored array, each
// validated, everything else silently dropped. Last occurrence wins, matching
// how a single-valued header would collapse anyway.
export function pickHeaders(headers) {
  let contentType
  let cacheControl
  for (const [k, v] of headers) {
    const name = String(k).trim().toLowerCase()
    if (name === 'content-type' && safeContentType(v)) contentType = v.trim()
    else if (name === 'cache-control' && safeCacheControl(v)) cacheControl = v.trim()
  }
  return {
    contentType: contentType || DEFAULT_CONTENT_TYPE,
    cacheControl: cacheControl || DEFAULT_CACHE_CONTROL,
  }
}

// An HTTP status a gateway can actually emit. A contract returning something
// outside the range isn't serving a page, so 502 is the honest answer.
export function safeStatus(code) {
  return Number.isInteger(code) && code >= 200 && code <= 599 ? code : 502
}

// --- page reads ------------------------------------------------------------

// Split a request path into ERC-5219 `resource` segments. `/` -> [], and each
// segment is percent-decoded, because the contract sees the decoded resource.
export function pathToResource(pathname) {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
}

// Call `request()` and turn the answer into a servable response shape.
// Returns null if the contract doesn't answer as an ERC-5219 page; throws only
// on RPC failure, which the caller must surface as a 502 (never as stale).
export async function fetchErc5219(address, pathname, search, opts) {
  const resource = pathToResource(pathname)
  const params = [...new URLSearchParams(search || '')].map(([k, v]) => [k, v])
  const res = await ethCall(encodeRequestCall(resource, params), {
    ...opts,
    contract: address,
    timeoutMs: opts?.pageTimeoutMs || PAGE_TIMEOUT_MS,
  })
  if (!res || res === '0x') return null
  // Two hex chars per byte, plus the leading `0x`.
  if (res.length > 2 * MAX_BODY_BYTES + 2) throw new Error('page exceeds size cap')
  let decoded
  try {
    decoded = decodeRequestReturn(res)
  } catch {
    return null
  }
  const { contentType, cacheControl } = pickHeaders(decoded.headers)
  return {
    status: safeStatus(decoded.statusCode),
    body: decoded.body,
    contentType,
    cacheControl,
  }
}

// Call `html()`. Returns null if the contract has no such function (an EOA or
// an unrelated contract just reverts / returns empty). Throws on RPC failure.
export async function fetchErc8244(address, opts) {
  let res
  try {
    res = await ethCall(HTML, {
      ...opts,
      contract: address,
      timeoutMs: opts?.pageTimeoutMs || PAGE_TIMEOUT_MS,
    })
  } catch (e) {
    // A contract without `html()` reverts, which reaches us as a throw — same
    // shape as every endpoint being down. `rpcError` means a node answered and
    // the CALL failed, so pair it with a revert-shaped message before deciding
    // "not a page"; anything else is a transport failure and must stay a 502.
    if (e?.rpcError && /revert|invalid opcode|out of gas|execution/i.test(e.message || '')) return null
    throw e
  }
  if (!res || res === '0x') return null
  if (res.length > 2 * MAX_BODY_BYTES + 2) throw new Error('page exceeds size cap')
  let body
  try {
    body = decodeStringReturn(res)
  } catch {
    return null
  }
  if (body.length === 0) return null
  return {
    status: 200,
    body,
    contentType: DEFAULT_CONTENT_TYPE,
    cacheControl: DEFAULT_CACHE_CONTROL,
  }
}
