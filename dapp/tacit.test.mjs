// Pins the Tacit address codec, validator and key derivation against the vector
// published in the Tacit integration spec (tests/tacit-address-pool.mjs upstream).
// A record that doesn't match what Tacit apps derive would send payments nowhere,
// so the derivation must be byte-exact with theirs.
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

function liftConst(name) {
  const line = SRC.find(l => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`index.html no longer defines const ${name}`);
  return line;
}

const ctx = vm.createContext({ ethers, BigInt, Error, Uint8Array, Array, String, console });
vm.runInContext([
  liftConst('TACIT_BECH32'), liftConst('SECP_N'),
  ...['tacitPolymod', 'tacitHrpExpand', 'tacitConvertBits', 'tacitBech32mEncode', 'tacitIsPoint',
      'decodeTacitAddress', 'tacitIdentityMessage', 'tacitAddressFromPriv'].map(lift),
].join('\n'), ctx, { filename: 'index.html:tacit' });
const fn = (n) => vm.runInContext(n, ctx);

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; console.log('ok   ', label); }
  else { fail++; console.log('FAIL ', label, '\n  got ', got, '\n  want', want); }
}
function throws(label, f) {
  try { f(); fail++; console.log('FAIL ', label, '(did not throw)'); }
  catch (e) { pass++; console.log('ok   ', label, '—', e.message); }
}

const VECTOR = 'tacit1qqps9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxq5cns9hdj6k89clmjd77v0vqmp4vrejf8twa8jas0zhvf2edczlduk6e0c7';

// ── derivation ──────────────────────────────────────────────────────────────
const priv = new Uint8Array(32).fill(7);
eq('priv 0x07…07 derives the spec vector', fn('tacitAddressFromPriv')(priv), VECTOR);
eq('vector is 174 characters', VECTOR.length, 174);
eq('priv is zeroed after derivation', priv.every(b => b === 0), true);

// priv ≥ n takes the documented rehash branch rather than throwing.
const big = new Uint8Array(32).fill(0xff);
eq('priv ≥ n still derives a valid address',
   fn('decodeTacitAddress')(fn('tacitAddressFromPriv')(big)).startsWith('tacit1'), true);

// ── identity message ────────────────────────────────────────────────────────
const msg = fn('tacitIdentityMessage')();
eq('identity message is byte-exact', msg,
  'Tacit identity\n\nSigning this creates your Tacit private key. Anyone who has this signature controls all of your Tacit funds.\n\nSign it only in a Tacit app you trust. Every Tacit app asks for exactly this message.\n\nnetwork: mainnet\nversion: 1');

// ── validation ──────────────────────────────────────────────────────────────
const decode = fn('decodeTacitAddress');
eq('vector validates', decode(VECTOR), VECTOR);
eq('surrounding whitespace is trimmed', decode('  ' + VECTOR + '\n'), VECTOR);
eq('all-uppercase is accepted and stored lowercase', decode(VECTOR.toUpperCase()), VECTOR);
throws('mixed case', () => decode(VECTOR.slice(0, 20) + VECTOR.slice(20).toUpperCase()));
throws('typo breaks checksum', () => decode(VECTOR.slice(0, -1) + (VECTOR.endsWith('q') ? 'p' : 'q')));
throws('wrong prefix', () => decode(VECTOR.replace(/^tacit1/, 'tactt1')));
throws('empty', () => decode(''));

// Build variants with the shipping encoder to exercise the payload rules.
const enc = (bytes) => fn('tacitBech32mEncode')('tacit', Uint8Array.from(bytes));
const spend = ethers.getBytes('0x02989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f');
const scan = ethers.getBytes('0x036d4fcf6cd1084f448d7ef18ef159dd27ad129d784978993cb89db49d112db0b3');
const pay = (v, f, ...rest) => [v, f, ...spend, ...scan, ...rest.flatMap(r => [...r])];
eq('re-encoding the vector payload round-trips', enc(pay(0, 3, spend)), VECTOR);
throws('version 1', () => decode(enc(pay(1, 3, spend))));
throws('Bitcoin lane only (no Ethereum lane)', () => decode(enc(pay(0, 1))));
throws('flag 0x01 unset', () => decode(enc([0, 2, ...spend, ...scan, ...spend])));
throws('trailing byte with no unknown flag', () => decode(enc([...pay(0, 3, spend), 0])));
const badPoint = new Uint8Array(33); badPoint[0] = 2; badPoint[32] = 5; // x=5 is not on the curve
throws('invalid Ethereum-side key', () => decode(enc(pay(0, 3, badPoint))));
const pool = new Uint8Array(97); pool.set(scan, 0); pool.fill(9, 33);
const withPool = enc(pay(0, 7, spend, pool));
eq('pool lane (flags 0x07) validates', decode(withPool), withPool);
eq('pool address is 329 characters', withPool.length, 329);
const unknown = enc([...pay(0, 0x0b, spend), 1, 2, 3]);
eq('unknown lane with extra bytes validates', decode(unknown), unknown);
throws('unknown lane shorter than known lanes', () => decode(enc(pay(0, 0x0b))));

// ── registration: the pending panel's box and what follows the reveal ─────────
// A DOM of just the elements these functions touch, and stubs for the chain.
const el = () => ({ value: '', checked: false, disabled: false, classList: { on: false, toggle(_, v) { this.on = v; } } });
const dom = { tacitOpt: el(), tacitOn: el(), regTacitAddr: el() };
const store = new Map();
const calls = [];
const reg = vm.createContext({
  ethers, BigInt, Error, Uint8Array, Array, String, Number, JSON, console,
  $: id => dom[id],
  localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  HASH32_RE: /^0x[0-9a-fA-F]{64}$/,
  contract: { setText: async (...a) => { calls.push(['setText', ...a]); return { hash: '0x' + '11'.repeat(32) }; } },
  _connectedAddress: '0x' + 'aB'.repeat(20),
  wcTransaction: p => p, waitForTx: async () => ({ blockNumber: 1 }),
  showStatus: (m, t) => calls.push(['status', t, m]),
  refreshAfterTx: (...a) => { calls.push(['refresh', a[0]]); return Promise.resolve(true); },
  nameRegistered: 'nameRegistered', panelRepainted: 'panelRepainted',
  localComputeId: n => 'id:' + n,
});
vm.runInContext([
  liftConst('TACIT_RECORD_KEY'), liftConst('TACIT_BECH32'), liftConst('SECP_N'), liftConst('TACIT_PREF_PREFIX'),
  ...['tacitPolymod', 'tacitHrpExpand', 'tacitConvertBits', 'tacitIsPoint', 'decodeTacitAddress',
      'sanePending', 'tacitPref', 'lockTacitOpt', 'onTacitToggle', 'tacitChoice', 'writeTacitRecord', 'afterRegister'].map(lift),
  SRC.find(l => l.startsWith('let _tacitOptFor')), lift('paintTacitOpt'),
].join('\n'), reg, { filename: 'index.html:tacit-register' });
const r = (n) => vm.runInContext(n, reg);
const owner = r('_connectedAddress');

// First commitment for an account with no history: unticked, empty.
r('paintTacitOpt')({ name: 'alice', owner, commitment: '0x01' });
eq('no remembered address: box unticked', dom.tacitOn.checked, false);
eq('unticked: choice is null', r('tacitChoice')(), null);

// Ticked with a bad address: the reveal must stop before paying.
dom.tacitOn.checked = true; dom.regTacitAddr.value = 'tacit1nope';
throws('ticked with a bad address', () => r('tacitChoice')());
dom.regTacitAddr.value = VECTOR.toUpperCase();
eq('ticked with a good address: normalised value', r('tacitChoice')(), VECTOR);

// A repaint of the SAME commitment keeps what the user typed.
dom.regTacitAddr.value = 'typing…';
r('paintTacitOpt')({ name: 'alice', owner, commitment: '0x01' });
eq('repaint of the same commitment leaves input alone', dom.regTacitAddr.value, 'typing…');

// Storage is untrusted: a bad saved address is dropped, a good one kept.
const secret = '0x' + '22'.repeat(32);
eq('sanePending keeps a valid tacit', r('sanePending')({ name: 'a', timestamp: 1, secret, tacit: VECTOR }).tacit, VECTOR);
eq('sanePending drops an invalid tacit', 'tacit' in r('sanePending')({ name: 'a', timestamp: 1, secret, tacit: '<img>' }), false);

// After registering with the box ticked: refresh, then one setText on the new name.
calls.length = 0;
await r('afterRegister')({ name: 'alice', owner, tacit: VECTOR }, {});
const set = calls.find(c => c[0] === 'setText');
eq('afterRegister refreshes the name', calls[0][0] + ':' + calls[0][1], 'refresh:alice');
eq('afterRegister writes finance.tacit on the new id', set && set.slice(1).join('|'), `id:alice|finance.tacit|${VECTOR}`);
eq('the address is remembered for this account', store.get('wei-tacit:' + owner.toLowerCase()), VECTOR);

// The next commitment from the same account comes pre-ticked and pre-filled.
r('paintTacitOpt')({ name: 'bob', owner, commitment: '0x02' });
eq('next commitment: box pre-ticked', dom.tacitOn.checked, true);
eq('next commitment: address pre-filled', dom.regTacitAddr.value, VECTOR);
eq('fields shown when ticked', dom.tacitOpt.classList.on, true);

// Unticked: nothing beyond the refresh.
calls.length = 0;
await r('afterRegister')({ name: 'carol', owner }, {});
eq('unticked: no setText', calls.some(c => c[0] === 'setText'), false);

// Registered but a different wallet is connected now: no tx, a pointer to Manage.
calls.length = 0;
await r('afterRegister')({ name: 'dave', owner: '0x' + '99'.repeat(20), tacit: VECTOR }, {});
eq('other wallet connected: no setText', calls.some(c => c[0] === 'setText'), false);
eq('other wallet connected: says where to finish', calls.some(c => c[0] === 'status' && /Manage/.test(c[2])), true);

// Wallet rejects the setText: registration still reads as done, no throw.
reg.contract.setText = async () => { throw new Error('user rejected'); };
calls.length = 0;
await r('afterRegister')({ name: 'erin', owner, tacit: VECTOR }, {});
eq('rejected setText: explains, does not throw', calls.some(c => c[0] === 'status' && /registered/.test(c[2]) && /Manage/.test(c[2])), true);

r('lockTacitOpt')(true);
eq('locked once the reveal is out', dom.tacitOn.disabled && dom.regTacitAddr.disabled, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
