// Security regressions run the shipping functions with local provider/DOM shims.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const app = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const wallet = fs.readFileSync(new URL('./wallet.js', import.meta.url), 'utf8');
function lift(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex(l => new RegExp(`^(async )?function ${name}\\s*\\(`).test(l));
  assert(start >= 0, `shipping function ${name} exists`);
  let depth = 0;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i]);
    for (const c of lines[i]) { if (c === '{') depth++; else if (c === '}') depth--; }
    if (depth === 0 && out.join('').includes('{')) return out.join('\n');
  }
  throw new Error(`Unterminated function ${name}`);
}

function rpcHarness(search, saved = null) {
  const storage = new Map(saved ? [['wns_rpc', saved]] : []);
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', classList: { add() {} } });
    return elements.get(id);
  };
  const ctx = vm.createContext({
    URLSearchParams, location: { search }, $, document: { body: { classList: { add() {} } } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    RPC_ENDPOINTS: ['https://default.example'], RPCS: ['https://default.example'], MAINNET: 1,
    providerFor: endpoint => ({ endpoint }),
    ethers: { JsonRpcProvider: class { constructor(endpoint) { this.endpoint = endpoint; } } },
    invalidateRpc() {}, getRpc: async () => {}, testRpcUrl: async () => 123,
    setTimeout() {}, closeRpcSettings() {},
  });
  vm.runInContext('let _rpcProvider = null;\n' +
    ['customRpcs', 'buildRpcProvider', 'urlRpc', 'openRpcSettings', 'saveRpcSettings', 'resetRpcSettings'].map(n => lift(app,n)).join('\n') +
    '\n' + lift(wallet, 'getRpcProvider'), ctx);
  return ctx;
}

for (const search of ['?rpc=https://attacker.example', '?rpc=http%3A%2F%2Fattacker.example', '?rpc=https://one.example,https://two.example']) {
  const ctx = rpcHarness(search);
  assert.equal(ctx.buildRpcProvider().endpoint, 'https://default.example');
  assert.equal(ctx.getRpcProvider().endpoint, 'https://default.example');
  ctx.openRpcSettings();
  assert.match(ctx.$('rpcTestMsg').textContent, /inactive/);
  assert.equal(ctx.buildRpcProvider().endpoint, 'https://default.example', 'opening settings does not trust the suggestion');
}
const saved = rpcHarness('?rpc=https://attacker.example', 'https://trusted.example');
assert.equal(saved.buildRpcProvider().endpoint, 'https://trusted.example');
assert.equal(saved.getRpcProvider().endpoint, 'https://trusted.example');
saved.resetRpcSettings();
assert.equal(saved.buildRpcProvider().endpoint, 'https://default.example', 'reset cannot reactivate the link endpoint');

const accepted = rpcHarness('?rpc=https://suggested.example');
accepted.openRpcSettings();
await accepted.saveRpcSettings();
assert.equal(accepted.buildRpcProvider().endpoint, 'https://suggested.example', 'explicit save preserves custom node support');
assert.equal(accepted.getRpcProvider().endpoint, 'https://suggested.example');
assert.match(app, /Only save a node you trust/);
console.log('RPC trust regressions passed (URL, saved settings, reset, explicit acceptance, wallet reads).');
