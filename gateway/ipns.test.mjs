import { decodeContenthash, swarmCid, swarmRefFromCid } from './contenthash.js'

// --- reimplement the dapp's encode path to build test contenthashes ---------
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function baseDecode(str, alpha) {
  const base = alpha.length
  const bytes = [0]
  for (const ch of str) {
    const v = alpha.indexOf(ch)
    if (v === -1) throw new Error('bad char ' + ch)
    let carry = v
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * base; bytes[i] = carry & 0xff; carry >>= 8 }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  for (let i = 0; i < str.length && str[i] === alpha[0]; i++) bytes.push(0)
  return new Uint8Array(bytes.reverse())
}
const hex = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

function encodeIpns(name) {
  let cidBytes
  if (name.startsWith('k')) cidBytes = baseDecode(name.slice(1), B36)
  else { const mh = baseDecode(name, B58); cidBytes = Uint8Array.from([0x01, 0x72, ...mh]) }
  return hex(Uint8Array.from([0xe5, 0x01, ...cidBytes]))
}

let pass = 0, fail = 0
function eq(label, got, want) {
  if (got === want) { pass++; console.log('ok   ', label) }
  else { fail++; console.log('FAIL ', label, '\n  got ', got, '\n  want', want) }
}

// 1. ed25519 IPNS name (base36) round-trips through encode -> on-chain -> decode
const ed = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8'
eq('ed25519 base36 round-trip', decodeContenthash(encodeIpns(ed)).id, ed)
eq('ed25519 ns', decodeContenthash(encodeIpns(ed)).ns, 'ipns')

// 2. legacy RSA peer id (base58 Qm...) -> should become a k... IPNS name
const qm = 'QmVLwvmGehsrNEvhcCnnsw5RQNseohgEkFNN1848zNzdng'
const decQm = decodeContenthash(encodeIpns(qm))
eq('Qm peer id -> ipns ns', decQm.ns, 'ipns')
eq('Qm peer id -> k-name', decQm.id.startsWith('k'), true)

// 3. IPFS still works (ipfs-ns 0xe3 + CIDv1)
//    encode a known CIDv1 (bafybeigdyrzt...) via base32
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
function b32dec(s) {
  let bits = 0, val = 0; const out = []
  for (const c of s) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff) } }
  return new Uint8Array(out)
}
const bafy = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const ipfsCh = hex(Uint8Array.from([0xe3, 0x01, ...b32dec(bafy.slice(1))]))
eq('ipfs round-trip id', decodeContenthash(ipfsCh).id, bafy)
eq('ipfs ns', decodeContenthash(ipfsCh).ns, 'ipfs')

// 4. junk / unsupported returns null
eq('null on empty', decodeContenthash('0x'), null)
eq('null on unknown ns', decodeContenthash('0xe801abcd'), null)

// 5. Swarm: swarm-ns 0xe4 + CIDv1 swarm-manifest keccak-256 + 32-byte ref
//    (swarm.eth's contenthash, as read from its ENS resolver).
const ref = '03b80b08353b288c08b161fcf0e904eff3001c88006bcc7087290929197eb69f'
const swarmCh = '0xe40101fa011b20' + ref
eq('swarm ns', decodeContenthash(swarmCh).ns, 'swarm')
eq('swarm id is the bare 64-hex reference', decodeContenthash(swarmCh).id, ref)
eq('swarm: upper-case hex normalised', decodeContenthash(swarmCh.toUpperCase().replace('0X', '0x')).id, ref)
eq('swarm: truncated reference -> null', decodeContenthash('0xe40101fa011b20' + ref.slice(2)), null)
eq('swarm: over-long reference -> null', decodeContenthash(swarmCh + '00'), null)
eq('swarm: bare protocol code -> null', decodeContenthash('0xe401'), null)
// 64-byte encrypted references (digest length 0x40) are not served.
eq('swarm: encrypted (64-byte) reference -> null', decodeContenthash('0xe40101fa011b40' + ref + ref), null)

// 6. Swarm content label: base32 CIDv1, one DNS label, round-trips.
const cid = swarmCid(ref)
eq('swarm cid', cid, 'bah5acgzaao4awcbvhmuiycfrmh6pb2ie57zqaheiabv4y4ehfeessgl6w2pq')
eq('swarm cid fits a DNS label', cid.length <= 63, true)
eq('swarm cid -> ref', swarmRefFromCid(cid), ref)
eq('swarm cid: an IPFS CID is not one', swarmRefFromCid(bafy), null)
eq('swarm cid: wrong length -> null', swarmRefFromCid(cid.slice(0, -1)), null)
eq('swarm cid: bad character -> null', swarmRefFromCid(cid.slice(0, -1) + '1'), null)
// The last character's 4 spare bits: the 15 other spellings with the same data
// bit (last char q..7, value >= 16, like the canonical 'q') decode to these same
// bytes, and every one must be refused. (a..p flip the bit: another reference.)
const B32A = 'abcdefghijklmnopqrstuvwxyz234567'
const aliases = [...B32A.slice(16)].map((ch) => cid.slice(0, -1) + ch).filter((l) => l !== cid)
eq('swarm cid: 15 same-bytes aliases', aliases.length, 15)
eq('swarm cid: all refused', aliases.filter((l) => swarmRefFromCid(l) !== null).length, 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
