// Decode an EIP-1577 / ENSIP-7 contenthash into servable content.
//
// WNS stores contenthash the same way ENS does. Two namespaces are served:
//
//   IPFS  (ipfs-ns, 0xe3, varint `e301`):
//     e3 01            <- ipfs-ns protocol code
//     01 70 12 20 ..   <- CIDv1: version=1, codec=dag-pb(0x70), sha2-256, 32B
//   Stripping the `e301` prefix leaves the CIDv1 bytes, base32-encoded to the
//   canonical `bafy…` string used by IPFS subdomain gateways
//   (`https://<cid>.ipfs.<gw>`).
//
//   IPNS  (ipns-ns, 0xe5, varint `e501`):
//     e5 01            <- ipns-ns protocol code
//     01 72 00 24 ..   <- CIDv1: version=1, codec=libp2p-key(0x72), then the
//                         (usually identity-hashed) public key multihash
//   Stripping the `e501` prefix leaves the libp2p-key CIDv1, base36-encoded to
//   the `k51…` IPNS name served by IPNS subdomain gateways
//   (`https://<name>.ipns.<gw>`). IPNS is base36 (not base32) because an
//   ed25519 name in base32 exceeds the 63-char DNS-label limit.
//
// IPNS is what lets a name publish a *mutable* site: the on-chain contenthash
// points at a stable key set once, and the owner republishes the IPNS record
// off-chain on every update — no further on-chain transaction. The gateway
// never resolves IPNS itself; it hands the name to the IPNS subdomain gateway,
// which resolves it fresh on each request.
//
//   Swarm (swarm-ns, 0xe4, varint `e401`):
//     e4 01            <- swarm-ns protocol code
//     01 fa 01 1b 20 ..<- CIDv1: version=1, codec=swarm-manifest(0xfa),
//                         keccak-256(0x1b), 32-byte digest = the bzz reference
//   Exactly the bytes `bzz://<64 hex>` encodes to, and what ENS names hosted on
//   Swarm store (swarm.eth among them). Only the unencrypted 32-byte reference
//   is accepted: an encrypted one is 64 bytes and no public gateway serves it.
//   The id is the reference as bare hex, the form a Bee `/bzz/<ref>/` path
//   wants. Swarm content is fetched by the gateway in every mode — see
//   handler.js — because no public Swarm gateway both serves arbitrary
//   references and lets a browser render them.

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' // RFC 4648, lowercase
const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz' // multibase 'k'

function hexToBytes(hex) {
  const h = hex.replace(/^0x/, '')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// RFC 4648 base32, no padding.
function base32Encode(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

// Big-endian byte array -> base36 string (leading zero bytes preserved as '0').
function base36Encode(bytes) {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 36
      carry = (carry / 36) | 0
    }
    while (carry > 0) {
      digits.push(carry % 36)
      carry = (carry / 36) | 0
    }
  }
  let out = ''
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += BASE36_ALPHABET[0]
  for (let i = digits.length - 1; i >= 0; i--) out += BASE36_ALPHABET[digits[i]]
  return out
}

// Decode a 0x-hex contenthash into `{ ns, id }`, or null if it isn't a
// namespace this gateway can serve.
//   ns 'ipfs' -> id is a base32 CIDv1 (`bafy…`) for `<id>.ipfs.<gw>`
//   ns 'ipns' -> id is a base36 IPNS name (`k51…`) for `<id>.ipns.<gw>`
const MAX_CID_BYTES = 128

export function decodeContenthash(contenthash) {
  if (!contenthash) return null
  const hex = contenthash.replace(/^0x/, '').toLowerCase()
  // Real CIDs and IPNS keys are ~40 bytes; anything malformed or huge is not
  // content (and base36 encoding is quadratic in its length).
  if (!/^(?:[0-9a-f]{2})+$/.test(hex) || hex.length > 4 + 2 * MAX_CID_BYTES) return null

  // ipfs-ns (0xe3) encoded as the varint `e301`.
  if (hex.startsWith('e301')) {
    const cidBytes = hexToBytes(hex.slice(4))
    if (cidBytes.length === 0) return null
    return { ns: 'ipfs', id: 'b' + base32Encode(cidBytes) } // multibase 'b' = base32
  }

  // ipns-ns (0xe5) encoded as the varint `e501`.
  if (hex.startsWith('e501')) {
    let cidBytes = hexToBytes(hex.slice(4))
    if (cidBytes.length === 0) return null
    // Canonical form is a libp2p-key CIDv1 (leading 0x01). Legacy encoders may
    // store a bare peer-id multihash; wrap it as CIDv1 codec 0x72 (libp2p-key).
    if (cidBytes[0] !== 0x01) {
      cidBytes = Uint8Array.from([0x01, 0x72, ...cidBytes])
    }
    return { ns: 'ipns', id: 'k' + base36Encode(cidBytes) } // multibase 'k' = base36
  }

  // swarm-ns (0xe4) + CIDv1 swarm-manifest keccak-256, fixed length.
  if (hex.startsWith(SWARM_PREFIX)) {
    const ref = hex.slice(SWARM_PREFIX.length)
    return ref.length === 64 ? { ns: 'swarm', id: ref } : null
  }

  // Other namespaces (arweave, onion, …) are not served by this gateway.
  return null
}

// `e401` (swarm-ns) + `01 fa01 1b 20` (CIDv1, swarm-manifest, keccak-256, 32 bytes).
const SWARM_PREFIX = 'e40101fa011b20'
// The CIDv1 bytes ahead of the reference, and their base32 spelling. Every
// 32-byte reference shares these 5 bytes, so every base32 Swarm CID shares its
// first 8 characters after the multibase `b`: `bah5acgza` + 52 more, 61 in all.
const SWARM_CID_PREFIX = Uint8Array.from([0x01, 0xfa, 0x01, 0x1b, 0x20])
export const SWARM_CID_LABEL = /^bah5acgza[a-z2-7]{52}$/

// RFC 4648 base32, lowercase, no padding -> bytes. Trailing bits are dropped.
function base32Decode(str) {
  let bits = 0
  let value = 0
  const out = []
  for (const ch of str) {
    const v = BASE32_ALPHABET.indexOf(ch)
    if (v < 0) return null
    value = ((value << 5) | v) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

// A Swarm reference (64 hex) as the base32 CIDv1 that fits in one DNS label —
// the shape of a `<cid>.<zone>` content label. 64 hex characters are one over
// the 63-character label limit, so the bare reference can never be a host.
export function swarmCid(ref) {
  return 'b' + base32Encode(Uint8Array.from([...SWARM_CID_PREFIX, ...hexToBytes(ref)]))
}

// The inverse: a `bah5acgza…` label -> its 64-hex reference, or null.
// Canonical spellings only. 37 bytes are 296 bits and 60 base32 characters 300,
// so the last character carries one data bit and four that decoding ignores:
// 16 spellings per reference. Only the one swarmCid() produces is accepted.
export function swarmRefFromCid(label) {
  if (!SWARM_CID_LABEL.test(label)) return null
  const bytes = base32Decode(label.slice(1))
  if (!bytes || bytes.length !== SWARM_CID_PREFIX.length + 32) return null
  for (let i = 0; i < SWARM_CID_PREFIX.length; i++) if (bytes[i] !== SWARM_CID_PREFIX[i]) return null
  const ref = [...bytes.slice(SWARM_CID_PREFIX.length)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return swarmCid(ref) === label ? ref : null
}
