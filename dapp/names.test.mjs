// "your names" panel tests, against a minimal DOM shim.
//
// The panel answers a question the contract cannot: NameNFT is not
// ERC721Enumerable, so the list is reconstructed from the Transfer log and
// re-checked with ownerOf. Three things can make that quietly wrong, and each is
// pinned here:
//
// 1. ownerOf is not expiry-aware. A name years past its grace still names its
//    last owner and still counts in balanceOf, so expiry has to be a status on
//    the row, never a filter before it.
// 2. A subdomain's records().expiresAt is 0 — it inherits the root's. Reading the
//    0 at face value dates every subdomain to 1970 and calls it expired.
// 3. records() decodes to (label, parent, expiresAt, …). Skipping the leading
//    string shifts every field after it, silently.
//
// Plus the scan itself: it must walk to an endpoint that will serve a full-range
// eth_getLogs, must re-scan only the blocks since the last one, must not paint a
// list the account changed out from under, and must say so rather than shrink
// when balanceOf disagrees with what it could read.
//
// Functions are lifted out of index.html by name and run in a vm sandbox, so the
// tests read the shipping source rather than a copy of it. No network, no chain,
// no dependencies beyond the vendored ethers.
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

// Same, for a `const NAME = ...;` declaration. Brackets and the terminating `;`
// are counted outside strings and trailing `//` comments.
function liftConst(name) {
  const start = SRC.findIndex(l => new RegExp(`^const ${name}\\s*=`).test(l));
  if (start < 0) throw new Error(`index.html no longer defines ${name}`);
  let depth = 0;
  const out = [];
  for (let i = start; i < SRC.length; i++) {
    out.push(SRC[i]);
    let quote = null, last = '';
    for (let j = 0; j < SRC[i].length; j++) {
      const ch = SRC[i][j];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '/' && SRC[i][j + 1] === '/') break;
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (!/\s/.test(ch)) last = ch;
    }
    if (depth === 0 && last === ';') return out.join('\n');
  }
  throw new Error(`unterminated ${name}`);
}

const CONSTS = ['NAMES_DEPLOY_BLOCK', 'NAMES_TRANSFER', 'NAMES_LOG_FIRST', 'NAMES_GRACE',
  'NAMES_SOON', 'NAMES_CHUNK', 'NAMES_RANK', 'LOG_ENDPOINTS_FIRST'];

const ALL = ['anyEndpoint', 'namesReceived', 'namesRead', 'namesRoot', 'namesRootExpiry',
  'namesClassify', 'namesOrder', 'namesScan', 'namesError', 'namesDate', 'namesDays',
  'namesWhen', 'namesRow', 'namesPick', 'namesFooter', 'namesRender', 'namesPanelOpen',
  'namesSetToggle', 'toggleNames', 'namesOnConnect', 'namesOnDisconnect'];

const ME = '0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855A20';
const ME_LC = ME.toLowerCase();
const OTHER = '0x7876d1aa2fb4311f84a9ba0a8cf816eb5223d5c2';
const NOW = 1770000000;                      // fixed clock, so dates are assertable
const YEAR = 365 * 86400;
const GRACE = 90 * 86400;
// namesClassify takes `now` as an argument, so NOW pins it. namesRender reads the
// wall clock instead, so anything asserted through it hangs off REAL.
const REAL = Math.floor(Date.now() / 1000);
const TENDERLY = 'https://mainnet.gateway.tenderly.co';
const CAPPED = 'https://capped.example';     // stands in for a 10k-block endpoint
// Transfer topics are always full 32-byte words, and the cache shape-check expects that.
const ID = n => '0x' + String(n).repeat(64);

function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false,
    _classes: new Set(),
    classList: {
      add: c => el._classes.add(c),
      remove: c => el._classes.delete(c),
      contains: c => el._classes.has(c),
    },
    scrollIntoView() { el._scrolled = true; },
  };
  return el;
}

// `lifted` omits a function so a test can substitute its own: an omitted name
// resolves to the sandbox global instead of the source's declaration.
function sandbox(opts = {}) {
  const els = new Map();
  for (const id of ['namesSection', 'namesPanel', 'namesBody', 'namesToggle', 'nameInput']) {
    els.set(id, makeEl(id));
  }
  const calls = { aggregate3: [], getLogs: [], toggleWallet: 0 };
  const store = new Map(Object.entries(opts.cache || {}));

  const ctx = {
    ethers, console, setTimeout, clearTimeout,
    BigInt, Date, Math, Number, String, JSON, Promise, Object, Array, Set, RegExp, Error,
    CONTRACT: '0x0000000000696760E15f265e828DB644A0c242EB',
    iface: { __tag: 'nft' },
    erc20BalNonceIface: { __tag: 'erc20' },
    document: { getElementById: id => els.get(id) || null },
    $: id => els.get(id) || null,
    window: { _connectedAddress: opts.me === undefined ? ME : opts.me },
    escapeHtml: s => String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    localComputeId: label => BigInt(ethers.keccak256(ethers.toUtf8Bytes('root:' + label))),
    toggleWallet: () => { calls.toggleWallet++; },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: k => store.delete(k),
    },
    // The list a browser would walk: a range-capped endpoint sits ahead of the
    // one measured to serve the whole history, which is the situation NAMES_LOG_FIRST exists for.
    RPC_ENDPOINTS: [CAPPED, TENDERLY, 'https://other.example'],
    customRpcs: () => opts.customRpcs || [],
    providerFor: u => ({
      url: u,
      getBlockNumber: async () => (opts.head === undefined ? 25900000 : opts.head),
      getLogs: async f => { calls.getLogs.push({ url: u, filter: f }); return ctx.__getLogs(u, f); },
    }),
    __getLogs: opts.getLogs || (async () => { throw new Error('no endpoint stubbed'); }),
    aggregate3: opts.aggregate3
      || (async c => { calls.aggregate3.push(c); return c.map(() => null); }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  const lifted = opts.lifted || ALL;
  const prelude = 'let _namesState = null; let _namesCount = 0; let _namesSeq = 0;'
    + ' let _namesScanning = false; let _logEndpoint = null;';
  vm.runInContext([prelude, ...CONSTS.map(liftConst), ...lifted.map(lift)].join('\n\n'), ctx);

  return {
    ctx, els, calls, store,
    run: code => vm.runInContext(code, ctx),
    // Hand a value (BigInts and all) to the sandbox by reference rather than
    // through a JSON round-trip that would flatten it.
    put: (name, value) => { ctx[name] = value; return name; },
  };
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok    ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}
const show = v => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x + 'n' : x));
function eq(name, got, want) {
  ok(name, show(got) === show(want), `got ${show(got)}\n        want ${show(want)}`);
}

// A raw namesRead() row, as namesClassify() expects to receive it.
function row(over = {}) {
  return Object.assign({
    id: '0x01', owner: ME_LC, name: 'alice.wei', label: 'alice',
    parent: 0n, expiresAt: NOW + YEAR
  }, over);
}

// ── namesRoot: the label everything below it hangs on ────────────────────────
{
  const { run } = sandbox();
  const r = s => run(`namesRoot(${JSON.stringify(s)})`);
  eq('root: a plain name is its own root', r('alice.wei'), 'alice');
  eq('root: one level down', r('blog.alice.wei'), 'alice');
  eq('root: ten levels down', r('a.b.c.d.e.f.g.h.i.alice.wei'), 'alice');
  eq('root: no .wei suffix', r('blog.alice'), 'alice');
  eq('root: an empty name has no root', r(''), '');
  eq('root: null is not a crash', r(null), '');
}

// ── namesClassify: the two things ownerOf and records() will not tell you ─────
{
  const s = sandbox();
  const classify = (rows, roots = {}) => {
    s.put('__rows', rows); s.put('__roots', roots);
    return s.run(`namesClassify(__rows, ${JSON.stringify(ME)}, __roots, ${NOW})`);
  };
  const status = (rows, roots) => classify(rows, roots).map(r => r.status);

  // 1. ownerOf is not expiry-aware: this row is still "owned" and still counts in
  //    balanceOf, but the name has been free for anyone to take for months.
  eq('classify: a name past its grace is lapsed, not held',
    status([row({ expiresAt: NOW - GRACE - 86400 })]), ['expired']);
  eq('classify: inside the grace period it is renewable',
    status([row({ expiresAt: NOW - 86400 })]), ['grace']);
  eq('classify: one second past expiry is not yet lost',
    status([row({ expiresAt: NOW - 1 })]), ['grace']);
  eq('classify: the last second of grace is still grace',
    status([row({ expiresAt: NOW - GRACE })]), ['grace']);
  eq('classify: expiring inside the horizon',
    status([row({ expiresAt: NOW + 10 * 86400 })]), ['soon']);
  eq('classify: well clear of it',
    status([row({ expiresAt: NOW + YEAR })]), ['active']);

  // 2. A subdomain stores expiresAt 0 and lives as long as its root does. Read at
  //    face value that is 1970 — every subdomain would show up expired.
  const subRow = row({ id: '0x02', name: 'blog.alice.wei', label: 'blog', parent: 42n, expiresAt: 0 });
  const sub = classify([subRow], { alice: NOW + YEAR });
  eq('classify: a subdomain takes the root\'s expiry, not its own 0',
    sub.map(r => r.status), ['active']);
  eq('classify: and reports the root\'s date', sub.map(r => r.expires), [NOW + YEAR]);
  eq('classify: it is flagged as a subdomain', sub.map(r => r.sub), [true]);
  eq('classify: a subdomain dies with its root',
    status([subRow], { alice: NOW - GRACE - 1 }), ['expired']);
  eq('classify: an unreadable root is unknown, not expired',
    status([subRow], {}), ['unknown']);

  // getFullName returning "" is the separate signal: a parent was re-registered
  // over this token, so the name it spelled is gone whatever the dates say.
  eq('classify: an empty full name is an orphan',
    status([row({ name: '', label: 'blog', parent: 42n, expiresAt: 0 })], { alice: NOW + YEAR }),
    ['orphan']);

  // Only what this address still owns, and never a guess about what it doesn't.
  eq('classify: a name sold on is dropped', classify([row({ owner: OTHER })]).length, 0);
  eq('classify: a failed read is dropped, not shown as someone else\'s',
    classify([null]).length, 0);
  eq('classify: the address matches case-insensitively',
    classify([row({ owner: ME_LC })]).length, 1);
}

// ── ordering: what needs doing comes before what is merely true ──────────────
{
  const s = sandbox();
  s.put('__rows', [
    row({ id: '0x01', name: 'quiet.wei', label: 'quiet', expiresAt: NOW + YEAR }),
    row({ id: '0x02', name: 'lapsed.wei', label: 'lapsed', expiresAt: NOW - GRACE - 1 }),
    row({ id: '0x03', name: 'soon.wei', label: 'soon', expiresAt: NOW + 5 * 86400 }),
    row({ id: '0x04', name: 'renewme.wei', label: 'renewme', expiresAt: NOW - 10 }),
    row({ id: '0x05', name: 'sub.quiet.wei', label: 'sub', parent: 1n, expiresAt: 0 }),
    row({ id: '0x06', name: 'active.wei', label: 'active', expiresAt: NOW + YEAR }),
  ]);
  s.put('__roots', { quiet: NOW + YEAR });
  const out = s.run(`namesClassify(__rows, ${JSON.stringify(ME)}, __roots, ${NOW})`);
  eq('order: renewable first, then expiring, then the rest, lapsed last',
    out.map(r => r.name),
    ['renewme.wei', 'soon.wei', 'active.wei', 'quiet.wei', 'sub.quiet.wei', 'lapsed.wei']);
  ok('order: a name comes before what hangs off it',
    out.findIndex(r => r.name === 'quiet.wei') < out.findIndex(r => r.name === 'sub.quiet.wei'));
}

// ── namesRead: the records() tuple, and what a failed read means ─────────────
{
  const s = sandbox({
    aggregate3: async c => c.map(call => {
      if (call.fn === 'ownerOf') return [ME];
      if (call.fn === 'getFullName') return ['blog.alice.wei'];
      // (string label, uint256 parent, uint64 expiresAt, uint64 epoch, uint64 parentEpoch)
      return ['blog', 42n, 0n, 3n, 7n];
    })
  });
  const [r] = await s.run(`namesRead(${JSON.stringify([ID('a')])})`);
  eq('read: label is field 0', r.label, 'blog');
  eq('read: parent is field 1', r.parent, 42n);
  eq('read: expiresAt is field 2, not the epoch after it', r.expiresAt, 0);
  eq('read: owner is lower-cased ready for comparison', r.owner, ME_LC);
}
{
  const seen = [];
  const s = sandbox({
    aggregate3: async c => {
      seen.push(c);
      return c.map(call => (call.fn === 'records' ? ['blog', 0n, 0n, 0n, 0n] : [ME]));
    }
  });
  await s.run(`namesRead(${JSON.stringify([ID('a')])})`);
  eq('read: three reads per name', seen[0].length, 3);
  eq('read: ownerOf, getFullName, records',
    seen[0].map(c => c.fn), ['ownerOf', 'getFullName', 'records']);
  eq('read: all aimed at the name contract',
    [...new Set(seen[0].map(c => c.target))], [s.ctx.CONTRACT]);
}
{
  // A read that failed must not be mistaken for "not yours" — that would silently
  // drop a held name off the list.
  const s = sandbox({
    aggregate3: async c => c.map(call => (call.fn === 'ownerOf' ? null : ['x'])),
  });
  const out = await s.run(`namesRead(${JSON.stringify([ID('a')])})`);
  eq('read: a failed ownerOf yields null, not a row', out, [null]);
}
{
  // Chunking: 3 subcalls per name, and a chunk must not split a name's triple or
  // the results would reassemble against the wrong ids.
  const seen = [];
  const s = sandbox({
    aggregate3: async c => {
      seen.push(c.length);
      return c.map(call => (call.fn === 'ownerOf' ? [ME]
        : call.fn === 'getFullName' ? ['n' + call.args[0] + '.wei'] : ['n' + call.args[0], 0n, 0n]));
    }
  });
  const ids = Array.from({ length: 200 }, (_, i) => '0x' + (i + 1).toString(16));
  const out = await s.run(`namesRead(${JSON.stringify(ids)})`);
  eq('read: chunked at NAMES_CHUNK', seen, [249, 249, 102]);
  ok('read: every chunk is a whole number of names', seen.every(n => n % 3 === 0),
    JSON.stringify(seen));
  eq('read: rows reassemble against their own id in order',
    out.map(r => r.id).join() === ids.join(), true);
  eq('read: and carry that id\'s own name', out[137].name, 'n' + ids[137] + '.wei');
}

// ── namesRootExpiry: pay for a root only when it isn't already in hand ───────
{
  const s = sandbox();
  s.put('__rows', [
    row({ label: 'alice', parent: 0n, expiresAt: NOW + YEAR }),
    row({ id: '0x02', name: 'blog.alice.wei', label: 'blog', parent: 9n, expiresAt: 0 }),
  ]);
  const out = await s.run('namesRootExpiry(__rows)');
  eq('roots: a root the address holds costs no call', s.calls.aggregate3.length, 0);
  eq('roots: and its expiry comes straight off the row', out, { alice: NOW + YEAR });
}
{
  const s = sandbox({ aggregate3: async c => c.map(() => [BigInt(NOW + 5)]) });
  s.put('__rows', [
    row({ id: '0x02', name: 'blog.bob.wei', label: 'blog', parent: 9n, expiresAt: 0 }),
    row({ id: '0x03', name: 'shop.bob.wei', label: 'shop', parent: 9n, expiresAt: 0 }),
    row({ id: '0x04', name: 'x.carol.wei', label: 'x', parent: 8n, expiresAt: 0 }),
  ]);
  const seen = [];
  s.ctx.aggregate3 = async c => { seen.push(c); return c.map(() => [BigInt(NOW + 5)]); };
  const out = await s.run('namesRootExpiry(__rows)');
  eq('roots: one call, one entry per distinct unheld root', seen[0].length, 2);
  eq('roots: looked up by expiresAt', [...new Set(seen[0].map(c => c.fn))], ['expiresAt']);
  eq('roots: both roots resolved', Object.keys(out).sort(), ['bob', 'carol']);
}
{
  const s = sandbox();
  s.put('__rows', [row({ name: '', label: 'blog', parent: 9n, expiresAt: 0 })]);
  await s.run('namesRootExpiry(__rows)');
  eq('roots: an orphan has no root to price', s.calls.aggregate3.length, 0);
}

// ── namesReceived: one full-range walk, then only the blocks since ───────────
const KEY = 'wns:names:' + ME_LC;
const logFor = ids => ids.map(id => ({ topics: [null, null, null, id] }));
{
  const s = sandbox({ getLogs: async (u, f) => (u === TENDERLY ? logFor([ID('a'), ID('b'), ID('a')]) : (() => { throw new Error('ranges over 10000 blocks are not supported'); })()) });
  const out = await s.run(`namesReceived(${JSON.stringify(ME)}, false)`);
  eq('scan: ids are deduped', out.ids, [ID('a'), ID('b')]);
  eq('scan: a fresh scan starts at the deploy block',
    s.calls.getLogs.slice(-1)[0].filter.fromBlock, 24360470);
  eq('scan: filtered on the contract', s.calls.getLogs.slice(-1)[0].filter.address, s.ctx.CONTRACT);
  eq('scan: and on Transfer-to-this-address',
    s.calls.getLogs.slice(-1)[0].filter.topics,
    [s.run('NAMES_TRANSFER'), null, '0x' + '0'.repeat(24) + ME_LC.slice(2)]);
  eq('scan: the walk leads with an endpoint that serves the full range',
    s.calls.getLogs.map(g => g.url), [TENDERLY]);
  eq('scan: the block it reached is cached with the ids',
    JSON.parse(s.store.get(KEY)), { head: 25900000, ids: [ID('a'), ID('b')] });
  eq('scan: nothing stale about a live scan', out.stale, false);
}
{
  // The expensive walk is paid once: the next open only asks for what is new.
  const s = sandbox({
    cache: { [KEY]: JSON.stringify({ head: 25000000, ids: [ID('a')] }) },
    getLogs: async () => logFor([ID('b')]),
  });
  const out = await s.run(`namesReceived(${JSON.stringify(ME)}, false)`);
  eq('scan: resumes at the block after the cached one',
    s.calls.getLogs[0].filter.fromBlock, 25000001);
  eq('scan: new ids merge onto the cached ones', out.ids, [ID('a'), ID('b')]);
  eq('scan: the cache advances', JSON.parse(s.store.get(KEY)).head, 25900000);
}
{
  const s = sandbox({
    cache: { [KEY]: JSON.stringify({ head: 25000000, ids: [ID('a')] }) },
    getLogs: async () => logFor([]),
  });
  await s.run(`namesReceived(${JSON.stringify(ME)}, true)`);
  eq('scan: a forced rescan goes back to the deploy block',
    s.calls.getLogs[0].filter.fromBlock, 24360470);
}
{
  // An endpoint a few blocks behind the one that wrote the cache would otherwise
  // be handed a backwards range.
  const s = sandbox({
    head: 24999990,
    cache: { [KEY]: JSON.stringify({ head: 25000000, ids: [ID('a')] }) },
    getLogs: async () => { throw new Error('should not be called'); },
  });
  const out = await s.run(`namesReceived(${JSON.stringify(ME)}, false)`);
  eq('scan: an endpoint behind the cache asks for nothing', s.calls.getLogs.length, 0);
  eq('scan: and loses nothing', out.ids, [ID('a')]);
}
{
  // Only one public endpoint in the wild serves this range. When none will, a
  // cached list is stale but real — and ownerOf re-checks all of it anyway.
  const s = sandbox({
    cache: { [KEY]: JSON.stringify({ head: 25000000, ids: [ID('a')] }) },
    getLogs: async () => { throw new Error('archive requests require a token'); },
  });
  const out = await s.run(`namesReceived(${JSON.stringify(ME)}, false)`);
  eq('scan: falls back to the cached ids', out.ids, [ID('a')]);
  ok('scan: and says the list is stale', out.stale === true);
  ok('scan: after trying every endpoint', s.calls.getLogs.length === 3,
    JSON.stringify(s.calls.getLogs.map(g => g.url)));
}
{
  // A truncated or hand-edited store must cost its own entries, not the scan: these
  // ids go straight into calldata, where one malformed one throws the whole batch.
  const s = sandbox({
    cache: { [KEY]: JSON.stringify({ head: 25000000, ids: [ID('a'), '', 'junk', 42] }) },
    getLogs: async () => logFor([ID('b')]),
  });
  const out = await s.run(`namesReceived(${JSON.stringify(ME)}, false)`);
  eq('scan: a malformed cached id is dropped, not passed on',
    out.ids, [ID('a'), ID('b')]);
  eq('scan: and a store that lost entries is re-scanned in full, not resumed',
    s.calls.getLogs[0].filter.fromBlock, 24360470);
}
{
  const s = sandbox({ getLogs: async () => { throw new Error('archive requests require a token'); } });
  let threw = false;
  try { await s.run(`namesReceived(${JSON.stringify(ME)}, false)`); } catch (_) { threw = true; }
  ok('scan: with no cache and no endpoint it throws rather than show an empty list', threw);
}
{
  // A custom node is the whole app's network; the scan must not reach past it.
  const s = sandbox({
    customRpcs: ['https://mine.example'],
    getLogs: async () => logFor([ID('a')]),
  });
  await s.run(`namesReceived(${JSON.stringify(ME)}, false)`);
  eq('scan: a custom endpoint is used exclusively',
    [...new Set(s.calls.getLogs.map(g => g.url))], ['https://mine.example']);
}

// ── namesScan: balanceOf is the completeness check ──────────────────────────
function scanSandbox(opts = {}) {
  const s = sandbox({
    lifted: ALL.filter(n => !['namesReceived', 'namesRead', 'namesRootExpiry'].includes(n)),
    aggregate3: async c => (c[0].fn === 'balanceOf'
      ? [[BigInt(opts.balance === undefined ? 1 : opts.balance)], [BigInt(opts.primary || 0)]]
      : c.map(() => null)),
  });
  s.ctx.namesReceived = async () => ({ ids: (opts.rows || []).map(r => r.id), stale: !!opts.stale });
  s.ctx.namesRead = async () => (opts.rows || []);
  s.ctx.namesRootExpiry = async () => (opts.roots || {});
  return s;
}
{
  const s = scanSandbox({ balance: 3, rows: [row()] });
  await s.run('namesScan(false)');
  const st = s.run('_namesState');
  eq('count: balanceOf says two more are held than could be read', st.missing, 2);
  eq('count: the toggle advertises what was actually read', s.run('_namesCount'), 1);
  ok('body: the shortfall is stated, not swallowed',
    s.els.get('namesBody').innerHTML.includes('2 more names'),
    s.els.get('namesBody').innerHTML.slice(0, 300));
}
{
  const s = scanSandbox({ balance: 1, rows: [row()] });
  await s.run('namesScan(false)');
  eq('count: agreement reports no shortfall', s.run('_namesState').missing, 0);
}
{
  // A lapsed name still counts in balanceOf, so a list holding one is complete
  // even though the row is not a live holding.
  const s = scanSandbox({ balance: 1, rows: [row({ expiresAt: NOW - GRACE - 1 })] });
  await s.run('namesScan(false)');
  eq('count: a lapsed name is not a shortfall', s.run('_namesState').missing, 0);
}
{
  const s = scanSandbox({ balance: 1, rows: [row()] });
  const p = s.run('namesScan(false)');
  s.run('_namesSeq++');            // the account changed while the scan was in flight
  await p;
  eq('race: a scan the account outran paints nothing', s.run('_namesState'), null);
}
{
  const s = scanSandbox({ balance: 0, rows: [] });
  await s.run('namesScan(false)');
  ok('body: an address with nothing says so',
    s.els.get('namesBody').innerHTML.includes('No .wei names at this address'),
    s.els.get('namesBody').innerHTML);
}
{
  const s = scanSandbox({ balance: 1, rows: [row()] });
  s.ctx.namesReceived = async () => { throw new Error('ranges over 10000 blocks are not supported'); };
  await s.run('namesScan(false)');
  ok('body: a refused log query points at the fix, not at a stack trace',
    s.els.get('namesBody').innerHTML.includes('gear icon'),
    s.els.get('namesBody').innerHTML);
  ok('body: and offers a retry', s.els.get('namesBody').innerHTML.includes('try again'));
}

// ── rendering ───────────────────────────────────────────────────────────────
function render(rows, extra = {}) {
  const s = sandbox();
  s.put('__st', Object.assign({ addr: ME_LC, rows, primary: 0n, missing: 0, stale: false }, extra));
  s.run('_namesState = __st; namesRender();');
  return { html: s.els.get('namesBody').innerHTML, s };
}
const classified = (over = {}) => Object.assign(
  { id: '0x01', name: 'alice.wei', label: 'alice', sub: false, expires: REAL + YEAR, status: 'active' },
  over);
{
  const { html } = render([classified()]);
  ok('render: the name is a link to its own manage panel', html.includes('href="#alice"'), html);
  ok('render: with its expiry alongside', /expires \w/.test(html), html);
  ok('render: one name reads as one name', html.includes('>1 name<'), html.slice(0, 200));
}
{
  const { html } = render([
    classified(),
    classified({ id: '0x02', name: 'blog.alice.wei', label: 'blog', sub: true }),
  ]);
  ok('render: subdomains are counted separately', html.includes('2 names · 1 subdomain'),
    html.slice(0, 200));
  ok('render: and linked by their full name', html.includes('href="#blog.alice"'), html);
}
{
  const { html } = render([classified({ status: 'grace', expires: REAL - 86400 })]);
  ok('render: a lapsed name leads with a deadline, not a date',
    html.includes('Renewal is still open'), html.slice(0, 400));
  ok('render: and the row is tagged for renewal', html.includes('names-tag warn'), html);
  ok('render: with how long is left', /open to anyone in \d+ days/.test(html), html);
}
{
  const { html } = render([classified({ status: 'soon', expires: REAL + 9 * 86400 })]);
  ok('render: an expiry inside the horizon is called out',
    html.includes('expiring within 30 days'), html.slice(0, 400));
  // NameNFT extends from the current expiry, not from today (renew(): "Always
  // extend from current expiry"). Said without naming a term length, so a
  // multi-year renewal would not turn the sentence into a lie.
  ok('render: and says why renewing early wastes nothing',
    html.includes('extends from the current expiry rather than from today')
    && !/adds a year/.test(html), html.slice(0, 400));
  ok('render: as a countdown', html.includes('expires in 9 days'), html);
}
{
  const { html } = render([
    classified({ status: 'grace', expires: REAL - 1 }),
    classified({ id: '0x02', status: 'soon', expires: REAL + 86400 }),
  ]);
  ok('render: the renewal deadline outranks the expiry warning',
    html.includes('Renewal is still open') && !html.includes('expiring within'), html.slice(0, 400));
}
{
  const { html } = render([
    classified(),
    classified({ id: '0x02', name: 'gone.wei', label: 'gone', status: 'expired', expires: REAL - GRACE - 1 }),
  ]);
  ok('render: a lapsed name is counted apart from the live ones',
    html.includes('1 name · 1 lapsed'), html.slice(0, 200));
  ok('render: and dimmed', html.includes('names-row dim'), html);
}
{
  // An orphan has no name left to look up, so there is no hash that would find it
  // and no suffix that would be true.
  const { html } = render([classified({ name: '', label: 'blog', sub: true, status: 'orphan', expires: 0 })]);
  ok('render: an orphan is not a link', !html.includes('<a class="names-row'), html);
  ok('render: it shows the bare label it still carries', html.includes('>blog<span'), html);
  ok('render: and why it is dead', html.includes('parent re-registered'), html);
}
{
  // The three figures have to add up against each other.
  const { html } = render([
    classified(),
    classified({ id: '0x02', name: 'blog.alice.wei', label: 'blog', sub: true }),
    classified({ id: '0x03', name: '', label: 'shop', sub: true, status: 'orphan', expires: 0 }),
  ]);
  ok('render: a lapsed subdomain is counted as lapsed, not twice',
    html.includes('2 names · 1 subdomain · 1 lapsed'), html.slice(0, 200));
}
{
  const { html } = render([classified()], { primary: 1n });
  ok('render: the reverse record is marked', html.includes('>primary<'), html);
}
{
  const { html } = render([classified({ name: '<img src=x>.wei', label: '<img src=x>' })]);
  ok('render: a name is escaped, never injected', !html.includes('<img src=x>'), html);
  ok('render: and still linkable', html.includes('href="#%3Cimg%20src%3Dx%3E"'), html);
}
{
  const { html } = render([classified()], { stale: true });
  ok('render: a cached list says what it is', html.includes('last'), html);
}

// ── toggle, connect, disconnect ─────────────────────────────────────────────
{
  const s = sandbox({ lifted: ALL.filter(n => n !== 'namesScan') });
  let scans = 0;
  s.ctx.namesScan = async () => { scans++; };
  s.run('toggleNames(null)');
  ok('toggle: opening shows the panel', s.els.get('namesPanel')._classes.has('show'));
  eq('toggle: and starts a scan', scans, 1);
  eq('toggle: the link becomes a way back', s.els.get('namesToggle').textContent, '← hide');
  s.run('toggleNames(null)');
  ok('toggle: closing hides it', !s.els.get('namesPanel')._classes.has('show'));
  eq('toggle: no second scan on the way out', scans, 1);
}
{
  const s = sandbox({ me: null, lifted: ALL.filter(n => n !== 'namesScan') });
  let scans = 0;
  s.ctx.namesScan = async () => { scans++; };
  s.run('toggleNames(null)');
  eq('toggle: with no wallet it asks for one', s.calls.toggleWallet, 1);
  eq('toggle: and scans nothing', scans, 0);
}
{
  const s = sandbox({ aggregate3: async () => [[7n]] });
  await s.run('namesOnConnect()');
  eq('connect: one balanceOf gives the toggle a count', s.els.get('namesToggle').textContent,
    'your names · 7 →');
  eq('connect: the section appears', s.els.get('namesSection').style.display, '');
}
{
  const s = sandbox({ aggregate3: async () => { throw new Error('rpc down'); } });
  await s.run('namesOnConnect()');
  eq('connect: a failed count is not a claim that there are none',
    s.els.get('namesToggle').textContent, 'your names →');
  eq('connect: and the section still opens', s.els.get('namesSection').style.display, '');
}
{
  const s = sandbox({ aggregate3: async () => [[7n]] });
  await s.run('namesOnConnect()');
  s.run('namesOnDisconnect()');
  eq('disconnect: the section goes away', s.els.get('namesSection').style.display, 'none');
  eq('disconnect: the panel closes', s.els.get('namesPanel')._classes.has('show'), false);
  eq('disconnect: the previous account\'s list is dropped', s.run('_namesState'), null);
  eq('disconnect: and its count with it', s.els.get('namesToggle').textContent, 'your names →');
}
{
  // Switching accounts must not leave the previous one's names on screen.
  const s = sandbox({ aggregate3: async () => [[2n]], lifted: ALL.filter(n => n !== 'namesScan') });
  s.ctx.namesScan = async () => {};
  s.put('__st', { addr: OTHER, rows: [classified()], primary: 0n, missing: 0, stale: false });
  s.run('_namesState = __st;');
  await s.run('namesOnConnect()');
  eq('connect: a different account clears the list it inherited', s.run('_namesState'), null);
}

// ── dates ───────────────────────────────────────────────────────────────────
{
  const { run } = sandbox();
  eq('days: rounds to whole days', run('namesDays(86400 * 3 + 100)'), '3 days');
  eq('days: singular', run('namesDays(86400)'), '1 day');
  eq('days: today', run('namesDays(0)'), 'today');
  eq('days: never negative', run('namesDays(-99999)'), 'today');
  eq('date: no date for no expiry', run('namesDate(0)'), '');
  ok('date: a real timestamp renders', /\d{4}/.test(run(`namesDate(${NOW})`)), run(`namesDate(${NOW})`));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
