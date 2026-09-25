// WeiDAO console tests: the two hand-rolled ABI encoders, log-based description
// recovery, and escaping of chain-supplied text.
//
// The console exists because descriptions can go missing on-chain: propose() mints
// <id>.dao.wei inside a swallowed try/catch, and eth_estimateGas returns a limit
// where that naming runs out of gas while the transaction still succeeds. Proposal 9
// landed that way — no subdomain, no description record. The text is still in the
// ProposalCreated log forever, so the console reads it from there, and floors the
// propose gas so it stops happening.
//
// Functions are pulled out of the shipping dapp/dao.html and run in a vm sandbox.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'dao.html'), 'utf8');
const JS = SRC.slice(SRC.indexOf('<script>') + 8, SRC.lastIndexOf('</script>'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => cond
  ? (pass++, console.log('ok    ' + name))
  : (fail++, console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')));
const eq = (name, got, want) => ok(name, got === want, `got  ${got}\n        want ${want}`);

function sandbox() {
  const els = new Map();
  const mk = () => ({
    innerHTML: '', textContent: '', className: '', style: {}, dataset: {}, checked: false, value: '',
    querySelector: mk, querySelectorAll: () => [], insertAdjacentHTML() {}, insertBefore() {},
    remove() {}, appendChild() {}, addEventListener() {}
  });
  const listeners = {};
  const ctx = {
    console, setTimeout, clearTimeout, TextEncoder, BigInt, Number, String, Math, JSON, Date,
    Promise, Object, Array, fetch: async () => { throw new Error('no network in tests'); },
    document: { getElementById: id => els.get(id) || (els.set(id, mk()), els.get(id)), createElement: mk },
    window: { isSecureContext: true, addEventListener: (k, f) => (listeners[k] ??= []).push(f), dispatchEvent: () => {} },
    location: { origin: 'https://wei.domains', protocol: 'https:' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    Event: class { constructor(t) { this.type = t; } },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Run everything except the bootstrap IIFE, which would hit the network.
  const body = JS.slice(0, JS.lastIndexOf('(async()=>{'));
  vm.runInContext(body, ctx);
  return { ctx, els, run: code => vm.runInContext(code, ctx) };
}

const { ctx, run } = sandbox();

// ── propose(address,uint256,bytes,string) — vectors generated with `cast calldata`
{
  const want1 = '0x82ff16c10000000000000000000000000000000000696760e15f265e828db644a0c242eb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000043ccfd60b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002f5769746864726177206163637275656420574e5320726567697374726174696f6e206665657320696e746f2044414f0000000000000000000000000000000000';
  const got1 = run(`encodePropose("0x0000000000696760E15f265e828DB644A0c242EB",0n,"0x3ccfd60b","Withdraw accrued WNS registration fees into DAO")`);
  eq('encodePropose matches cast (proposal 9 exactly)', got1.toLowerCase(), want1.toLowerCase());

  // A description crossing the 32-byte word boundary, with multi-byte UTF-8 in it.
  const long = 'fund roll.wei round 2 with 1.5 ETH — a longer description that crosses the 32-byte word boundary';
  const got2 = run(`encodePropose("0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2",1500000000000000000n,"0x",${JSON.stringify(long)})`);
  const body = got2.slice(10);
  ok('long description: value word is the ETH amount', BigInt('0x' + body.slice(64, 128)) === 1500000000000000000n);
  ok('long description: empty calldata encodes as a zero-length block',
     BigInt('0x' + body.slice(256, 320)) === 0n, body.slice(256, 320));
  const descLen = Number(BigInt('0x' + body.slice(320, 384)));
  eq('long description: length is the UTF-8 byte count, not the JS string length',
     descLen, Buffer.byteLength(long, 'utf8'));
  ok('long description: em-dash survives as UTF-8',
     Buffer.from(body.slice(384, 384 + descLen * 2), 'hex').toString('utf8') === long);
  ok('every encoding is a whole number of words', (got2.length - 10) % 64 === 0);
}

// ── multicall(bytes[]) — the batch used for support / veto-support
{
  const want = '0xac9650d800000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000449be56c670000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000007b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000449be56c67000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000001c800000000000000000000000000000000000000000000000000000000';
  const got = run(`encodeMulticall(["${'9be56c67'}"+h(6)+h(123n),"${'9be56c67'}"+h(6)+h(456n)])`);
  eq('encodeMulticall matches cast', got.toLowerCase(), want.toLowerCase());
}

// ── description recovery: decode a real ProposalCreated payload
{
  // The real ProposalCreated payload from tx 0x6c80d73c… (proposal 9), whose
  // <id>.dao.wei mint ran out of gas — so this text exists ONLY in the log.
  const data = '0000000000000000000000000000000000696760e15f265e828db644a0c242eb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000043ccfd60b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002f5769746864726177206163637275656420574e5320726567697374726174696f6e206665657320696e746f2044414f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008726f73732e776569000000000000000000000000000000000000000000000000';
  ctx.__d = data;
  eq('readString recovers a description the on-chain page cannot see',
     run(`readString(__d,3)`), 'Withdraw accrued WNS registration fees into DAO');
  eq('readString recovers the proposer name', run(`readString(__d,4)`), 'ross.wei');
}

// ── chain-supplied text reaches innerHTML, so it must be escaped
{
  eq('esc neutralises a tag', run(`esc('<img src=x onerror="alert(1)">')`),
     '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  eq('esc neutralises an attribute break-out', run(`esc('"><script>alert(2)</script>')`),
     '&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
  eq('esc escapes ampersands so entities cannot be smuggled', run(`esc('&lt;')`), '&amp;lt;');
}

// ── the reason this file exists
{
  ok('propose gas is floored above the ~470k the naming costs',
     run(`PROPOSE_GAS_FLOOR`) >= 600000n, 'floor=' + run(`PROPOSE_GAS_FLOOR`));
  ok('the floor is documented next to the constant',
     /estimator omits it because its failure is swallowed/.test(JS));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
