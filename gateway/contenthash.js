// Decode an EIP-1577 contenthash into an IPFS CIDv1 (base32, multibase 'b').
//
// WNS stores contenthash the same way ENS does. For IPFS the bytes are:
//   e3 01            <- ipfs-ns protocol code (0xe3) as unsigned varint
//   01 70 12 20 ..   <- the CIDv1: version=1, codec=dag-pb(0x70), sha2-256, 32B
//
// Stripping the 2-byte `e301` namespace prefix leaves the raw CIDv1 bytes,
// which we base32-encode to get the canonical `bafy…` string used by
// subdomain IPFS gateways (`https://<cid>.ipfs.<gw>`).

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' // RFC 4648, lowercase

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

// Convert a 0x-hex contenthash to a CIDv1 string, or null if it isn't an
// IPFS contenthash we can serve.
export function contenthashToCid(contenthash) {
  if (!contenthash) return null
  const hex = contenthash.replace(/^0x/, '').toLowerCase()

  // ipfs-ns (0xe3) encoded as the varint `e301`.
  if (hex.startsWith('e301')) {
    const cidBytes = hexToBytes(hex.slice(4))
    if (cidBytes.length === 0) return null
    return 'b' + base32Encode(cidBytes) // multibase 'b' = base32
  }

  // ipns-ns (0xe5) and other namespaces are not served by this gateway.
  return null
}
