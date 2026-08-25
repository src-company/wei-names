// Pins the namehash identity that lets showManage() drop a round-trip.
//
// A taken subdomain used to cost three chained public-RPC calls: the availability
// multicall, then showManage()'s batch, then a lone records(record.parent) to decide
// whether the parent had been re-registered underneath it. That third call is now
// folded into showManage()'s batch, which means asking for records(parent) BEFORE
// the chain has told us what the parent is — the id is derived locally instead.
//
// That derivation is only sound because the contract's computeId is a recursive
// namehash: the id of `blog.vitalik.wei` is keccak(id_of(`vitalik.wei`) || keccak
// ("blog")), so the parent's id is just computeIdFull() of the remaining labels.
// showManage() still refuses to use the derived id unless the chain's own
// record.parent agrees with it, so a break here is a lost optimization rather than
// a wrong answer — but it would be silent, hence this file.
//
// Functions are lifted out of index.html by name and run in a vm sandbox, so this
// reads the shipping source rather than a copy of it. No network, no chain.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const ethers = (await import(path.join(here, 'vendor/ethers.min.js'))).default
  ?? (await import(path.join(here, 'vendor/ethers.min.js')));

const SRC = fs.readFileSync(path.join(here, 'index.html'), 'utf8').split('\n');

// Lift `function name(...) { ... }` out of index.html by brace matching.
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

const ctx = vm.createContext({ ethers, BigInt, Error, console });
vm.runInContext(
  "const ROOT_NODE = '0x' + '00'.repeat(32);\n" + lift('computeIdFull'),
  ctx,
  { filename: 'index.html:computeIdFull' }
);
const computeIdFull = (n) => vm.runInContext('computeIdFull', ctx)(n);

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; console.log('ok   ', label); }
  else { fail++; console.log('FAIL ', label, '\n  got ', got, '\n  want', want); }
}

// showManage() derives the parent id exactly this way. Kept in sync by hand with
// the one-liner in index.html; if that expression changes, change it here too.
const derivedParentId = (name) =>
  name.includes('.') ? computeIdFull(name.split('.').slice(1).join('.')) : null;

// ── computeIdFull is a real namehash ─────────────────────────────────────────
// ethers.namehash is an independent implementation of the same algorithm, so it
// is a fair oracle for the ids the contract stores.
for (const n of ['vitalik', 'blog.vitalik', 'a.b.c', 'wns']) {
  eq(`computeIdFull(${n}) is namehash(${n}.wei)`,
     computeIdFull(n), BigInt(ethers.namehash(n + '.wei')));
}

// ...and it does not care whether the caller already appended .wei, which matters
// because showManage() feeds it a parent chain sliced off a full name.
eq('the .wei suffix is optional', computeIdFull('blog.vitalik'), computeIdFull('blog.vitalik.wei'));

// ── the load-bearing property ────────────────────────────────────────────────
// For every subdomain, the locally derived parent id must equal the id the
// contract stores in records(child).parent — which is namehash of the parent name.
{
  const cases = [
    ['blog.vitalik', 'vitalik.wei'],
    ['send.slow', 'slow.wei'],
    ['a.b.c', 'b.c.wei'],
    ['deep.a.b.c', 'a.b.c.wei'],
  ];
  for (const [child, parentFull] of cases) {
    eq(`parent of ${child} is namehash(${parentFull})`,
       derivedParentId(child), BigInt(ethers.namehash(parentFull)));
  }
}

// A top-level name has no parent to prefetch; showManage() must skip the extra
// call slot entirely rather than asking for records(0).
eq('a top-level name derives no parent', derivedParentId('vitalik'), null);

// Sanity: a wrong parent really is a different id, so the record.parent ===
// parentIdGuess guard in showManage() is capable of catching a mismatch.
eq('a different parent is a different id',
   derivedParentId('blog.vitalik') === derivedParentId('blog.someone'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
