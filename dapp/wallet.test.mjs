// wallet.js connect-path tests against a minimal DOM/provider shim.
//
// The case that matters: a silent auto-connect whose provider never answers must
// not wedge the manual connect that follows it. _isConnecting used to be an
// unconditional gate with no timeout anywhere on the silent path, so a wallet
// that stopped answering eth_accounts (or WalletConnect's enable() with no
// session to restore) latched it true for the life of the page. Every later
// click on a wallet in the modal then returned immediately and did nothing,
// while the optimistic label left the corner reading "connected" — so the dapp
// showed a connected wallet, kept _connectedAddress null, and rendered
// "Connect as owner to manage" on names the user owned.
//
// No network, no chain, no dependencies beyond ethers (already vendored).
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import { ethers } from 'ethers';

const ADDR = '0x1111111111111111111111111111111111111111';

function makeEl(id) {
  const el = {
    id, textContent: '', innerHTML: '', className: '', style: {}, dataset: {},
    _classes: new Set(), children: [],
    classList: { add: c => el._classes.add(c), remove: c => el._classes.delete(c), contains: c => el._classes.has(c) },
    appendChild(c) { el.children.push(c); return c; },
    prepend(c) { el.children.unshift(c); return c; },
    querySelectorAll: () => [], addEventListener() {}, removeListener() {}, remove() {},
  };
  return el;
}

function harness({ hangSilent, chain }) {
  // Scriptable chain for the reverse-resolve tests: `height` is what the read
  // provider reports, `reverse()` what reverseResolve() answers on each call.
  chain = chain || { height: 0, reverse: () => '' };
  const els = new Map();
  for (const id of ['walletBtn', 'walletModal', 'walletOptions']) els.set(id, makeEl(id));
  const body = makeEl('body');
  const head = makeEl('head');
  const scripts = [];               // every <script> appended to <head>, in order
  const document = {
    body,
    head,
    getElementById: id => els.get(id) || null,
    createElement: (tag) => {
      const el = makeEl(null);
      // injectWalletDOM writes innerHTML containing #walletBtn; it's already in els.
      el.tagName = String(tag || '').toUpperCase();
      return el;
    },
  };
  head.appendChild = (c) => { if (c.tagName === 'SCRIPT') scripts.push(c); head.children.push(c); return c; };

  let store = {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };

  // A provider that never settles on the silent probe, then behaves once the
  // user clicks a wallet themselves.
  const provider = {
    request: ({ method }) => {
      if (method === 'eth_accounts') {
        return hangSilent ? new Promise(() => {}) : Promise.resolve([ADDR]);
      }
      if (method === 'eth_requestAccounts') return Promise.resolve([ADDR]);
      if (method === 'eth_chainId') return Promise.resolve('0x1');
      if (method === 'wallet_getCapabilities') return Promise.resolve(null);
      return Promise.resolve(null);
    },
    on() {}, removeListener() {},
  };

  // Providers are stubbed too: resolveWeiName() calls getBlockNumber() on whatever
  // getRpcProvider() hands back, and a real one would reach for the network.
  const stubProvider = class { constructor() {} async getBlockNumber() { return chain.height; } };
  const fakeEthers = {
    ...ethers,
    BrowserProvider: class { async getSigner() { return { getAddress: async () => ADDR }; } },
    JsonRpcProvider: stubProvider,
    FallbackProvider: stubProvider,
    Contract: class { async reverseResolve() { return chain.reverse(); } },
  };

  const listeners = {};
  const win = {
    ethereum: provider,
    localStorage,
    location: { origin: 'https://wei.domains', search: '' },
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    dispatchEvent: () => true,
    document,
    setTimeout, clearTimeout, console,
    ethers: fakeEthers,
    URLSearchParams,
    Promise, Error, Map, Set, Object, Array, String, Number, BigInt, JSON, Date,
  };
  win.window = win;
  win.globalThis = win;
  win.Event = class { constructor(t) { this.type = t; } };
  win.self = win;
  win.__WALLET_ENABLE_TEST_API__ = true; // gated test seam for connectWithWallet

  const ctx = vm.createContext(win);
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  vm.runInContext(fs.readFileSync(path.join(here, 'wallet.js'), 'utf8'), ctx, { filename: 'wallet.js' });
  return { ctx, win, els, store, chain, scripts, setSaved: k => { store['zfi_wallet'] = k; } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(hangSilent) {
  const h = harness({ hangSilent });
  h.setSaved('injected');            // a saved wallet -> tryAutoConnect fires
  h.win.walletInit({ appName: 't', onConnect: [], onDisconnect: [] });
  await sleep(120);                  // let the 50ms auto-connect timer run
  // Now the user clicks a wallet in the modal, exactly as renderWalletModal wires it.
  await h.win.__WALLET_TEST_API__?.connectWithWallet?.('injected');
  return h;
}

let pass = 0;
let fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; console.log('ok   ', label); }
  else { fail++; console.log('FAIL ', label, '\n  got ', got, '\n  want', want); }
}

// Control: a healthy silent reconnect still connects on its own.
{
  const h = await run(false);
  await sleep(50);
  eq('healthy silent auto-connect connects', h.win._connectedAddress, ADDR);
  eq('healthy silent auto-connect marks the button connected',
     h.els.get('walletBtn').classList.contains('connected'), true);
}

// Regression: the silent probe never settles, then the user clicks a wallet.
{
  const h = await run(true);
  await sleep(50);
  eq('manual connect survives a wedged silent auto-connect', h.win._connectedAddress, ADDR);
}

// A wedged auto-connect that the user never rescues must not leave the corner
// button claiming a connection that does not exist.
{
  const h = harness({ hangSilent: true });
  h.setSaved('injected');
  h.store['wns_last'] = ADDR.toLowerCase();
  h.store['wns_rev:' + ADDR.toLowerCase()] = 'someone.wei'; // triggers the optimistic paint
  h.win.walletInit({ appName: 't', onConnect: [], onDisconnect: [] });
  await sleep(120);
  eq('wedged auto-connect leaves _connectedAddress null', h.win._connectedAddress, null);
  // The invariant: .connected on the corner button means "there is a signer".
  eq('wedged auto-connect never wears the connected class',
     h.els.get('walletBtn').classList.contains('connected'), false);
}

// ── resolveWeiName: a read-after-write must not paint the pre-tx answer ───────
//
// setPrimaryName's receipt comes from tx.wait(), i.e. the WALLET's node, while this
// reads over the public endpoints. Ungated, the read landed on a node still a block
// behind, answered with the OLD primary name, and that stale answer was cached under
// wns_rev AND painted — flipping the corner back to a bare 0x… address, with nothing
// re-polling to correct it before the next page load.
async function reverseHarness(chain) {
  const h = harness({ hangSilent: false, chain });
  h.setSaved('injected');
  h.win.walletInit({ appName: 't', onConnect: [], onDisconnect: [] });
  await sleep(120);
  await h.win.__WALLET_TEST_API__?.connectWithWallet?.('injected');
  await sleep(300); // let the connect-time resolve finish its read AND its 130ms fade
  return h;
}

{
  // The read node is a block behind, so it still serves the pre-tx answer — exactly
  // what a public endpoint does when the receipt came from the wallet's own node.
  // Nothing may be painted or cached until it catches up.
  const chain = { height: 100, reverse: () => (chain.height >= 101 ? 'new.wei' : 'old.wei') };
  const h = await reverseHarness(chain);
  h.els.get('walletBtn').textContent = 'new.wei';       // the optimistic paint
  h.store['wns_rev:' + ADDR.toLowerCase()] = 'old.wei';

  h.win.resolveWeiName(ADDR, { minBlock: 101, expect: 'new.wei', tries: 6, delayMs: 20 });
  await sleep(30);
  eq('behind the tx block: label untouched', h.els.get('walletBtn').textContent, 'new.wei');
  eq('behind the tx block: stale name not cached', h.store['wns_rev:' + ADDR.toLowerCase()], 'old.wei');

  chain.height = 101;                                    // node catches up
  await sleep(300);
  eq('caught up: the new name is cached', h.store['wns_rev:' + ADDR.toLowerCase()], 'new.wei');
  eq('caught up: the label is the new name', h.els.get('walletBtn').textContent, 'new.wei');
}

{
  // Graceful degradation: setPrimaryName only needs ownership, but reverseResolve
  // also needs resolve() to point back at you — an owner who set the record
  // elsewhere really does get "". The last attempt must accept that.
  const h = await reverseHarness({ height: 5, reverse: () => '' });
  h.els.get('walletBtn').textContent = 'mine.wei';
  h.win.resolveWeiName(ADDR, { minBlock: 5, expect: 'mine.wei', tries: 3, delayMs: 20 });
  await sleep(400);
  eq('a name that never reverse-resolves still settles',
     h.els.get('walletBtn').textContent, ADDR.slice(0, 6) + '...' + ADDR.slice(-4));
}

{
  // The bare call (connect / account switch) is still a single unconditional read.
  let calls = 0;
  const h = await reverseHarness({ height: 9, reverse: () => { calls++; return 'a.wei'; } });
  calls = 0;
  h.win.resolveWeiName(ADDR);
  await sleep(250);
  eq('bare call reads exactly once', calls, 1);
  eq('bare call paints what it read', h.els.get('walletBtn').textContent, 'a.wei');
}

// ── WalletConnect is loaded on demand, not on every page load ─────────────────
//
// The 624 KB WC bundle used to be a plain <script> in index.html, so every visit
// paid for it whether or not anyone touched WalletConnect. It is now fetched by
// loadWalletConnect() at the moment it is needed. These lock that in: the option
// must still be offered with no bundle present, the click must fetch it exactly
// once, and a failed fetch must stay retryable rather than forgetting the user's
// saved wallet.

function wcHarness() {
  const h = harness({ hangSilent: false });
  h.win.walletInit({ appName: 't', onConnect: [], onDisconnect: [] });
  return h;
}

// The bundle a successful fetch would install.
function installWcBundle(win, { enable } = {}) {
  win['@walletconnect/ethereum-provider'] = {
    EthereumProvider: {
      init: async () => ({
        on() {}, removeListener() {},
        enable: enable || (async () => [ADDR]),
        request: ({ method }) => method === 'eth_chainId' ? Promise.resolve('0x1') : Promise.resolve(null),
        session: { peer: { metadata: {} } },
        disconnect: async () => {},
      }),
    },
  };
}

{
  // No bundle loaded, and no <script> fetched just to render the list.
  const h = wcHarness();
  h.win.showWalletModal();
  await sleep(500);                                  // 150ms detect + one 250ms retry
  const html = h.els.get('walletOptions').innerHTML;
  eq('WalletConnect is offered without the bundle loaded', html.includes('WalletConnect'), true);
  eq('rendering the modal fetches nothing', h.scripts.length, 0);
}

{
  // Clicking it fetches the bundle, once, from the path index.html used to hardcode.
  const h = wcHarness();
  const connected = h.win.__WALLET_TEST_API__.connectWithWallet('walletconnect');
  await sleep(20);
  eq('picking WalletConnect fetches the bundle', h.scripts.length, 1);
  eq('from the vendored path', h.scripts[0].src, 'vendor/walletconnect.min.js');
  eq('and does not block the page', h.scripts[0].async, true);

  installWcBundle(h.win);
  h.scripts[0].onload();
  await connected;
  eq('the connect completes once the bundle lands', h.win._connectedAddress, ADDR);
}

{
  // Already in memory => no second fetch.
  const h = wcHarness();
  installWcBundle(h.win);
  await h.win.__WALLET_TEST_API__.connectWithWallet('walletconnect');
  eq('an already-loaded bundle is not re-fetched', h.scripts.length, 0);
  eq('and connects straight through', h.win._connectedAddress, ADDR);
}

{
  // A silent restore of a saved WC session pulls the bundle in too — that is the
  // one path where the eager <script> was actually earning its keep.
  const h = harness({ hangSilent: false });
  h.setSaved('walletconnect');
  h.win.walletInit({ appName: 't', onConnect: [], onDisconnect: [] });
  await sleep(120);                                  // 50ms auto-connect timer
  eq('restoring a saved WC session fetches the bundle', h.scripts.length, 1);
  installWcBundle(h.win);
  h.scripts[0].onload();
  await sleep(50);
  eq('and reconnects', h.win._connectedAddress, ADDR);
}

{
  // The load-failure invariant. connectWithWallet()'s silent path wipes the saved
  // wallet on /not found|not available|unavailable/, so a flaky network dropping
  // one script fetch must NOT report itself that way — else a single bad load
  // logs the user out for good.
  const h = harness({ hangSilent: false });
  h.setSaved('walletconnect');
  h.win.walletInit({ appName: 't', onConnect: [], onDisconnect: [] });
  await sleep(120);
  h.scripts[0].onerror();
  await sleep(50);
  eq('a failed fetch keeps the saved wallet', h.store['zfi_wallet'], 'walletconnect');
  eq('and connects nothing', h.win._connectedAddress, null);

  // ...and it is retryable: the next attempt fetches again rather than replaying
  // the rejection it already cached.
  const retry = h.win.__WALLET_TEST_API__.connectWithWallet('walletconnect');
  await sleep(20);
  eq('a failed fetch is retried, not cached', h.scripts.length, 2);
  installWcBundle(h.win);
  h.scripts[1].onload();
  await retry;
  eq('the retry connects', h.win._connectedAddress, ADDR);
}

{
  // A bundle that loads but exports nothing IS permanent — that one keeps the old
  // "not available" wording, and so still clears the dead saved wallet.
  const h = harness({ hangSilent: false });
  h.setSaved('walletconnect');
  h.win.walletInit({ appName: 't', onConnect: [], onDisconnect: [] });
  await sleep(120);
  h.scripts[0].onload();                             // no global installed
  await sleep(50);
  eq('a bundle that exports nothing clears the saved wallet', h.store['zfi_wallet'], undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
