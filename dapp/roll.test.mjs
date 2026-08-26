// roll.wei panel + token-id parsing tests, against a minimal DOM shim.
//
// Three things went wrong here and each is pinned below.
//
// 1. "Connect & enter" never entered. rollEnter() opened the wallet modal and
//    returned; connecting then fired onConnect -> refreshRoll -> renderRoll, which
//    rewrites the panel's innerHTML — so the name the user had typed was wiped and
//    the entry the button promised never happened.
// 2. The panel hashed names with a bare toLowerCase(), not the ENSIP-15
//    normalization the rest of the app uses, so any name needing NFC normalization
//    got the wrong tokenId: its holder was told the name wasn't active.
// 3. parseTokenId() scanned the raw string, so it scraped digits out of the
//    collection ADDRESS and answered about a token nobody asked for — the worst
//    failure an anti-spoof verifier has.
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

const LIFTED = [
  'tokenIdCandidate', 'parseTokenId',
  'normalizeLabelContract', 'normalizeLabel', 'normalizeFullName', 'computeIdFull',
  'rollTokenFor', 'rollDrawQuote', 'rollDrawValue', 'rollPanelOpen',
  'rollNameChanged', 'rollPreviewWeight', 'rollEnter', 'rollOnConnect', 'rollOnDisconnect',
  'rollDetectBoost', 'rollBoostBps', 'rollBuildField',
  'renderRoll', 'fmtCountdown', 'fmtEth', 'escapeHtml', 'afterReceipt', 'readSideHasTx',
  'fmtUsd', 'fmtAgo', 'rollNameLink', 'fmtPot', 'rollPct', 'rollDonate', 'rollDonateChanged',
];

function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    _classes: new Set(),
    classList: {
      add: c => el._classes.add(c),
      remove: c => el._classes.delete(c),
      contains: c => el._classes.has(c),
    },
  };
  return el;
}

// Build a sandbox holding the lifted functions plus the globals they close over.
function sandbox({ signer = null, address = null, panelOpen = true } = {}) {
  const els = new Map();
  for (const id of ['rollPanel', 'rollBody', 'rollNameInput', 'rollWeightPreview', 'nameInput']) {
    els.set(id, makeEl(id));
  }
  if (panelOpen) els.get('rollPanel').classList.add('show');

  const calls = { enter: [], status: [], refreshRoll: 0 };

  // Real ethers for hashing; a fake Contract so enter() is observable offline.
  const fakeEthers = Object.create(ethers);
  fakeEthers.Contract = class {
    constructor(addr) { this.addr = addr; }
    async enter(tokenId, boostPid) { calls.enter.push({ tokenId, boostPid }); return { hash: '0xtx' }; }
    async draw() { return { hash: '0xtx' }; }
    async claim(r) { return { hash: '0xtx' }; }
  };

  const ctx = {
    ethers: fakeEthers,
    console,
    setTimeout, clearTimeout, TextEncoder, BigInt, Date, Math, Number, String, JSON, Promise, Object,
    document: { getElementById: id => els.get(id) || null },
    window: { _signer: signer, _connectedAddress: address },
    // globals the lifted code reads
    LOTTERY: '0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2',
    LOTTERY_ABI: ['function drawPrice() view returns (uint256)', 'function enter(uint256,uint256)'],
    WEIDAO: '0x00000007988A79d16cf76B5dc4cF54dc3Af24936',
    WEIDAO_ABI: [
      'function proposalCount() view returns (uint256)',
      'function supportOf(uint256 id, uint256 tokenId) view returns (uint256)',
      'function proposals(uint256) view returns (uint64 lastUpdate, uint64 created, bool executed, bool vetoed, address target, uint256 conviction, uint256 supportWeight, uint256 value, bytes data)'
    ],
    CONTRACT: '0x0000000000696760E15f265e828DB644A0c242EB',
    ROLL_PHASE: ['Idle', 'Open', 'Ready', 'Drawing'],
    STETH_MARK: '<svg class="roll-steth"></svg>',
    ens_normalize: undefined,           // exercises the contract-compatible fallback
    isProcessing: false,
    textEncoder: new TextEncoder(),
    ROOT_NODE: '0x' + '00'.repeat(32),
    ROLL_FIELD_RESOLVE: 40,
    ownerOfIface: new ethers.Interface(['function ownerOf(uint256) view returns (address)']),
    iface: new ethers.Interface(['function getFullName(uint256) view returns (string)']),
    rollIface: new ethers.Interface(['function drawPrice() view returns (uint256)']),
    // collaborators stubbed to observable no-ops
    $: id => els.get(id) || null,
    spinnerSVG: () => '',
    showStatus: (m, t) => calls.status.push([m, t]),
    handleError: e => calls.status.push(['error', e?.message || String(e)]),
    waitForTx: async () => ({ status: 1, blockNumber: 100 }),
    wcTransaction: async p => p,
    toggleWallet: () => { calls.toggleWallet = (calls.toggleWallet || 0) + 1; },
    refreshRoll: () => { calls.refreshRoll++; },
    withRpc: async fn => fn(ctx.__provider),
    getRpc: async () => ctx.__provider,
    // Batched reads. The default answers "unreadable" for every slot — the honest
    // stub answer — so tests that care about boost detection inject their own.
    aggregate3: async calls => calls.map(() => null),
    // rollEnter asks before entering unboosted when the boost check couldn't run.
    confirm: () => { calls.confirmed = (calls.confirmed || 0) + 1; return true; },
    __provider: null,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  const prelude = `
    let _rollNameDraft = '';
    let _rollDonateDraft = '';
    let _rollBoostBps = null;
    let _rollPendingEnter = null;
    const ROLL_ENTER_RESUME_MS = 120000;
    const ROLL_DRAW_GAS = 600000n;
    let rollPreviewDebounce = null;
    let rollPreviewVersion = 0;
    function rollRead(p) { return new ethers.Contract(LOTTERY, LOTTERY_ABI, p); }
  `;
  vm.runInContext(prelude + '\n' + LIFTED.map(lift).join('\n\n'), ctx);
  return { ctx, els, calls, run: code => vm.runInContext(code, ctx) };
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok    ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}
function eq(name, got, want) {
  const g = typeof got === 'bigint' ? got.toString() : JSON.stringify(got);
  const w = typeof want === 'bigint' ? want.toString() : JSON.stringify(want);
  ok(name, g === w, `got ${g}\n        want ${w}`);
}

// ── parseTokenId: never answer about a token the user didn't paste ────────────
{
  const { run } = sandbox();
  const ADDR = '0x0000000000696760E15f265e828DB644A0c242EB';
  const ID = '34454361969670104802583458346517400542074712368450903800518897101070583190115';
  const HEX = '0x' + BigInt(ID).toString(16);
  const p = s => run(`parseTokenId(${JSON.stringify(s)})`);

  eq('parseTokenId: decimal id', p(ID), BigInt(ID));
  eq('parseTokenId: hex id', p(HEX), BigInt(ID));
  eq('parseTokenId: opensea url', p(`https://opensea.io/assets/ethereum/${ADDR}/${ID}`), BigInt(ID));
  eq('parseTokenId: url with query', p(`https://opensea.io/assets/ethereum/${ADDR}/${ID}?tab=activity`), BigInt(ID));
  // The regression: a hex id in a URL used to return 81799099653 — digits scraped
  // out of the collection address, which then verified an unrelated token.
  eq('parseTokenId: HEX id in url (was 81799099653)', p(`https://etherscan.io/nft/${ADDR}/${HEX}`), BigInt(ID));
  eq('parseTokenId: address alone is not an id', p(ADDR), null);
  eq('parseTokenId: url with no id at all', p(`https://opensea.io/assets/ethereum/${ADDR}`), null);
  eq('parseTokenId: junk', p('hello world'), null);
}

// ── rollTokenFor: same normalization as the rest of the app ───────────────────
{
  const { run } = sandbox();
  const canonical = run(`computeIdFull('vitalik')`);
  eq('rollTokenFor: plain', run(`rollTokenFor('vitalik').id`), canonical);
  eq('rollTokenFor: uppercase', run(`rollTokenFor('VITALIK').id`), canonical);
  eq('rollTokenFor: .wei suffix', run(`rollTokenFor('vitalik.wei').id`), canonical);
  eq('rollTokenFor: padded + mixed case', run(`rollTokenFor('  Vitalik.WEI  ').id`), canonical);
  eq('rollTokenFor: empty is null', run(`rollTokenFor('')`), null);
  eq('rollTokenFor: whitespace is null', run(`rollTokenFor('   ')`), null);
  eq('rollTokenFor: invalid label is null', run(`rollTokenFor('not a name')`), null);
}

// ── the typed name survives a panel repaint ──────────────────────────────────
{
  const { run, els } = sandbox({ address: '0xabc' });
  run(`_rollNameDraft = ''`);
  els.get('rollNameInput').value = 'vitalik';
  run(`rollNameChanged()`);
  eq('draft captured from the input', run(`_rollNameDraft`), 'vitalik');

  // renderRoll rewrites the whole panel — the value must come back with it.
  const state = `{ phase: 1, round: 4, roundEnd: ${Math.floor(Date.now() / 1000) + 60},
                   pot: 1000000000000000000n, tickets: 3, drawPrice: 0n, drawSettles: false, resetAt: 0 }`;
  run(`renderRoll($('rollBody'), { st: ${state}, round: 4, infos: [], claimable: [], names: {}, draw: null }, '0xabc')`);
  const html = els.get('rollBody').innerHTML;
  ok('repaint refills the entry box with the draft', html.includes('value="vitalik"'),
     'input rendered as: ' + (html.match(/<input[^>]*rollNameInput[^>]*>/) || ['(none)'])[0]);
}

// ── the current-round field renders odds, highlights you, and shows USD ───────
{
  const { run, els } = sandbox({ address: '0xME' });
  const now = Math.floor(Date.now() / 1000);
  const st = `{ phase: 1, round: 7, roundEnd: ${now + 5 * 86400}, pot: 2418800000000000000n,
                totalWeight: 50000000000000n, tickets: 3, drawPrice: 0n, drawSettles: false, resetAt: 0 }`;
  const field = `[
    { tokenId: 1n, weight: 48000000000000n, name: '0x.wei', mine: false },
    { tokenId: 2n, weight: 1500000000000n, name: 'rudxane.wei', mine: false },
    { tokenId: 3n, weight: 500000000000n, name: 'majdao.wei', mine: true }
  ]`;
  run(`renderRoll($('rollBody'), { st: ${st}, round: 7, infos: [], claimable: [], names: {},
        draw: null, field: ${field}, usd: 3000 }, '0xME')`);
  const html = els.get('rollBody').innerHTML;
  ok('field header shows the count', html.includes('This round · 3 in'));
  ok('odds derived from cum weights', /0x\.wei[\s\S]{0,140}?9[0-9]%/.test(html), html);
  ok('the wallet\'s own name is marked', html.includes('roll-mine') && html.includes('roll-you'));
  ok('combined odds line for you', /in with 1 name/.test(html));
  ok('pot shows a USD estimate', /\$7,2\d\d/.test(html));
  ok('names link to their profile', html.includes('href="#majdao"'));
  ok('field is sorted biggest-first', html.indexOf('0x.wei') < html.indexOf('majdao.wei'));
  ok('rows carry an odds bar', html.includes('linear-gradient'));
}

// ── at scale: only the top slice is shown, but combined odds count ALL your names ─────
{
  const { run, els } = sandbox({ address: '0xME' });
  const now = Math.floor(Date.now() / 1000);
  const st = `{ phase: 1, round: 5, roundEnd: ${now + 86400}, pot: 1000000000000000000n,
                totalWeight: 1000000000000n, tickets: 100, drawPrice: 0n, drawSettles: false, resetAt: 0 }`;
  // 3 rows rendered (the top slice), but rollBuildField reports the viewer holds 5 names field-wide.
  const field = `Object.assign([
    { tokenId: 1n, weight: 500000000000n, name: '0x.wei', mine: false },
    { tokenId: 2n, weight: 120000000000n, name: 'me1.wei', mine: true },
    { tokenId: 3n, weight: 80000000000n, name: 'other.wei', mine: false }
  ], { total: 100, mineCount: 5, mineWeight: 250000000000n })`;
  run(`renderRoll($('rollBody'), { st: ${st}, round: 5, infos: [], claimable: [], names: {},
        draw: null, field: ${field}, usd: 2500 }, '0xME')`);
  const html = els.get('rollBody').innerHTML;
  ok('shows +N more with top-by-odds framing', /\+ 97 more · showing the top 3 by odds/.test(html));
  ok('combined odds counts all 5 names, not the 1 visible', /in with 5 names/.test(html), html);
  ok('combined odds uses the field-wide weight (25%)', /~25% combined/.test(html));
  ok('rows sit in a scrollable container', html.includes('roll-field-rows'));
}

// ── rollDetectBoost: auto-find a live proposal the entered name backs ─────────
//
// The boost is bonded once, at enter(), for the whole round. So a read that never
// landed must never be reported as "backs nothing" — that silently halves the odds
// for 30 days. Hence { pid, sure }: `sure` false means the caller must ask, not assume.
{
  const { run, ctx } = sandbox({});
  ctx.__provider = {};
  const backed = new Set(['2']);  // proposal ids the name currently supports
  const unread = new Set();       // proposal ids whose supportOf slot fails to decode
  const state = {
    1: { executed: true, vetoed: false },   // backed-but-executed: no boost
    2: { executed: false, vetoed: false },  // live + backed: the boost
    3: { executed: false, vetoed: false },  // live but not backed
  };
  ctx.aggregate3 = async calls => calls.map(c => {
    if (c.fn === 'proposalCount') return [3n];
    if (c.fn === 'supportOf') {
      const pid = String(c.args[0]);
      return unread.has(pid) ? null : [backed.has(pid) ? 1000n : 0n];
    }
    if (c.fn === 'proposals') return state[Number(c.args[0])] || null;
    return null;
  });

  eq('rollDetectBoost: finds the live backed proposal',
     await run(`rollDetectBoost(123n)`), { pid: 2, sure: true });
  backed.clear();
  eq('rollDetectBoost: 0 when the name backs nothing',
     await run(`rollDetectBoost(123n)`), { pid: 0, sure: true });
  backed.add('1'); // backs only an executed proposal
  eq('rollDetectBoost: skips executed/vetoed proposals',
     await run(`rollDetectBoost(123n)`), { pid: 0, sure: true });

  // The regression that matters: a throttled supportOf must not read as "no boost".
  backed.clear(); unread.add('2');
  eq('rollDetectBoost: an unreadable slot is not "backs nothing"',
     await run(`rollDetectBoost(123n)`), { pid: 0, sure: false });
  unread.clear();

  // ...and a name that does back a live proposal still resolves even if another
  // proposal's slot was unreadable, because a hit is positive evidence.
  backed.add('2'); unread.add('3');
  eq('rollDetectBoost: a confirmed hit wins over an unreadable neighbour',
     await run(`rollDetectBoost(123n)`), { pid: 2, sure: true });
}

// ── rollEnter refuses to silently enter unboosted on an unreadable check ──────
{
  const { run, ctx, calls, els } = sandbox({ signer: {}, address: '0xME' });
  els.get('rollNameInput').value = 'vitalik';
  ctx.aggregate3 = async () => { throw new Error('rpc busy'); };
  ctx.confirm = () => false;                       // user declines
  await run(`rollNameChanged({ target: { value: 'vitalik' } }); rollEnter()`);
  await new Promise(r => setTimeout(r, 10));
  ok('declining the unboosted warning cancels the entry', calls.enter.length === 0);
  ok('and isProcessing is released', ctx.isProcessing === false);
}

// ── "Connect & enter" actually enters ────────────────────────────────────────
{
  const { run, els, calls, ctx } = sandbox({ signer: null, address: null });
  els.get('rollNameInput').value = 'vitalik';
  run(`rollNameChanged()`);
  await run(`rollEnter()`);

  ok('disconnected click opens the wallet modal', calls.toggleWallet === 1);
  eq('no entry submitted while disconnected', calls.enter.length, 0);
  ok('the intent is remembered', run(`!!_rollPendingEnter`));

  // Wallet connects: onConnect fires. This is the path that used to lose the entry.
  ctx.window._signer = {};
  ctx.window._connectedAddress = '0xabc';
  run(`rollOnConnect()`);
  await new Promise(r => setTimeout(r, 10));

  eq('the entry is submitted after connecting', calls.enter.length, 1);
  eq('and for the name that was typed', calls.enter[0]?.tokenId, run(`computeIdFull('vitalik')`));
  ok('the intent is consumed, not left armed', run(`_rollPendingEnter === null`));
  // The post-tx refresh must actually reach refreshRoll (it is gated through
  // afterReceipt now, and a missing symbol there would vanish into rollEnter's catch).
  ok('the panel is refreshed after the entry lands', calls.refreshRoll >= 1,
     `refreshRoll called ${calls.refreshRoll} times; last status: ${JSON.stringify(calls.status.at(-1))}`);
}

// ── afterReceipt: don't repaint from a node that is behind the tx ─────────────
{
  const { run, ctx } = sandbox();
  let height = 100;
  ctx.__provider = { getBlockNumber: async () => height };

  let ran = 0;
  ctx.noop = () => { ran++; };

  // No block number on the receipt -> nothing to wait for, run straight away.
  await run(`afterReceipt({}, () => { noop(); }, { tries: 2, delayMs: 5 })`);
  eq('receipt with no block runs the refresh immediately', ran, 1);

  // Read node behind the tx: the refresh waits, then fires once it catches up.
  ran = 0;
  const pending = run(`afterReceipt({ blockNumber: 105 }, () => { noop(); }, { tries: 20, delayMs: 10 })`);
  await new Promise(r => setTimeout(r, 60));
  eq('behind the tx block: refresh withheld', ran, 0);
  height = 105;
  await pending;
  eq('caught up: refresh fires', ran, 1);
}

// ── readSideHasTx: prefer evidence about THIS tx over the chain tip ───────────
// eth_blockNumber and eth_call are separate methods a load-balanced endpoint may
// serve from different backends, so a caught-up height says little about the
// backend that answers the next call. Asking the read path for the receipt is
// evidence about the tx itself.
{
  const { run, ctx } = sandbox();
  let seen = false;
  ctx.__provider = {
    // Height says "caught up" while the read side has NOT indexed the tx.
    getBlockNumber: async () => 999,
    getTransactionReceipt: async () => (seen ? { blockNumber: 100 } : null),
  };
  eq('receipt not visible yet -> not caught up, despite a caught-up height',
     await run(`readSideHasTx({ hash: '0xabc', blockNumber: 100 })`), false);
  seen = true;
  eq('receipt visible -> caught up', await run(`readSideHasTx({ hash: '0xabc', blockNumber: 100 })`), true);

  // No hash to go on: fall back to the height comparison.
  eq('no hash, height behind -> not caught up',
     await run(`readSideHasTx({ blockNumber: 1000000 })`), false);
  eq('no hash, height ahead -> caught up',
     await run(`readSideHasTx({ blockNumber: 5 })`), true);

  // An unreadable read side must never starve the refresh.
  ctx.__provider = {
    getBlockNumber: async () => { throw new Error('rpc down'); },
    getTransactionReceipt: async () => { throw new Error('rpc down'); },
  };
  eq('unreadable read side -> proceed rather than hang',
     await run(`readSideHasTx({ hash: '0xabc', blockNumber: 100 })`), true);
  eq('no receipt at all -> proceed', await run(`readSideHasTx(null)`), true);
}

// ── a dismissed modal must not arm a surprise transaction ────────────────────
{
  const { run, els, calls, ctx } = sandbox({ signer: null, address: null });
  els.get('rollNameInput').value = 'vitalik';
  run(`rollNameChanged()`);
  await run(`rollEnter()`);

  // User dismissed the modal and connected much later for something unrelated.
  run(`_rollPendingEnter.at = Date.now() - ROLL_ENTER_RESUME_MS - 1`);
  ctx.window._signer = {};
  run(`rollOnConnect()`);
  await new Promise(r => setTimeout(r, 10));
  eq('a stale intent is not resumed', calls.enter.length, 0);
}

{
  const { run, calls, ctx } = sandbox({ signer: null, address: null, panelOpen: false });
  run(`rollOnConnect()`);
  eq('closed panel does not refresh on connect', calls.refreshRoll, 0);
  ctx.els = null;
}
{
  const { run, calls } = sandbox({ panelOpen: true });
  run(`rollOnConnect()`);
  eq('open panel does refresh on connect', calls.refreshRoll, 1);
}

// ── drawPrice() is quoted with a real gas price ──────────────────────────────
{
  const iface = new ethers.Interface(['function drawPrice() view returns (uint256)']);
  const enc = v => iface.encodeFunctionResult('drawPrice', [v]);
  const GWEI = ethers.parseUnits('10', 'gwei');

  // A node that prices eth_call properly: 0 at gasprice 0, real price otherwise.
  {
    const { run, ctx } = sandbox();
    ctx.__provider = {
      getFeeData: async () => ({ maxFeePerGas: GWEI, gasPrice: GWEI }),
      call: async req => enc(req.gasPrice ? req.gasPrice * 373539n : 0n),
    };
    const q = await run(`rollDrawQuote(__provider)`);
    ok('priced quote is used', q.priced === true);
    eq('priced quote is the real price', q.price, GWEI * 373539n);
    const v = run(`rollDrawValue(${JSON.stringify(q.price.toString())} ? {price:${q.price}n} : null)`);
    ok('value sent covers the price', v >= q.price, `${v} < ${q.price}`);
  }

  // publicnode/merkle: refuses a priced eth_call. The gas term must be rebuilt.
  {
    const { run, ctx } = sandbox();
    ctx.__provider = {
      getFeeData: async () => ({ maxFeePerGas: GWEI, gasPrice: GWEI }),
      call: async req => { if (req.gasPrice) throw new Error('missing revert data'); return enc(0n); },
    };
    const q = await run(`rollDrawQuote(__provider)`);
    ok('falls back when the node refuses a priced call', q.priced === false);
    const value = run(`rollDrawValue({price:${q.price}n})`);
    const required = GWEI * 373539n; // measured mainnet cost at this gas price
    ok('fallback still covers the real requirement', value >= required,
       `sends ${ethers.formatEther(value)} ETH, needs ${ethers.formatEther(required)} ETH`);
    ok('and is not the old hardcoded 0.01 ETH', value !== ethers.parseEther('0.01'));
  }

  // No quote at all -> the 0.01 ETH floor is still there as a last resort.
  {
    const { run } = sandbox();
    eq('null quote falls back to 0.01 ETH', run(`rollDrawValue(null)`), ethers.parseEther('0.01'));
  }
}



// ── rollBuildField: owner sweep, name slice, and the index that joins them ────
//
// The rows are read out of one flat aggregate3 result by offset, so the boundary
// between the owner sweep and the name slice is load-bearing. It moves when the
// sweep is skipped for a disconnected viewer, and the whole thing is chunked, so
// both the offset and the stitching are pinned here.
{
  const { run, ctx } = sandbox({});
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ tokenId: BigInt(i + 1), cum: BigInt((i + 1) * 10) }));
  // Every ticket weighs 10; owner of token N is 0xA for odd N, 0xB for even.
  ctx.__seen = [];
  ctx.aggregate3 = async calls => {
    ctx.__seen.push(calls.length);
    return calls.map(c => {
      const id = Number(c.args[0]);
      if (c.fn === 'ownerOf') return [id % 2 ? '0xAA' : '0xBB'];
      if (c.fn === 'getFullName') return ['name' + id + '.wei'];
      return null;
    });
  };

  const connected = await run(`rollBuildField(${JSON.stringify(mk(5).map(t => ({ tokenId: t.tokenId.toString(), cum: t.cum.toString() })))}, '0xAA')`);
  ok('connected: every row gets its name', connected.every(r => /^name\d+\.wei$/.test(r.name)), connected.map(r => r.name).join(','));
  ok('connected: counts the viewer\'s names field-wide', connected.mineCount === 3, 'mineCount=' + connected.mineCount);
  ok('connected: sums the viewer\'s weight', connected.mineWeight === 30n, 'mineWeight=' + connected.mineWeight);
  ok('connected: marks the viewer\'s own rows', connected.filter(r => r.mine).length === 3);

  // Disconnected: the owner sweep is skipped, so the name slice starts at 0.
  // Getting this wrong reads owners as names and every row renders blank.
  ctx.__seen = [];
  const anon = await run(`rollBuildField(${JSON.stringify(mk(5).map(t => ({ tokenId: t.tokenId.toString(), cum: t.cum.toString() })))}, null)`);
  ok('disconnected: names still land on the right rows', anon.every(r => /^name\d+\.wei$/.test(r.name)), anon.map(r => r.name).join(','));
  ok('disconnected: no owner sweep is issued', ctx.__seen.reduce((a, b) => a + b, 0) === 5, 'calls=' + ctx.__seen);
  ok('disconnected: nothing is marked as the viewer\'s', anon.every(r => !r.mine) && anon.mineCount === 0);

  // Chunked: 300 tickets = 300 ownerOf + 40 getFullName = 340 calls, over the 250 cap.
  ctx.__seen = [];
  const big = await run(`rollBuildField(${JSON.stringify(mk(300).map(t => ({ tokenId: t.tokenId.toString(), cum: t.cum.toString() })))}, '0xAA')`);
  ok('chunked: split into batches under the cap', ctx.__seen.length > 1 && ctx.__seen.every(n => n <= 250), 'batches=' + ctx.__seen);
  ok('chunked: results stitch back in order', big.every(r => /^name\d+\.wei$/.test(r.name)), big.slice(0, 3).map(r => r.name).join(','));
  ok('chunked: the full field is still counted', big.total === 300 && big.mineCount === 150, 'total=' + big.total + ' mine=' + big.mineCount);
  ok('chunked: only the top slice is rendered', big.length === 40, 'rows=' + big.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
