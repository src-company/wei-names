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
  'swarmRefFromCid', 'contentLink',
];

const ctx = {
  ethers, console, Math, Number, String, JSON, Object, Array, BigInt, Error,
  // Host-realm constructors: bytes built inside the vm must satisfy ethers'
  // `instanceof Uint8Array` checks, which do not hold across realms.
  Uint8Array, TextEncoder,
  BASE58_ALPHABET: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  BASE32_ALPHABET: 'abcdefghijklmnopqrstuvwxyz234567',
  BASE36_ALPHABET: '0123456789abcdefghijklmnopqrstuvwxyz',
  WEI_GATEWAY: 'wei.domains',
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

// Swarm: bzz://<64 hex> -> swarm-ns contenthash, byte-for-byte what swarm.eth
// stores, and back to a DNS-label CID plus the bare reference.
const SWARM_REF = '03b80b08353b288c08b161fcf0e904eff3001c88006bcc7087290929197eb69f';
const SWARM_CH = '0xe40101fa011b20' + SWARM_REF;
for (const [label, input] of [
  ['bzz://',                   'bzz://' + SWARM_REF],
  ['bzz:// trailing slash',    'bzz://' + SWARM_REF + '/'],
  ['/bzz/ prefix',             '/bzz/' + SWARM_REF],
  ['upper-case hex',           'bzz://' + SWARM_REF.toUpperCase()],
  ['0x-prefixed reference',    'bzz://0x' + SWARM_REF],
]) {
  let encoded = null, out = null, err = null;
  try { encoded = hex(H.encodeContenthash(input)); out = H.decodeContenthash(encoded); } catch (e) { err = e.message; }
  ok(`accepts Swarm ${label}`, !err && encoded === SWARM_CH && out?.ns === 'swarm' && out.ref === SWARM_REF,
     err ? 'threw: ' + err : 'encoded ' + encoded + ' decoded ' + JSON.stringify(out));
}
{
  const out = H.decodeContenthash(SWARM_CH);
  ok('Swarm decodes to the gateway label CID',
     out?.id === 'bah5acgzaao4awcbvhmuiycfrmh6pb2ie57zqaheiabv4y4ehfeessgl6w2pq', JSON.stringify(out));
  ok('Swarm label fits one DNS label', out && out.id.length <= 63);
}

// The CID the manage panel links to pastes back in, bare or behind bzz://.
const SWARM_CID = 'bah5acgzaao4awcbvhmuiycfrmh6pb2ie57zqaheiabv4y4ehfeessgl6w2pq';
for (const [label, input] of [['bare bah5acgza CID', SWARM_CID], ['bzz:// + CID', 'bzz://' + SWARM_CID]]) {
  let encoded = null, err = null;
  try { encoded = hex(H.encodeContenthash(input)); } catch (e) { err = e.message; }
  ok(`accepts Swarm ${label}`, encoded === SWARM_CH, err ? 'threw: ' + err : 'encoded ' + encoded);
}

// The manage panel's Content link: labelled by the hash people paste, linked by
// the CID the gateway's content-label surface serves.
{
  const link = H.contentLink(H.decodeContenthash(SWARM_CH));
  ok('Swarm Content link -> gateway CID label', link.href === `https://${SWARM_CID}.wei.domains`, link.href);
  ok('Swarm Content link label is the bzz:// hash', link.label === 'bzz://03b80b08353b...7eb69f', link.label);
  const ipns = H.contentLink(H.decodeContenthash(hex(H.encodeContenthash(IPNS[0][1]))));
  ok('IPNS Content link unchanged', ipns.label.startsWith('ipns://k51') && ipns.href.startsWith('https://k51'), JSON.stringify(ipns));
}

// The dapp and the gateway must agree on every Swarm value, not just one.
{
  const gw = await import(path.join(here, '../gateway/contenthash.js'));
  let bad = null;
  for (let i = 0; i < 500 && !bad; i++) {
    const ref = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
    const ch = hex(H.encodeContenthash('bzz://' + ref));
    const dapp = H.decodeContenthash(ch);
    const served = gw.decodeContenthash(ch);
    if (!served || served.ns !== 'swarm' || served.id !== ref || dapp.ref !== ref || dapp.id !== gw.swarmCid(ref) ||
        gw.swarmRefFromCid(dapp.id) !== ref || hex(H.encodeContenthash(dapp.id)) !== ch) {
      bad = { ref, ch, dapp, served };
    }
  }
  ok('dapp and gateway agree on 500 random Swarm references', !bad, JSON.stringify(bad));
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
  // An IPFS CID behind ipns:// is well formed but not a libp2p-key; gateways refuse it.
  ['IPFS CID as an IPNS name', 'ipns://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
  ['empty Swarm reference',   'bzz://'],
  ['short Swarm reference',   'bzz://' + 'ab'.repeat(31)],
  ['non-hex Swarm reference', 'bzz://' + 'zz'.repeat(32)],
  ['Swarm reference + path',  'bzz://' + 'ab'.repeat(32) + '/index.html'],
  ['encrypted Swarm reference (64 bytes)', 'bzz://' + 'ab'.repeat(64)],
];
for (const [label, input] of JUNK) {
  let threw = false, encoded = null;
  try { encoded = hex(H.encodeContenthash(input)); } catch (e) { threw = true; }
  ok(`rejects ${label}`, threw, threw ? '' : `encoded to ${encoded} — this would be written on-chain`);
}

// ── Swarm in the wrong shape: rejected before it costs gas, and told how ─────
// doSetContent shows a message only if it mentions one of these; anything else
// goes to handleError as wallet jargon.
const SHOWN = m => m.includes('CID') || m.includes('IPNS name') || m.includes('Swarm reference');
ok('doSetContent still filters on those strings',
   SRC.join('\n').includes("e.message?.includes('CID') || e.message?.includes('IPNS name') || e.message?.includes('Swarm reference')"));
const REF_F = 'f' + SWARM_REF.slice(1); // a hash starting with f once fell into the base16 CID branch
for (const [label, input, want] of [
  ['swarm CID as base16 IPFS (f01fa…)', 'f01fa011b20' + SWARM_REF,            /Swarm reference, not IPFS/],
  ['0x + bare hash (raw passthrough)',  '0x' + SWARM_REF,                      /bare Swarm reference/],
  ['bare hash',                          SWARM_REF,                             /bzz:\/\/<64 hex/],
  ['bare hash starting with f',          REF_F,                                 /bzz:\/\/<64 hex/],
  ['gateway URL',                        'https://download.gateway.ethswarm.org/bzz/' + SWARM_REF + '/', /bzz:\/\/<64 hex/],
  ['swarm://',                           'swarm://' + SWARM_REF,                /bzz:\/\/<64 hex/],
  ['bzz:/ (one slash)',                  'bzz:/' + SWARM_REF,                   /bzz:\/\/<64 hex/],
  ['hash + path',                        'bzz://' + SWARM_REF + '/index.html',  /path or query/],
  ['hash + query',                       'bzz://' + SWARM_REF + '?a=1',         /path or query/],
  ['hash + fragment',                    'bzz://' + SWARM_REF + '#x',           /path or query/],
  ['mangled CID behind bzz://',          'bzz://' + SWARM_CID.slice(0, -1),     /incomplete or mistyped/],
]) {
  let msg = null, encoded = null;
  try { encoded = hex(H.encodeContenthash(input)); } catch (e) { msg = e.message; }
  ok(`rejects ${label}, with a shown message`, msg !== null && want.test(msg) && SHOWN(msg),
     msg === null ? `encoded to ${encoded} — this would be written on-chain` : 'message: ' + msg);
}

// ── decode never renders a bogus CID for a malformed stored value ────────────
for (const [label, stored] of [
  ['truncated CIDv1 (was "bae")', '0xe30101'],
  ['bare protocol code',          '0xe301'],
  ['empty',                       '0x'],
  ['unknown protocol',            '0xffff'],
  ['truncated multihash',         '0xe3011220'],
  ['truncated IPNS',              '0xe501'],
  ['bare Swarm protocol code',    '0xe401'],
  ['truncated Swarm reference',   '0xe40101fa011b20' + 'ab'.repeat(31)],
  ['Swarm, wrong codec',          '0xe40101fb011b20' + 'ab'.repeat(32)],
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
