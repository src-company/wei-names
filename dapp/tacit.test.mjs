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
import crypto from 'node:crypto';

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

// Tacit's kit, vendored unmodified. The pin is the SHA-256 Tacit publishes for it.
const KIT_PATH = path.join(here, 'vendor/tacit-address-kit.js');
const KIT_SHA256 = 'e1829fb389053a815dd2e977c0f08e35fd1bdad6d960a9dbc9a66b51307fb4f0';
// Imported from its bytes: the kit has no imports, and a data: URL is ESM on every
// supported Node, where a bare .js file outside a "type": "module" package isn't (Node 20).
const kit = await import('data:text/javascript;base64,' + fs.readFileSync(KIT_PATH).toString('base64'));

const ctx = vm.createContext({ ethers, BigInt, Error, Uint8Array, Array, String, RegExp, console });
vm.runInContext([
  liftConst('TACIT_BECH32'),
  ...['tacitPolymod', 'tacitHrpExpand', 'tacitConvertBits', 'tacitIsPoint', 'decodeTacitAddress', 'tacitIsCurrent'].map(lift),
].join('\n'), ctx, { filename: 'index.html:tacit' });
const fn = (n) => vm.runInContext(n, ctx);

// bech32m under the tacit HRP, for building payloads the validator must judge.
function bech32m(bytes) {
  const d5 = fn('tacitConvertBits')(Array.from(bytes), 8, 5, true);
  const pm = fn('tacitPolymod')(fn('tacitHrpExpand')('tacit').concat(d5, [0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
  const cs = [0, 1, 2, 3, 4, 5].map(i => (pm >>> (5 * (5 - i))) & 31);
  return 'tacit1' + d5.concat(cs).map(v => fn('TACIT_BECH32')[v]).join('');
}

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

// ── the vendored kit ────────────────────────────────────────────────────────
eq('vendored kit matches its pinned SHA-256',
   crypto.createHash('sha256').update(fs.readFileSync(KIT_PATH)).digest('hex'), KIT_SHA256);
const priv = new Uint8Array(32).fill(7);
eq('kit: key 0x07…07 without the pool lane is the older vector', kit.addressesFromKey(priv, { pool: false }).address, VECTOR);
eq('vector is 174 characters', VECTOR.length, 174);
const msg = kit.identityMessage();
eq('kit identity message is byte-exact', msg,
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
const enc = (bytes) => bech32m(bytes);
const spend = ethers.getBytes('0x02989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f');
const scan = ethers.getBytes('0x036d4fcf6cd1084f448d7ef18ef159dd27ad129d784978993cb89db49d112db0b3');
const pay = (v, f, ...rest) => [v, f, ...spend, ...scan, ...rest.flatMap(r => [...r])];
eq('re-encoding the vector payload round-trips', enc(pay(0, 3, spend)), VECTOR);
throws('version 1', () => decode(enc(pay(1, 3, spend))));
throws('Bitcoin lane only (no Ethereum-side key)', () => decode(enc(pay(0, 1))));
throws('flag 0x01 unset', () => decode(enc([0, 2, ...spend, ...scan, ...spend])));
throws('Ethereum-side key both written out and marked (0x83)', () => decode(enc(pay(0, 0x83, spend))));
throws('pool lane with no Ethereum-side key (0x05)', () => decode(enc(pay(0, 5, new Uint8Array(97)))));
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
const markedUnknown = enc([...pay(0, 0x8d, pool), 1, 2, 3]);
eq('unknown lane beside the 0x80 marker validates', decode(markedUnknown), markedUnknown);
throws('0x80 marker with a stray written-out key and no unknown lane', () => decode(enc(pay(0, 0x85, spend, pool))));

// Pinned in Tacit's tests/tacit-address-pool.mjs (57ae243).
const REAL_RECORD = 'tacit1qqpsxr8grjvk4asyvlk4aguyd0suvtmg3cevxxcznec82u70rrxps7hjqgedd68hq0su4dzzvcsl482xhz8put8p5fv7qctmg7k9twznf6lngqcvaqwfj6hkq3n76h4rs347r330dz8r9scmq208qatneuvvcxr67gpe2s29';
const UNIFIED = 'tacit1qzzs9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxqngxmx5kxhvt2xqfmf4rufjqgcrgplldjykhww6nnq83gv2kcplcplm0hgggeadk2kqtqtqrk6qpedvat59c6sdeam6ankwjfjgldpjp05v82lv45dajuwype9n88tfdv4d0ta6qyvd9zzzwq58ed9pq75emyyf75';
const EXPLICIT = 'tacit1qqrs9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxq5cns9hdj6k89clmjd77v0vqmp4vrejf8twa8jas0zhvf2edczldupxsdkdfvdwck5vqnkn28cnyq3sxsrl7myfdwua48xq0zsc4dsrlsrlklwss3n6mv4vqkqkq8d5qrj6e6hgt34qmnmh4m8vayny376ryzlgcw47etgmm9cugrjtxwwkj6e267hm5qgc62yyyupg0j62zpafjgjz2hf';
eq('a real .wei record validates', decode(REAL_RECORD), REAL_RECORD);
eq('unified (0x85) validates', decode(UNIFIED), UNIFIED);
eq('unified is 276 characters', UNIFIED.length, 276);
eq('written-out form (0x07) still validates', decode(EXPLICIT), EXPLICIT);
const v0 = [...spend, ...scan];
const short81 = enc([0, 0x81, ...v0]);
eq('marked, no pool lane (0x81, 121 characters) validates', decode(short81) === short81 && short81.length, 121);
eq('re-encoding the unified keys round-trips', enc([0, 0x85, ...v0, ...[...fn('tacitConvertBits')(Array.from(UNIFIED.slice(6, -6), c => fn('TACIT_BECH32').indexOf(c)), 5, 8, false)].slice(68)]), UNIFIED);
eq('kit: key 0x07…07 derives the unified vector', kit.addressesFromKey(priv).address, UNIFIED);
eq('current form: unified 0x85', fn('tacitIsCurrent')(UNIFIED), true);
eq('older form: written-out 0x07', fn('tacitIsCurrent')(EXPLICIT), false);
eq('older form: 0x03 (a real .wei record)', fn('tacitIsCurrent')(REAL_RECORD), false);
eq('older form: 0x81 (marked, no pool)', fn('tacitIsCurrent')(short81), false);
eq('current form with an unknown lane beside it', fn('tacitIsCurrent')(markedUnknown), true);
eq('invalid: not current', fn('tacitIsCurrent')('tacit1nope'), false);

// ── derive from wallet: the shipping deriveTacitAddress, with the kit ─────────
async function derive({ wallet, connected = wallet.address, code = '0x', v01 = false }) {
  const signer = {
    signMessage: async (m) => {
      const sig = ethers.getBytes(await wallet.signMessage(m));
      if (v01) sig[64] -= 27;
      return ethers.hexlify(sig);
    },
  };
  const c = vm.createContext({
    ethers, Error, Uint8Array, String, RegExp, _signer: signer, _connectedAddress: connected,
    withRpc: async f => f({ getCode: async () => code }), wcTransaction: p => p,
  });
  vm.runInContext(lift('deriveTacitAddress'), c);
  c.loadTacitKit = async () => kit;
  return vm.runInContext('deriveTacitAddress()', c);
}
const expectFor = async (wallet) => {
  const k = kit.keyFromSignature(ethers.getBytes(await wallet.signMessage(msg)), { address: wallet.address });
  return kit.addressesFromKey(k).address;
};
for (let i = 0; i < 6; i++) {
  const w = ethers.Wallet.createRandom();
  const a = await derive({ wallet: w, v01: i % 2 === 1 });
  eq(`derive: wallet ${i + 1}${i % 2 ? ' (v as 0/1)' : ''} gives its unified address`, a, await expectFor(w));
  if (i === 0) {
    eq('derive: 276 characters, starts tacit1qzz', a.length === 276 && a.startsWith('tacit1qzz'), true);
    eq('derive: result validates and is the current form', fn('tacitIsCurrent')(fn('decodeTacitAddress')(a)), true);
  }
}
const w0 = ethers.Wallet.createRandom();
let refused = null;
try { await derive({ wallet: w0, code: '0x6080604052' }); } catch (e) { refused = e.message; }
eq('derive: a contract wallet is refused', /Contract wallets/.test(refused || ''), true);
refused = null;
try { await derive({ wallet: w0, code: '0xef0100' + 'ab'.repeat(20) }); } catch (e) { refused = e.message; }
eq('derive: an EIP-7702 delegated account is allowed', refused, null);
refused = null;
try { await derive({ wallet: w0, connected: ethers.Wallet.createRandom().address }); } catch (e) { refused = e.message; }
eq('derive: a signature from another account is refused', !!refused, true);

// ── registration: the pending panel's box and what follows the reveal ─────────
// A DOM of just the elements these functions touch, and stubs for the chain.
const el = () => ({ value: '', checked: false, disabled: false, classList: { on: false, toggle(_, v) { this.on = v; } } });
const dom = { tacitOpt: { ...el(), style: {} }, tacitOn: el(), regTacitAddr: el(), regTacitNote: { textContent: '' } };
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
  liftConst('TACIT_RECORD_KEY'), liftConst('TACIT_BECH32'), liftConst('TACIT_PREF_PREFIX'),
  ...['tacitPolymod', 'tacitHrpExpand', 'tacitConvertBits', 'tacitIsPoint', 'decodeTacitAddress',
      'sanePending', 'tacitIsCurrent', 'tacitNameOk', 'tacitNote', 'tacitPref', 'lockTacitOpt', 'onTacitToggle', 'tacitChoice', 'writeTacitRecord', 'afterRegister'].map(lift),
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
await r('afterRegister')({ name: 'alice', owner, tacit: UNIFIED }, {});
const set = calls.find(c => c[0] === 'setText');
eq('afterRegister refreshes the name', calls[0][0] + ':' + calls[0][1], 'refresh:alice');
eq('afterRegister writes finance.tacit on the new id', set && set.slice(1).join('|'), `id:alice|finance.tacit|${UNIFIED}`);
eq('the address is remembered for this account', store.get('wei-tacit:' + owner.toLowerCase()), UNIFIED);

// The next commitment from the same account comes pre-ticked and pre-filled.
r('paintTacitOpt')({ name: 'bob', owner, commitment: '0x02' });
eq('next commitment: box pre-ticked', dom.tacitOn.checked, true);
eq('next commitment: address pre-filled', dom.regTacitAddr.value, UNIFIED);
eq('fields shown when ticked', dom.tacitOpt.classList.on, true);
// An older-form (0x03) remembered address does not pre-fill a new name.
store.set('wei-tacit:' + owner.toLowerCase(), VECTOR);
r('paintTacitOpt')({ name: 'bob2', owner, commitment: '0x03' });
eq('older remembered address: box left unticked', dom.tacitOn.checked, false);
store.set('wei-tacit:' + owner.toLowerCase(), EXPLICIT);
r('paintTacitOpt')({ name: 'bob3', owner, commitment: '0x04' });
eq('written-out 0x07 remembered: box left unticked', dom.tacitOn.checked, false);

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

// ── names Tacit can look up ─────────────────────────────────────────────────
const nameCtx = vm.createContext({ String });
vm.runInContext(lift('tacitNameOk'), nameCtx);
const nameOk = vm.runInContext('tacitNameOk', nameCtx);
for (const [n, want] of [['alice', true], ['z-0', true], ['blog.alice', true], ['123', true],
                         ['café', false], ['🦄', false], ['z_0', false], ['a..b', false], ['', false], ['.a', false]]) {
  eq(`tacitNameOk(${JSON.stringify(n)})`, nameOk(n), want);
}
// Hidden, unticked and never written for a name Tacit can't look up.
dom.tacitOn.checked = true; dom.regTacitAddr.value = UNIFIED;
store.set('wei-tacit:' + owner.toLowerCase(), UNIFIED);
r('paintTacitOpt')({ name: 'café', owner, commitment: '0x05' });
eq('unsupported name: option hidden', dom.tacitOpt.style.display, 'none');
eq('unsupported name: box unticked even with a remembered address', dom.tacitOn.checked, false);
reg.contract.setText = async (...a) => { calls.push(['setText', ...a]); return { hash: '0x' + '11'.repeat(32) }; };
calls.length = 0;
await r('afterRegister')({ name: 'café', owner, tacit: UNIFIED }, {});
eq('unsupported name: afterRegister writes nothing', calls.some(c => c[0] === 'setText'), false);

// ── format note ─────────────────────────────────────────────────────────────
dom.note = { textContent: 'stale' };
r('tacitNote')(REAL_RECORD, 'note');
eq('note: older 0x03 address is flagged', /Older Tacit address format/.test(dom.note.textContent), true);
r('tacitNote')(EXPLICIT, 'note');
eq('note: older 0x07 address is flagged', /Older/.test(dom.note.textContent), true);
r('tacitNote')(UNIFIED, 'note');
eq('note: current address clears it', dom.note.textContent, '');
r('tacitNote')('tacit1nope', 'note');
eq('note: invalid input says nothing (the save reports it)', dom.note.textContent, '');

// ── reload after the registration confirmed ────────────────────────────────
async function reload({ pending, owner: onChainOwner }) {
  const seen = [];
  const c = vm.createContext({
    ethers, CONTRACT: '0x' + '00'.repeat(20), ABI: [],
    loadPending: () => pending, hidePendingPanel: () => {}, displayPending: () => seen.push('display'),
    clearPending: () => seen.push('clear'), afterRegister: (p) => seen.push('afterRegister:' + p.name),
    localComputeId: () => 1n,
    withRpc: (() => { const q = [false, onChainOwner]; return async () => q.shift(); })(),
  });
  vm.runInContext(lift('initPending'), c);
  await vm.runInContext('initPending()', c);
  return seen.join(',');
}
eq('reload, ours, box was ticked: write it', await reload({ pending: { name: 'alice', owner, tacit: UNIFIED }, owner }), 'clear,afterRegister:alice');
eq('reload, ours, box unticked: just clear', await reload({ pending: { name: 'alice', owner }, owner }), 'clear');
eq('reload, someone else registered it: never write', await reload({ pending: { name: 'alice', owner, tacit: UNIFIED }, owner: '0x' + '77'.repeat(20) }), 'clear');

// ── derive & save never silently replaces a different current address ──────
async function deriveSave(existing, derived) {
  const seen = [];
  const c = vm.createContext({
    isProcessing: false, contract: {}, currentTokenId: 1n, currentTokenName: 'alice', currentTacitRecord: existing,
    $: () => null, tacitNote: () => {}, handleError: e => seen.push('error:' + e.message),
    showStatus: (m, t) => seen.push(t + ':' + m), deriveTacitAddress: async () => derived,
    writeTacitRecord: async (n, id, v) => seen.push('write:' + v.slice(0, 9)),
  });
  vm.runInContext([lift('decodeTacitAddress'), lift('tacitIsCurrent'), lift('tacitPolymod'), lift('tacitHrpExpand'),
                   lift('tacitConvertBits'), lift('tacitIsPoint'), liftConst('TACIT_BECH32'), lift('doTacitDeriveAndSave')].join('\n'),
                  Object.assign(c, { ethers, Uint8Array, Array, String, Error, BigInt }));
  await vm.runInContext('doTacitDeriveAndSave()', c);
  return seen;
}
const OTHER_UNIFIED = await (async () => { const w = ethers.Wallet.createRandom();
  return kit.addressesFromKey(kit.keyFromSignature(ethers.getBytes(await w.signMessage(msg)), { address: w.address })).address; })();
eq('derive & save: empty name gets written', (await deriveSave(null, UNIFIED)).some(x => x.startsWith('write:')), true);
eq('derive & save: older record gets upgraded', (await deriveSave(REAL_RECORD, UNIFIED)).some(x => x.startsWith('write:')), true);
eq('derive & save: same address, no transaction', (await deriveSave(UNIFIED, UNIFIED)).some(x => x.startsWith('write:')), false);
const clash = await deriveSave(OTHER_UNIFIED, UNIFIED);
eq('derive & save: a different current address is not replaced', clash.some(x => x.startsWith('write:')), false);
eq('derive & save: and says why', clash.some(x => /differs/.test(x)), true);

// ── saving what's already there sends nothing ──────────────────────────────
async function save(fnName, { existing, input, key = 'finance.tacit' }) {
  const seen = [];
  const c = vm.createContext({
    ethers, Uint8Array, Array, String, Error, BigInt,
    isProcessing: false, contract: { setText: async () => { seen.push('setText'); return { hash: '0x' }; } },
    currentTokenId: 1n, currentTokenName: 'alice', currentTacitRecord: existing,
    $: id => ({ tacitAddr: { value: input }, textKey: { value: key }, textValue: { value: input } })[id],
    showStatus: (m, t) => seen.push(t + ':' + m), handleError: e => seen.push('error:' + e.message),
    writeTacitRecord: async () => seen.push('setText'), wcTransaction: p => p, waitForTx: async () => ({}),
    refreshAfterTx: () => {}, panelRepainted: null,
  });
  vm.runInContext([liftConst('TACIT_RECORD_KEY'), liftConst('TACIT_BECH32'), ...['tacitPolymod', 'tacitHrpExpand', 'tacitConvertBits',
    'tacitIsPoint', 'decodeTacitAddress', fnName].map(lift)].join('\n'), c);
  await vm.runInContext(fnName + '()', c);
  return seen.includes('setText');
}
eq('Save pasted: unchanged address sends nothing', await save('doSetTacit', { existing: UNIFIED, input: UNIFIED.toUpperCase() }), false);
eq('Save pasted: a new address is written', await save('doSetTacit', { existing: REAL_RECORD, input: UNIFIED }), true);
eq('Set Text: unchanged tacit value sends nothing', await save('doSetText', { existing: UNIFIED, input: UNIFIED }), false);
eq('Set Text: clearing an empty tacit record sends nothing', await save('doSetText', { existing: null, input: '' }), false);
eq('Set Text: clearing a set tacit record is written', await save('doSetText', { existing: UNIFIED, input: '' }), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
