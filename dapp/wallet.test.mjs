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

function harness({ hangSilent }) {
  const els = new Map();
  for (const id of ['walletBtn', 'walletModal', 'walletOptions']) els.set(id, makeEl(id));
  const body = makeEl('body');
  const document = {
    body,
    getElementById: id => els.get(id) || null,
    createElement: () => {
      const el = makeEl(null);
      // injectWalletDOM writes innerHTML containing #walletBtn; it's already in els.
      return el;
    },
  };

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

  const fakeEthers = {
    ...ethers,
    BrowserProvider: class { async getSigner() { return { getAddress: async () => ADDR }; } },
    Contract: class { async reverseResolve() { return ''; } },
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
  return { ctx, win, els, store, setSaved: k => { store['zfi_wallet'] = k; } };
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
