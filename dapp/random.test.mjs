// "random" name draw tests, against a minimal DOM shim.
//
// The draw takes names from ENS's own registration logs, so the two things that can
// silently break it are pinned here:
//
// 1. Label decoding. ENS has shipped three NameRegistered signatures across three
//    controllers; the decoder relies only on `string name` being the first
//    non-indexed arg. Real mainnet log payloads from all of them are fixtures below.
// 2. The candidate filter. A drawn name must be registerable exactly as shown, and
//    at the 5+ character base fee — a 3-character draw would quietly cost 100x.
//
// Plus the draw itself: it must not clobber a name the user is typing, must not
// re-hit the network on every click, and must still produce a name when no endpoint
// will serve eth_getLogs.
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

// Same, for a `const NAME = ...;` declaration — the word lists and the ENS
// addresses/topics are read from the source too, not restated here. Brackets and
// the terminating `;` are counted outside strings and trailing `//` comments, so a
// commented declaration doesn't swallow the one after it.
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

const CONSTS = ['ENS_CONTROLLERS', 'ENS_NAME_REGISTERED', 'ENS_WINDOW_BLOCKS',
  'ENS_LOOKBACK_BLOCKS', 'RANDOM_BATCH', 'RANDOM_HEADS', 'RANDOM_TAILS',
  'LOG_ENDPOINTS_FIRST'];

const ALL = ['normalizeLabelContract', 'normalizeLabel', 'decodeEnsLabel', 'usableLabel',
  'localLabels', 'shuffled', 'anyEndpoint', 'ensLabelSample', 'screenAvailable', 'randomName'];

function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false,
    _classes: new Set(),
    classList: {
      add: c => el._classes.add(c),
      remove: c => el._classes.delete(c),
      contains: c => el._classes.has(c),
    },
  };
  return el;
}

// `lifted` omits a function so the test can substitute its own: an omitted name
// resolves to the sandbox global instead of the source's declaration.
function sandbox({ lifted = ALL, multicall, ensLabelSample, doCheckName } = {}) {
  const els = new Map();
  for (const id of ['nameInput', 'randomBtn', 'availability']) els.set(id, makeEl(id));
  const calls = { multicall: [], ensLabelSample: 0, doCheckName: 0, getLogs: [], withRpc: 0 };

  const ctx = {
    ethers, console,
    setTimeout, clearTimeout, TextEncoder, BigInt, Date, Math, Number, String, JSON,
    Promise, Object, Array, Set, RegExp, Error,
    document: { getElementById: id => els.get(id) || null },
    $: id => els.get(id) || null,
    spinnerSVG: () => '',
    textEncoder: new TextEncoder(),
    ens_normalize: undefined,       // exercises the contract-compatible fallback
    checkDebounce: null,
    RPC_ENDPOINTS: ['https://a.example', 'https://b.example'],
    customRpcs: () => [],
    providerFor: url => ({
      url,
      getBlockNumber: async () => 20000000,
      getLogs: async f => { calls.getLogs.push({ url, filter: f }); return ctx.__getLogs(url, f); },
    }),
    withRpc: async fn => { calls.withRpc++; return fn({ getBlockNumber: async () => 20000000 }); },
    __getLogs: async () => { throw new Error('no endpoint stubbed'); },
    multicall: multicall || (async c => { calls.multicall.push(c); return c.map(() => [true]); }),
    doCheckName: doCheckName || (async () => { calls.doCheckName++; }),
  };
  if (ensLabelSample) ctx.ensLabelSample = async () => { calls.ensLabelSample++; return ensLabelSample(); };
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  const prelude = `let _randomPool = []; let _randomDrawing = false; let _logEndpoint = null;`;
  vm.runInContext(
    [prelude, ...CONSTS.map(liftConst), ...lifted.map(lift)].join('\n\n'), ctx);
  return { ctx, els, calls, run: code => vm.runInContext(code, ctx) };
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok    ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, `got ${g}\n        want ${w}`);
}

// ── decodeEnsLabel: every NameRegistered variant ENS has shipped ─────────────
{
  const { run } = sandbox();
  const d = data => run(`decodeEnsLabel(${JSON.stringify(data)})`);
  const abi = ethers.AbiCoder.defaultAbiCoder();

  // Real mainnet payloads, captured from the two controllers whose data layouts
  // differ most: the 2019 one (3 head words) and the current one (5, string at 0xa0).
  eq('decode: 2019 controller (live log)', d(
    '0x0000000000000000000000000000000000000000000000000000000000000060'
    + '00000000000000000000000000000000000000000000000000073ea05f938fb3'
    + '000000000000000000000000000000000000000000000000000000006c74cf3f'
    + '000000000000000000000000000000000000000000000000000000000000000c'
    + '7175616e74756d65746865720000000000000000000000000000000000000000'), 'quantumether');
  eq('decode: current controller (live log)', d(
    '0x00000000000000000000000000000000000000000000000000000000000000a0'
    + '0000000000000000000000000000000000000000000000000007402c18500028'
    + '0000000000000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000000'
    + '000000000000000000000000000000000000000000000000000000006c74597f'
    + '0000000000000000000000000000000000000000000000000000000000000007'
    + '646d616e6c66670000000000000000000000000000000000000000000000000000'.slice(0, 64)), 'dmanlfg');

  // And the 2022 shape, plus a long label that spans two words.
  eq('decode: 2022 controller shape', d(
    abi.encode(['string', 'uint256', 'uint256', 'uint256'], ['satoshi', 1n, 2n, 3n])), 'satoshi');
  eq('decode: label spanning two words', d(
    abi.encode(['string', 'uint256'], ['a'.repeat(40), 1n])), 'a'.repeat(40));
  eq('decode: unicode label', d(abi.encode(['string', 'uint256'], ['林辞', 1n])), '林辞');

  // Malformed input must cost one log, never the window.
  eq('decode: empty data', d('0x'), null);
  eq('decode: offset past the end', d('0x' + 'ff'.repeat(32)), null);
  eq('decode: length past the end', d(
    '0x0000000000000000000000000000000000000000000000000000000000000020'
    + '0000000000000000000000000000000000000000000000000000000000000099'), null);
  eq('decode: invalid utf-8', d(
    abi.encode(['bytes', 'uint256'], ['0xfffefd', 1n])), null);
  eq('decode: not hex at all', d('nonsense'), null);
}

// ── usableLabel: registerable as shown, at the base fee ──────────────────────
{
  const { run } = sandbox();
  const u = s => run(`usableLabel(${JSON.stringify(s)})`);

  eq('usable: plain word', u('astradyne'), 'astradyne');
  eq('usable: digits after a letter', u('acc01'), 'acc01');
  eq('usable: uppercase is lowercased', u('Astradyne'), 'astradyne');
  eq('usable: 5 chars (base fee)', u('morlo'), 'morlo');
  eq('usable: 15 chars', u('a'.repeat(15)), 'a'.repeat(15));

  // 3- and 4-character names price at 0.05 / 0.01 ETH, not the 0.0005 base fee.
  eq('usable: 3 chars rejected (0.05 ETH tier)', u('abc'), null);
  eq('usable: 4 chars rejected (0.01 ETH tier)', u('abcd'), null);
  eq('usable: 16 chars rejected', u('a'.repeat(16)), null);
  eq('usable: leading digit rejected', u('1inch'), null);
  eq('usable: all digits rejected', u('12345'), null);
  eq('usable: hyphen rejected', u('foo-bar'), null);
  eq('usable: emoji rejected', u('🚀🚀🚀🚀🚀'), null);
  eq('usable: CJK rejected', u('千币侯通宝'), null);
  eq('usable: dot rejected', u('foo.bar'), null);
  eq('usable: null input', u(null), null);
  eq('usable: undefined input', run('usableLabel(undefined)'), null);
  eq('usable: decode failure feeds straight in', run('usableLabel(decodeEnsLabel("0x"))'), null);
}

// ── localLabels: the fallback corpus is itself drawable ──────────────────────
{
  const { run } = sandbox();
  const got = run('localLabels(10)');
  eq('localLabels: asked for 10', got.length, 10);
  eq('localLabels: all unique', new Set(got).size, 10);
  ok('localLabels: every label passes the same filter',
    got.every(l => run(`usableLabel(${JSON.stringify(l)})`) === l), JSON.stringify(got));
  // Every head+tail pair, not just the sampled ones — one long word on each side
  // would otherwise ship a combination the filter silently drops.
  const every = run(`RANDOM_HEADS.flatMap(a => RANDOM_TAILS.map(b => a + b)).filter(l => !usableLabel(l))`);
  eq('localLabels: no unusable pair in the word lists', every, []);
}

// ── screenAvailable: one batched call, only free names come back ─────────────
{
  const { run, calls } = sandbox({
    multicall: async c => { calls.multicall.push(c); return c.map((x, i) => i % 2 ? [false] : [true]); }
  });
  const got = await run(`screenAvailable(['alpha1','beta12','gamma1','delta1'])`);
  eq('screen: keeps only isAvailable=true', got, ['alpha1', 'gamma1']);
  eq('screen: one multicall for the batch', calls.multicall.length, 1);
  eq('screen: asks isAvailable at the top level', calls.multicall[0][0].fn, 'isAvailable');
  eq('screen: parentId 0', calls.multicall[0][0].args[1], 0);
  ok('screen: allowFailure so one bad slot cannot void the batch',
    calls.multicall[0].every(c => c.allowFailure === true));
  eq('screen: empty in, empty out', await run(`screenAvailable([])`), []);
}
{
  const { run, calls } = sandbox({
    multicall: async c => { calls.multicall.push(c); return c.map(() => [true]); }
  });
  const many = Array.from({ length: 200 }, (_, i) => 'name' + String(i).padStart(3, '0'));
  const got = await run(`screenAvailable(${JSON.stringify(many)})`);
  eq('screen: batch capped at RANDOM_BATCH', got.length, run('RANDOM_BATCH'));
  eq('screen: and only that many go on the wire', calls.multicall[0].length, run('RANDOM_BATCH'));
}
{
  // A null slot is a reverted/undecodable sub-call, not an available name.
  const { run } = sandbox({ multicall: async c => c.map((x, i) => i === 0 ? null : [true]) });
  eq('screen: null decode is not "available"',
    await run(`screenAvailable(['alpha1','beta12'])`), ['beta12']);
}

// ── ensLabelSample: one window, filtered and deduped ─────────────────────────
{
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const log = name => ({ data: abi.encode(['string', 'uint256', 'uint256'], [name, 1n, 2n]) });
  const { run, ctx, calls } = sandbox();
  ctx.__getLogs = async url => {
    if (url === 'https://a.example') throw new Error('403 Forbidden');
    return [log('astradyne'), log('astradyne'), log('千币侯通宝'), log('abc'), log('venchi')];
  };
  const got = await run('ensLabelSample()');
  eq('sample: deduped and filtered', got.sort(), ['astradyne', 'venchi']);
  // The endpoint walk is the whole point: publicnode 403s every log query, and
  // FallbackProvider surfaces that as the call's error instead of failing over.
  eq('sample: walks past a refusing endpoint', calls.getLogs.map(g => g.url),
    ['https://a.example', 'https://b.example']);
  const f = calls.getLogs[1].filter;
  eq('sample: window is ENS_WINDOW_BLOCKS wide', f.toBlock - f.fromBlock, run('ENS_WINDOW_BLOCKS'));
  ok('sample: window sits inside the lookback',
    f.fromBlock >= 20000000 - run('ENS_WINDOW_BLOCKS') - run('ENS_LOOKBACK_BLOCKS') && f.toBlock <= 20000000,
    JSON.stringify(f));
  eq('sample: filtered to the ENS controllers', f.address, run('ENS_CONTROLLERS'));
  eq('sample: filtered to NameRegistered', f.topics, [run('ENS_NAME_REGISTERED')]);
}
{
  const { run, ctx } = sandbox();
  ctx.__getLogs = async () => { throw new Error('403 Forbidden'); };
  let threw = false;
  try { await run('ensLabelSample()'); } catch (e) { threw = true; }
  ok('sample: throws when no endpoint serves logs', threw);
}

// ── the endpoint walk: pay for as few refusals as possible ───────────────────
{
  // The two endpoints verified to serve logs go first, ahead of the shared list's
  // own order — walking blind costs ~200ms of 403s before anyone answers.
  const { run, ctx, calls } = sandbox();
  const good = run('LOG_ENDPOINTS_FIRST')[0];
  ctx.RPC_ENDPOINTS = ['https://a.example', good, 'https://b.example'];
  ctx.__getLogs = async () => [];
  await run('ensLabelSample()');
  eq('walk: a verified log endpoint is tried first', calls.getLogs.map(g => g.url), [good]);
  // Head and window come from that same endpoint, not a second call on the shared
  // read provider.
  eq('walk: no separate round-trip for the block number', calls.withRpc, 0);
  const f = calls.getLogs[0].filter;
  ok('walk: window placed off that endpoint\'s head', f.toBlock <= 20000000, JSON.stringify(f));
}
{
  // Whoever answered stays first for the rest of the session.
  const { run, ctx, calls } = sandbox();
  ctx.RPC_ENDPOINTS = ['https://a.example', 'https://b.example'];
  ctx.__getLogs = async url => {
    if (url === 'https://a.example') throw new Error('403 Forbidden');
    return [];
  };
  await run('ensLabelSample()');
  await run('ensLabelSample()');
  eq('walk: the winner is remembered, not re-discovered',
    calls.getLogs.map(g => g.url),
    ['https://a.example', 'https://b.example', 'https://b.example']);
}
{
  // A custom ?rpc= / wns_rpc node replaces the public list everywhere else in the
  // app; the log walk must not quietly reach past it to a public endpoint.
  const { run, ctx, calls } = sandbox();
  ctx.customRpcs = () => ['https://custom.example'];
  ctx.__getLogs = async () => [];
  await run('ensLabelSample()');
  eq('walk: a custom endpoint is used exclusively',
    calls.getLogs.map(g => g.url), ['https://custom.example']);
}

// ── randomName: the draw itself ──────────────────────────────────────────────
const withoutSample = ALL.filter(n => n !== 'ensLabelSample');

{
  const { run, els, calls } = sandbox({
    lifted: withoutSample,
    ensLabelSample: () => ['astradyne', 'venchi', 'morlo', 'illyana', 'nikosh',
      'coreless', 'odoong', 'coreless2'],
  });
  await run('randomName()');
  eq('draw: fills the search box', els.get('nameInput').value.length > 0, true);
  ok('draw: with a screened ENS name',
    ['astradyne', 'venchi', 'morlo', 'illyana', 'nikosh', 'coreless', 'odoong', 'coreless2']
      .includes(els.get('nameInput').value), els.get('nameInput').value);
  eq('draw: runs the real lookup on it', calls.doCheckName, 1);
  eq('draw: one ENS window', calls.ensLabelSample, 1);
  eq('draw: one availability batch', calls.multicall.length, 1);

  // The pool is what the batch already proved free — later clicks must not re-hit
  // the network for it.
  const first = els.get('nameInput').value;
  await run('randomName()');
  eq('draw: second click hits no network', calls.ensLabelSample, 1);
  eq('draw: and no second batch', calls.multicall.length, 1);
  ok('draw: second click is a different name', els.get('nameInput').value !== first);
  eq('draw: but still runs the lookup', calls.doCheckName, 2);
}

{
  // Nothing in the window is free: fall through to a local name rather than
  // leaving the button dead.
  const { run, els, calls } = sandbox({
    lifted: withoutSample,
    ensLabelSample: () => ['astradyne', 'venchi'],
    multicall: async c => c.map(() => [false]),
  });
  await run('randomName()');
  ok('draw: everything taken still yields a name', els.get('nameInput').value.length >= 5,
    els.get('nameInput').value);
  eq('draw: and hands it to the lookup, which is the authority', calls.doCheckName, 1);
}

{
  // No endpoint will serve eth_getLogs. ENS is the nice source, not a dependency.
  const { run, els, calls } = sandbox({
    lifted: withoutSample,
    ensLabelSample: () => { throw new Error('403 Forbidden'); },
  });
  await run('randomName()');
  const value = els.get('nameInput').value;
  eq('draw: survives a dead getLogs', run(`usableLabel(${JSON.stringify(value)})`), value);
  eq('draw: local names are still screened', calls.multicall.length, 1);
}

{
  // A thin window tops up locally rather than screening three candidates.
  const { run, calls } = sandbox({
    lifted: withoutSample,
    ensLabelSample: () => ['astradyne', 'venchi'],
  });
  await run('randomName()');
  ok('draw: a thin ENS window is topped up from the local list',
    calls.multicall[0].length > 2, String(calls.multicall[0].length));
}

{
  // Typing during the draw wins. The draw is two round-trips; the box must still
  // belong to whoever is typing in it when they come back.
  let release;
  const gate = new Promise(r => { release = r; });
  const { run, els, calls } = sandbox({
    lifted: withoutSample,
    ensLabelSample: async () => { await gate; return ['astradyne', 'venchi', 'morlo']; },
  });
  const drawing = run('randomName()');
  els.get('nameInput').value = 'vitalik';
  release();
  await drawing;
  eq('draw: does not clobber a name typed mid-draw', els.get('nameInput').value, 'vitalik');
  eq('draw: and does not fire a lookup over it', calls.doCheckName, 0);
}

{
  // Overlapping clicks must not stack draws.
  let release;
  const gate = new Promise(r => { release = r; });
  const { run, calls } = sandbox({
    lifted: withoutSample,
    ensLabelSample: async () => { await gate; return ['astradyne', 'venchi', 'morlo']; },
  });
  const a = run('randomName()');
  const b = run('randomName()');
  release();
  await Promise.all([a, b]);
  eq('draw: a second click while drawing is ignored', calls.ensLabelSample, 1);
  eq('draw: one lookup, not two', calls.doCheckName, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
