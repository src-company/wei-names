// Pins the multi-year pricing and the commitment binding it depends on.
//
// Two things here are worth failing loudly over. Pricing first: the registry charges the premium
// once and the fee once per year, so a quote is premium + N x fee. Multiplying the premium too
// would overcharge exactly the names that carry one, and nothing on-chain would catch it —
// reveal() takes what it is sent and refunds the difference, so an overcharge shows up as a
// smaller refund, not an error.
//
// Then the binding. A commitment made for WeiTerms derives its secret from (innerSecret,
// recipient, terms); one made for zRouter derives it from (innerSecret, recipient). Deriving the
// wrong one produces a commitment no reveal can match, and the failure lands 60 seconds later,
// after the user has already paid for the commit.
//
// Functions are lifted out of index.html by name and run in a vm sandbox, so this reads the
// shipping source rather than a copy of it. No network, no chain.
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
  const line = SRC.find(l => new RegExp(`^const ${name} =`).test(l));
  if (!line) throw new Error(`index.html no longer defines ${name}`);
  return line;
}

const ZROUTER = liftConst('ZROUTER').match(/'(0x[0-9a-fA-F]+)'/)[1];

// The dapp ships with WEI_TERMS empty until the contract is deployed, and every term control
// hides itself while it is. Both states are exercised from the one source.
function sandbox(weiTerms) {
  const els = new Map();
  const mk = id => {
    const el = { id, style: {}, innerHTML: '', textContent: '', value: '', options: [] };
    els.set(id, el);
    return el;
  };
  const termRow = mk('termRow');
  termRow.style.display = 'none';   // as the markup ships it
  const termSelect = mk('termSelect');
  const termNote = mk('termNote');
  const ctx = {
    ethers, BigInt, Number, String, Date, Math, JSON, Error, console,
    $: id => els.get(id) || null,
    escapeHtml: s => String(s ?? ''),
    fmtEth: (wei, dp = 4) => {
      const n = parseFloat(ethers.formatEther(wei));
      if (n === 0) return '0';
      if (n < 0.0001) return '<0.0001';
      return n.toLocaleString('en-US', { maximumFractionDigits: dp });
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext([
    `const WEI_TERMS = '${weiTerms}';`,
    liftConst('ZROUTER'),
    liftConst('MAX_TERMS'),
    liftConst('TERM_SECS'),
    'let _termFee = null, _termPremium = null;',
    lift('termsTotal'),
    lift('committerFor'),
    lift('termsAvailable'),
    lift('selectedTerms'),
    lift('validTerms'),
    lift('termOptionsHtml'),
    lift('showTermRow'),
    lift('hideTermRow'),
    lift('onTermChange'),
  ].join('\n\n'), ctx, { filename: 'index.html' });
  return { termRow, termSelect, termNote, run: c => vm.runInContext(c, ctx) };
}

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('ok    ' + label); }
  else { fail++; console.log('FAIL  ' + label + (detail ? '\n        ' + detail : '')); }
}
function eq(label, got, want) {
  ok(label, String(got) === String(want), `got ${got}\n        want ${want}`);
}

const DEPLOYED = '0x00000000000000000000000000000000000000Fe';

// -- pricing -----------------------------------------------------------------
{
  const { run } = sandbox(DEPLOYED);
  const fee = 500000000000000n;          // the live 5-plus character fee
  const premium = 3n * 10n ** 18n;

  eq('price: one year is one fee', run(`termsTotal(${fee}n, 0n, 1)`), fee);
  eq('price: ten years is ten fees', run(`termsTotal(${fee}n, 0n, 10)`), fee * 10n);
  eq('price: the premium is charged once, not per year',
    run(`termsTotal(${fee}n, ${premium}n, 5)`), premium + fee * 5n);
  eq('price: a missing premium reads as zero', run(`termsTotal(${fee}n, null, 3)`), fee * 3n);

  // The steep short-name tiers are why the total is shown rather than the rate.
  eq('price: a one-character name for ten years',
    run(`termsTotal(${5n * 10n ** 17n}n, 0n, 10)`), 5n * 10n ** 18n);
}

// -- which contract a commitment binds to ------------------------------------
{
  const { run } = sandbox(DEPLOYED);
  eq('bind: one year goes to zRouter, which can also swap USDC or DAI',
    run('committerFor(1)'), ZROUTER);
  eq('bind: more than one year goes to WeiTerms', run('committerFor(5)'), DEPLOYED);
  eq('bind: ten years too', run('committerFor(10)'), DEPLOYED);
}

// The two derivations must not be confused: WeiTerms recomputes keccak(inner, to, terms), zRouter
// recomputes keccak(inner, to). A commitment made with the wrong one is unrevealable.
{
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const inner = '0x' + '11'.repeat(32);
  const to = '0x00000000000000000000000000000000000000A1';
  const three = (t, n) => ethers.keccak256(abi.encode(['bytes32', 'address', 'uint256'], [inner, t, n]));

  ok('secret: the WeiTerms and zRouter derivations differ',
    three(to, 5) !== ethers.keccak256(abi.encode(['bytes32', 'address'], [inner, to])));
  ok('secret: changing the term count changes the secret', three(to, 5) !== three(to, 1));
  ok('secret: changing the recipient changes the secret',
    three(to, 5) !== three('0x00000000000000000000000000000000000000B2', 5));
}

// -- the control itself ------------------------------------------------------
{
  const { run, termRow, termSelect, termNote } = sandbox(DEPLOYED);

  eq('control: hidden before a name is priced', termRow.style.display, 'none');
  run('showTermRow(500000000000000n, 0n)');
  eq('control: shown once there is something to buy', termRow.style.display, '');
  ok('control: offers every term the UI allows',
    termSelect.innerHTML.includes('>1 year<') && termSelect.innerHTML.includes('>10 years<'));
  ok('control: singular for one, plural above', !termSelect.innerHTML.includes('>1 years<'));

  eq('control: defaults to one year', run('selectedTerms()'), 1);
  ok('control: prices the default', termNote.innerHTML.includes('0.0005 ETH'), termNote.innerHTML);

  termSelect.value = '10';
  run('onTermChange()');
  eq('control: ten years selected', run('selectedTerms()'), 10);
  ok('control: and repriced', termNote.innerHTML.includes('0.005 ETH'), termNote.innerHTML);
  ok('control: says multi-year is ETH only', termNote.innerHTML.includes('ETH only'));

  termSelect.value = '1';
  run('onTermChange()');
  ok('control: one year does not claim to be ETH only', !termNote.innerHTML.includes('ETH only'));

  run('hideTermRow()');
  eq('control: hidden again when there is nothing to buy', termRow.style.display, 'none');
}

// A selection carried from one name to the next would reprice silently across fee tiers.
{
  const { run, termSelect } = sandbox(DEPLOYED);
  run('showTermRow(500000000000000n, 0n)');       // a five-plus character name
  termSelect.value = '10';
  run('onTermChange()');
  eq('tier: ten years chosen on a cheap name', run('selectedTerms()'), 10);

  run('showTermRow(500000000000000000n, 0n)');     // a one-character name, 1000x the fee
  eq('tier: a different fee tier resets to one year', run('selectedTerms()'), 1);

  run('showTermRow(500000000000000000n, 0n)');     // same tier again
  eq('tier: the same fee tier keeps the selection', run('selectedTerms()'), 1);
  termSelect.value = '4';
  run('showTermRow(500000000000000000n, 0n)');
  eq('tier: still the same tier, still kept', run('selectedTerms()'), 4);
}

// A term count outside the offered range must never reach the contract, whatever the DOM says.
{
  const { run, termSelect } = sandbox(DEPLOYED);
  run('showTermRow(1n, 0n)');
  for (const bad of ['0', '-3', '99', '', 'abc', '1.5']) {
    termSelect.value = bad;
    eq(`control: "${bad}" falls back to one year`, run('selectedTerms()'), 1);
  }
}

// -- before the contract is deployed -----------------------------------------
{
  const { run, termRow } = sandbox('');
  ok('undeployed: terms are unavailable', run('termsAvailable()') === false);
  run('showTermRow(1n, 0n)');
  eq('undeployed: the control stays hidden', termRow.style.display, 'none');
  eq('undeployed: and one year is the only answer', run('selectedTerms()'), 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
