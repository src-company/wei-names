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
export function decodeContenthash(contenthash) {
  if (!contenthash) return null
  const hex = contenthash.replace(/^0x/, '').toLowerCase()

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

  // Other namespaces (swarm, arweave, …) are not served by this gateway.
  return null
}
