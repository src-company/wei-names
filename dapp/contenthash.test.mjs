// ENSIP-7 contenthash codec tests.
//
// Set Website is the only field in the dapp with a parsed binary encoding, and it
// was the only write path with no validation on its input — every other one checks
// (isAddress, normalizeLabel, recipient resolution). So a truncated or mistyped CID
// decoded to a few stray bytes and sailed straight through: "bafZZZ" encoded to
// 0xe30101739c, setContenthash wrote that on-chain for real gas, the website was
// dead, and the manage panel rendered the junk back as a plausible-looking "bafzzy".
// Nothing anywhere told the user the value was wrong.
//
// Functions are lifted out of index.html by name, so these read the shipping source.
// No network, no chain, no dependencies beyond the vendored ethers.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const mod = await import(path.join(here, 'vendor/ethers.min.js'));
const ethers = mod.default ?? mod;

const SRC = fs.readFileSync(path.join(here, 'index.html'), 'utf8').split('\n');

function lift(name) {
  const re = new RegExp(`^(async )?function ${name}\\s*\\(`);
  const start = SRC.findIndex(l => re.test(l));
  if (start < 0) throw new Error(`index.html no longer defines ${name}()`);
  let depth = 0;
  const out = [];
  for (let i = start; i < SRC.length; i++) {
    out.push(SRC[i]);
    for (const ch of SRC[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth === 0 && out.join('').includes('{')) return out.join('\n');
  }
  throw new Error(`unterminated ${name}()`);
}

const LIFTED = [
  'base58Decode', 'base32Decode', 'base32Encode', 'base36Encode', 'base36Decode',
  'encodeUvarint', 'isWellFormedCidV1', 'decodeContenthash', 'encodeIpnsCid', 'encodeContenthash',
];

const ctx = {
  ethers, console, Math, Number, String, JSON, Object, Array, BigInt, Error,
  // Host-realm constructors: bytes built inside the vm must satisfy ethers'
  // `instanceof Uint8Array` checks, which do not hold across realms.
  Uint8Array, TextEncoder,
  BASE58_ALPHABET: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  BASE32_ALPHABET: 'abcdefghijklmnopqrstuvwxyz234567',
  BASE36_ALPHABET: '0123456789abcdefghijklmnopqrstuvwxyz',
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(LIFTED.map(lift).join('\n\n'), ctx);

const H = ctx;
const hex = v => (typeof v === 'string' ? v : ethers.hexlify(v));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok    ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

// ── real CIDs must survive encode -> decode untouched ─────────────────────────
// Deliberately spread across codecs and hash functions: the validator is
// structural, and must not quietly become a sha2-256/dag-pb allowlist.
const REAL = [
  ['CIDv0 dag-pb',      'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'],
  ['CIDv0 dag-pb (2)',  'QmRAQB6YaCyidP37UdDnjFY5vQuiBrcqdyoW1CuDgwxkD4'],
  ['CIDv1 bafybei',     'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
  ['CIDv1 bafkrei raw', 'bafkreidon7ino2b7c2n6xnbrs7dgstjqz2y3rgnqjs2vgqrqxpwjqvmzfy'],
  ['ipfs:// prefix',    'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
  ['/ipfs/ prefix',     '/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'],
];
for (const [label, input] of REAL) {
  let out, err = null;
  try { out = H.decodeContenthash(hex(H.encodeContenthash(input))); } catch (e) { err = e.message; }
  ok(`accepts ${label}`, !err && out && out.ns === 'ipfs' && /^b[a-z2-7]+$/.test(out.id),
     err ? 'threw: ' + err : 'decoded: ' + JSON.stringify(out));
}

const IPNS = [
  ['ipns://k51 (ed25519 identity mh)', 'ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8'],
  ['bare k51',                          'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8'],
  ['/ipns/ prefix',                     '/ipns/k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8'],
];
for (const [label, input] of IPNS) {
  let out, err = null;
  try { out = H.decodeContenthash(hex(H.encodeContenthash(input))); } catch (e) { err = e.message; }
  ok(`accepts ${label}`, !err && out && out.ns === 'ipns' && out.id.startsWith('k51'),
     err ? 'threw: ' + err : 'decoded: ' + JSON.stringify(out));
}

// A sha2-256-hashed IPNS key (large RSA keys use one instead of the identity
// multihash) must be accepted too.
{
  const digest = new Uint8Array(32).fill(7);
  const bytes = new Uint8Array([0x01, 0x72, 0x12, 0x20, ...digest]);
  ok('accepts sha2-256 IPNS key (not just identity multihash)', H.isWellFormedCidV1(bytes));
}

// ── junk must be REJECTED before it can cost a transaction ───────────────────
const JUNK = [
  ['truncated base32 CID',  'bafZZZ'],
  ['barely-there CID',      'bafy'],
  ['short base58 multihash', 'Qmabc'],
  ['empty IPNS name',       'ipns://'],
  ['one-char IPNS name',    'ipns://k'],
  ['two-char IPNS name',    '/ipns/kx'],
  ['stub base16 CID',       'f12'],
  ['padded-but-wrong CID',  'bafaaaaaaaaaa'],
];
for (const [label, input] of JUNK) {
  let threw = false, encoded = null;
  try { encoded = hex(H.encodeContenthash(input)); } catch (e) { threw = true; }
  ok(`rejects ${label}`, threw, threw ? '' : `encoded to ${encoded} — this would be written on-chain`);
}

// ── decode never renders a bogus CID for a malformed stored value ────────────
for (const [label, stored] of [
  ['truncated CIDv1 (was "bae")', '0xe30101'],
  ['bare protocol code',          '0xe301'],
  ['empty',                       '0x'],
  ['unknown protocol',            '0xffff'],
  ['truncated multihash',         '0xe3011220'],
  ['truncated IPNS',              '0xe501'],
]) {
  let out, threw = false;
  try { out = H.decodeContenthash(stored); } catch (e) { threw = true; }
  ok(`decode: ${label} -> null`, !threw && out === null,
     threw ? 'threw' : 'got ' + JSON.stringify(out));
}

// The raw 0x passthrough stays an explicit escape hatch for advanced users.
ok('raw 0x passthrough still allowed',
   hex(H.encodeContenthash('0xe30101701220' + 'ab'.repeat(32)))
     === '0xe30101701220' + 'ab'.repeat(32));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
