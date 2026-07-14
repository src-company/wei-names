import { decodeContenthash } from './contenthash.js'

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
