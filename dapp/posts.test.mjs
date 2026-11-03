// Pins the dapp's half of posts (posts/SPEC.md) to the gateway's and the publisher's.
//
// The publisher is paid only for the exact blob the author named, and the dapp names it by building
// the post's blob and hashing it with KZG. A dapp blob that differs from gateway/posts-format.js's
// by one byte names a blob nobody will ever build: the fee sits in escrow a day, the post never
// lands, and nothing on-chain says why. The same goes for the slug (a dead link) and the token id
// (the index lists another name's posts).
//
// Functions are lifted out of index.html by name and run in a vm sandbox, so this reads the
// shipping source rather than a copy of it. No network, no chain.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import { encodeBlob, encodePost, postHash, postPath } from '../gateway/posts-format.js';
import { blobVersionedHash } from './vendor/kzg.bundle.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));
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
const liftConst = (name) => {
  const line = SRC.find(l => new RegExp(`^const ${name} =`).test(l));
  if (!line) throw new Error(`index.html no longer defines ${name}`);
  return line;
};

const ctx = vm.createContext({ TextEncoder, Uint8Array, BigInt, JSON });
vm.runInContext([
  liftConst('POST_MAX_BYTES'), liftConst('POST_FEE_GAS'), liftConst('BLOB_GAS'),
  lift('postBlobFrom'), lift('postBytesFrom'), lift('postPathFor'), lift('postFeeFrom'), lift('tokenHexOf'),
  'this.out = { postBlobFrom, postBytesFrom, postPathFor, postFeeFrom, tokenHexOf, POST_MAX_BYTES };',
].join('\n'), ctx);
const dapp = ctx.out;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const s = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
  const g = s(got), w = s(want);
  if (g === w) { pass++; console.log('ok   ', label); }
  else { fail++; console.log('FAIL ', label, '\n  got ', g, '\n  want', w); }
};
const hex = (b) => Buffer.from(b).toString('hex');

const cases = [
  ['Exploring the blobspace', 'Markdown text…'],
  ['ünïcödé — and emoji 🦄', '$$\\frac{1}{2}$$\n\n> quote'],
  ['x', ''],
  ['A long one', 'y'.repeat(dapp.POST_MAX_BYTES - 40)],
];
for (const [title, body] of cases) {
  const bytes = dapp.postBytesFrom(title, body);
  const label = title.slice(0, 24);
  eq(`bytes: ${label} serialize as the gateway's`, hex(bytes), hex(encodePost({ title, body })));
  eq(`blob: ${label} is the gateway's blob, byte for byte`, hex(dapp.postBlobFrom(bytes)), hex(encodeBlob([bytes])));
  eq(`path: ${label}`, dapp.postPathFor(postHash(bytes), title), postPath(postHash(bytes), title));
}
eq('blob: a max-size post fills the payload exactly', dapp.POST_MAX_BYTES, 4096 * 31 - 8);
// A known post's versioned hash, as the gateway rebuilds and checks it (gateway/posts.test.mjs).
const known = dapp.postBytesFrom('Exploring the blobspace', 'Markdown text…');
eq('kzg: the dapp names the blob the gateway checks', blobVersionedHash(dapp.postBlobFrom(known)), blobVersionedHash(encodeBlob([known])));
eq('token: a name id as the index keys it', dapp.tokenHexOf(0xa11ce), '0x' + 'a11ce'.padStart(64, '0'));
// 3 x (54,500 gas at base + tip, plus a blob at the blob base fee), rounded up to a gwei.
eq('fee: three one-blob publishes', dapp.postFeeFrom(10n ** 9n, 10n ** 8n, 1n), (3n * (54500n * 1_100_000_000n + 131072n) + 999999999n) / 1000000000n * 1000000000n);
eq('fee: the tip is clamped to the publisher\'s ceiling', dapp.postFeeFrom(0n, 10n ** 12n, 0n), 3n * 54500n * 2_000_000_000n);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
