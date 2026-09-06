(function() {
'use strict';

// CORS-enabled, browser-tolerant public endpoints (kept in sync with index.html's
// RPC_ENDPOINTS). 1rpc.io and llamarpc were dropped: they CORS-block / rate-limit
// the wei.domains origin in production.
const RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://cloudflare-eth.com',
  'https://eth.drpc.org',
  'https://eth.merkle.io',
  'https://mainnet.gateway.tenderly.co',
  'https://eth-mainnet.public.blastapi.io'
];
const WEINS = '0x0000000000696760E15f265e828DB644A0c242EB';
const WEINS_ABI = ['function reverseResolve(address) view returns (string)'];
const WC_PROJECT_ID = '1e8390ef1c1d8a185e035912a1409749';

const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function _esc(s) { return String(s).replace(/[&<>]/g, m => _escMap[m]); }
function _escA(s) { return _esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

// --- State ---
window._walletProvider = null;
window._signer = null;
window._connectedAddress = null;
window._isWalletConnect = false;
window._wcDeepLink = null;
window._walletSendCalls = false; // ERC-5792 wallet_sendCalls support
window.eip6963Providers = new Map();

window._connectedWalletProvider = null;
let _walletConnectProvider = null;
let _isConnecting = false;
let _silentConnecting = false; // the in-flight attempt is a silent auto-connect
let _connectSeq = 0;           // invalidates a superseded (abandoned) attempt

// Bound a wallet RPC that has no business hanging. Only ever applied to the
// SILENT auto-connect path: a user-initiated connect legitimately blocks for as
// long as the person takes to approve (or to scan a WalletConnect QR), so it
// must never be raced against a clock.
function _withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error((label || 'wallet') + ' timed out')), ms); })
  ]);
}
let _walletEventHandlers = null;
let _onConnectCallbacks = [];
let _onDisconnectCallbacks = [];
let _appName = 'zFi';

// --- EIP-6963 ---
window.addEventListener('eip6963:announceProvider', (event) => {
  try {
    const { info, provider } = event.detail || {};
    if (info?.uuid && provider) eip6963Providers.set(info.uuid, { info, provider });
  } catch (e) {}
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

// --- Provider detection ---
function findProvider(checkFn) {
  if (window.ethereum?.providers?.length) {
    for (const p of window.ethereum.providers) { if (checkFn(p)) return p; }
  }
  if (window.ethereum && checkFn(window.ethereum)) return window.ethereum;
  return null;
}

const WALLET_CONFIG = {
  metamask: { name: 'MetaMask', icon: '🦊', detect: () => findProvider(p => p.isMetaMask), getProvider: () => findProvider(p => p.isMetaMask) },
  coinbase: { name: 'Coinbase', icon: '🔵', detect: () => findProvider(p => p.isCoinbaseWallet), getProvider: () => findProvider(p => p.isCoinbaseWallet) },
  rabby: { name: 'Rabby', icon: '🐰', detect: () => findProvider(p => p.isRabby), getProvider: () => findProvider(p => p.isRabby) },
  rainbow: { name: 'Rainbow', icon: '🌈', detect: () => findProvider(p => p.isRainbow), getProvider: () => findProvider(p => p.isRainbow) },
  walletconnect: { name: 'WalletConnect', icon: '📱' }
};

// WalletConnect's UMD bundle is ~624 KB and is only ever needed by the people
// who actually pick it (or who are restoring a saved WC session), so it is no
// longer a <script> in index.html — it is fetched here, on demand. The modal
// warms it on hover/press of the WalletConnect row, so by the time the click
// lands it is usually already in memory.
const WC_BUNDLE = 'vendor/walletconnect.min.js'; // document-relative, as the old tag was
let _wcLoad = null;
function loadWalletConnect() {
  const loaded = () => globalThis['@walletconnect/ethereum-provider'];
  if (loaded()) return Promise.resolve(loaded());
  if (_wcLoad) return _wcLoad;
  _wcLoad = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = WC_BUNDLE;
    el.async = true;
    // A network failure must stay RETRYABLE: connectWithWallet()'s silent path
    // wipes the saved wallet on /not found|not available|unavailable/, and a
    // one-off failed fetch is no reason to forget the user's wallet. Only the
    // bundle loading but exporting nothing is a permanent "not available".
    el.onload = () => loaded() ? resolve(loaded()) : reject(new Error('WalletConnect not available'));
    el.onerror = () => { _wcLoad = null; reject(new Error('WalletConnect script load failed')); };
    document.head.appendChild(el);
  });
  return _wcLoad;
}
function warmWalletConnect() { try { loadWalletConnect().catch(() => {}); } catch (e) {} }

function detectWallets() {
  const detected = [];
  const seenNames = new Set();
  for (const [uuid, { info, provider }] of eip6963Providers.entries()) {
    const name = info?.name || 'Unknown';
    if (!seenNames.has(name.toLowerCase())) {
      const iconUrl = info.icon && (info.icon.startsWith('data:image/') || info.icon.startsWith('https://')) ? info.icon : null;
      const safeIconUrl = iconUrl ? iconUrl.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])) : null;
      detected.push({ key: `eip6963_${uuid}`, name, icon: safeIconUrl ? `<img src="${safeIconUrl}" style="width:1.5rem;height:1.5rem;border-radius:4px;">` : '🔌', getProvider: () => provider });
      seenNames.add(name.toLowerCase());
    }
  }
  if (window.ethereum?.providers?.length) {
    for (let i = 0; i < window.ethereum.providers.length; i++) {
      const p = window.ethereum.providers[i];
      const name = p.isMetaMask ? 'MetaMask' : p.isCoinbaseWallet ? 'Coinbase' : p.isRabby ? 'Rabby' : p.isRainbow ? 'Rainbow' : null;
      if (name && !seenNames.has(name.toLowerCase())) { detected.push({ key: `provider_${i}`, name, icon: '🔗', getProvider: () => p }); seenNames.add(name.toLowerCase()); }
    }
  }
  for (const [key, config] of Object.entries(WALLET_CONFIG)) {
    if (key === 'walletconnect') continue;
    try { if (config.detect && config.detect() && !seenNames.has(config.name.toLowerCase())) { detected.push({ key, ...config }); seenNames.add(config.name.toLowerCase()); } } catch (e) {}
  }
  if (detected.length === 0 && window.ethereum) detected.push({ key: 'injected', name: 'Browser Wallet', icon: '🔗', getProvider: () => window.ethereum });
  // Always offered: WalletConnect needs nothing installed to be usable, which is
  // the whole point of it. (The old gate on the global was equivalent — the
  // bundle was loaded eagerly on every page, so it was always truthy here.)
  detected.push({ key: 'walletconnect', name: 'WalletConnect', icon: '📱' });
  return detected;
}

// --- DOM injection ---
function injectWalletDOM() {
  if (document.getElementById('walletBtn')) return;
  // Button
  const walletDiv = document.createElement('div');
  walletDiv.className = 'wallet';
  walletDiv.innerHTML = '<button id="walletBtn" onclick="toggleWallet()">connect</button>';
  document.body.appendChild(walletDiv);
  // Modal
  const overlay = document.createElement('div');
  overlay.className = 'wallet-modal-overlay';
  overlay.id = 'walletModal';
  overlay.onclick = function(e) { if (e.target === this) closeWalletModal(); };
  overlay.innerHTML = '<div class="wallet-modal"><div class="wallet-modal-header"><div class="wallet-modal-title">Connect Wallet</div><button class="wallet-modal-close" onclick="closeWalletModal()">&times;</button></div><div class="wallet-modal-body" id="walletOptions"></div></div>';
  document.body.appendChild(overlay);
}

// --- Modal ---
function showWalletModal() {
  document.getElementById('walletModal').classList.add('active');
  document.body.classList.add('modal-open');
  document.getElementById('walletOptions').innerHTML = '<div style="padding:12px;text-align:center;">Detecting wallets...</div>';
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const doDetect = (attempt = 1) => {
    const wallets = detectWallets();
    if (!wallets.some(w => w.key !== 'walletconnect') && attempt < 2) setTimeout(() => doDetect(attempt + 1), 250);
    else renderWalletModal(wallets);
  };
  setTimeout(() => doDetect(), 150);
}

function renderWalletModal(wallets) {
  const container = document.getElementById('walletOptions');
  if (_connectedAddress) {
    const displayName = document.getElementById('walletBtn').textContent;
    const showName = displayName && displayName !== 'connect' && !displayName.startsWith('0x');
    container.innerHTML = `<div style="padding:12px;border:1px solid currentColor;margin-bottom:12px;"><div style="font-weight:600;margin-bottom:6px;">Connected</div>${showName ? `<div style="font-size:16px;margin-bottom:4px;">${_esc(displayName)}</div>` : ''}<div style="font-size:12px;word-break:break-all;opacity:0.6;">${_esc(_connectedAddress)}</div></div><div class="wallet-option disconnect" onclick="disconnectWallet()"><span class="wallet-option-name">Disconnect</span></div>`;
  } else {
    container.innerHTML = wallets.length > 0 ? wallets.map(w => `<div class="wallet-option" data-wallet-key="${_escA(w.key)}"><span class="wallet-option-icon">${w.icon}</span><span class="wallet-option-name">${_esc(w.name)}</span></div>`).join('') : '<div style="padding:12px;text-align:center;">No wallets detected.</div>';
    container.querySelectorAll('[data-wallet-key]').forEach(el => {
      el.addEventListener('click', () => connectWithWallet(el.dataset.walletKey));
      // Prefetch on intent rather than on modal-open, so picking MetaMask never
      // pays for a bundle it will not use.
      if (el.dataset.walletKey === 'walletconnect') {
        el.addEventListener('pointerenter', warmWalletConnect, { once: true });
        el.addEventListener('pointerdown', warmWalletConnect, { once: true });
      }
    });
  }
}

window.closeWalletModal = function() {
  document.getElementById('walletModal').classList.remove('active');
  document.body.classList.remove('modal-open');
};

window.toggleWallet = function() { showWalletModal(); };
window.showWalletModal = showWalletModal;

function readWalletConnectRedirect(metadata) {
  try {
    if (metadata?.redirect?.native && /^https?:\/\//i.test(metadata.redirect.native)) return metadata.redirect.native;
    if (metadata?.redirect?.universal && /^https?:\/\//i.test(metadata.redirect.universal)) return metadata.redirect.universal;
  } catch (e) {}
  return null;
}

// --- Connect ---
async function connectWithWallet(walletKey, options = {}) {
  const silent = !!options.silent;
  // Never let an in-flight auto-connect block the user. _isConnecting used to be
  // an unconditional gate, so a silent attempt that hung — WalletConnect's
  // enable() with no session to restore never settles, and a wallet that stops
  // answering eth_accounts/eth_chainId does the same — latched it true forever.
  // From then on every click on a wallet in the modal returned here immediately
  // and did nothing, while the optimistic label left the corner reading
  // "connected". Result: connected-looking UI, _connectedAddress still null, and
  // names the user owns rendering "Connect as owner to manage".
  // A manual connect now supersedes a silent one; only a manual attempt blocks.
  if (_isConnecting && (silent || !_silentConnecting)) return;
  // A silent auto-connect must never override a wallet the user connected
  // manually while we were waiting for the saved provider to announce.
  if (silent && _connectedAddress) return;
  const seq = ++_connectSeq;
  const superseded = () => seq !== _connectSeq;
  _isConnecting = true;
  _silentConnecting = silent;
  try {
    closeWalletModal();
    let walletProvider;
    if (walletKey === 'walletconnect') {
      // The modal is already closed by here, so a cold fetch of the 624 KB bundle
      // would otherwise be a few silent seconds of "did my click register?".
      if (!silent && !globalThis['@walletconnect/ethereum-provider'] && typeof showStatus === 'function') {
        showStatus('Loading WalletConnect…', '');
      }
      // Usually already resolved (warmed on hover/press in the modal). The silent
      // restore gets a clock for the same reason every other silent step does:
      // nothing on the auto-connect path may hang _isConnecting forever.
      const wcModule = await (silent
        ? _withTimeout(loadWalletConnect(), 15000, 'walletconnect script')
        : loadWalletConnect());
      const WCProvider = wcModule?.EthereumProvider;
      if (!WCProvider?.init) throw new Error('WalletConnect not available');
      if (_walletConnectProvider) { try { await _walletConnectProvider.disconnect?.(); } catch (e) {} _walletConnectProvider = null; }
      _walletConnectProvider = await WCProvider.init({ projectId: WC_PROJECT_ID, chains: [1], showQrModal: !silent, rpcMap: { 1: 'https://ethereum-rpc.publicnode.com' }, metadata: { name: _appName, description: _appName, url: window.location.origin, icons: [] } });
      if (!silent) _walletConnectProvider.on('display_uri', () => { _wcDeepLink = readWalletConnectRedirect(_walletConnectProvider.session?.peer?.metadata); });
      // WalletConnect v2 emits 'disconnect'/'session_delete' when the session is
      // ended from the wallet side or expires — it does NOT emit accountsChanged:[]
      // then, so without this the dapp lingers in a ghost-connected state. The
      // guard makes it a no-op after a manual disconnect (which already cleared
      // _isWalletConnect), so _onDisconnectCallbacks never double-fire.
      const _wcEnd = () => { if (_isWalletConnect && _connectedAddress) { try { window.disconnectWallet(); } catch (e) {} } };
      _walletConnectProvider.on('disconnect', _wcEnd);
      _walletConnectProvider.on('session_delete', _wcEnd);
      // enable() never settles when there is no session to restore, so the silent
      // path must not await it bare (see the _isConnecting note above).
      if (silent) await _withTimeout(_walletConnectProvider.enable(), 10000, 'walletconnect');
      else await _walletConnectProvider.enable();
      walletProvider = _walletConnectProvider;
      _isWalletConnect = true;
      _wcDeepLink = readWalletConnectRedirect(_walletConnectProvider.session?.peer?.metadata);
    } else if (walletKey.startsWith('eip6963_')) {
      const uuid = walletKey.replace('eip6963_', '');
      walletProvider = eip6963Providers.get(uuid)?.provider;
      if (!walletProvider) {
        // UUID changed (new page load) — fall back to matching by wallet name
        const savedName = localStorage.getItem('zfi_wallet_name')?.toLowerCase();
        if (savedName) {
          for (const [newUuid, { info, provider }] of eip6963Providers) {
            if (info?.name?.toLowerCase() === savedName) {
              walletProvider = provider;
              // Update walletKey so localStorage gets the current UUID
              walletKey = `eip6963_${newUuid}`;
              break;
            }
          }
        }
      }
      _isWalletConnect = false; _wcDeepLink = null;
    } else if (walletKey.startsWith('provider_')) {
      // Legacy window.ethereum.providers[] entry. Resolve by saved name first
      // (index can shift between loads); fall back to index, then window.ethereum.
      const list = (window.ethereum && window.ethereum.providers) || [];
      const nameOf = (p) => p.isMetaMask ? 'metamask' : p.isCoinbaseWallet ? 'coinbase' : p.isRabby ? 'rabby' : p.isRainbow ? 'rainbow' : null;
      const savedName = (localStorage.getItem('zfi_wallet_name') || '').toLowerCase();
      if (savedName) walletProvider = list.find(p => nameOf(p) === savedName);
      if (!walletProvider) walletProvider = list[parseInt(walletKey.slice(9), 10)];
      walletProvider = walletProvider || window.ethereum;
      _isWalletConnect = false; _wcDeepLink = null;
    } else {
      walletProvider = WALLET_CONFIG[walletKey]?.getProvider() || window.ethereum;
      _isWalletConnect = false; _wcDeepLink = null;
    }
    if (!walletProvider) throw new Error('Wallet not found');
    if (walletKey !== 'walletconnect') {
      if (silent) {
        // Silent reconnect: use the non-prompting eth_accounts. If the wallet
        // hasn't already authorized this origin, this returns []; aborting here
        // avoids MetaMask's native "connect to this site?" popup firing on
        // every page load from stale localStorage state.
        const accounts = await _withTimeout(walletProvider.request({ method: 'eth_accounts' }), 8000, 'eth_accounts').catch(() => []);
        if (!accounts || accounts.length === 0) throw new Error('not authorized');
      } else {
        await walletProvider.request({ method: 'eth_requestAccounts' });
      }
    }
    const chainId = silent
      ? await _withTimeout(walletProvider.request({ method: 'eth_chainId' }), 8000, 'eth_chainId')
      : await walletProvider.request({ method: 'eth_chainId' });
    if (BigInt(chainId) !== 1n) {
      // A silent auto-connect must not pop a wallet chain-switch dialog on page
      // load — that defeats the whole point of the no-prompt reconnect. Abort
      // quietly and let the user connect manually (which does prompt).
      if (silent) throw new Error('wrong chain');
      try { await walletProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }); const nc = await walletProvider.request({ method: 'eth_chainId' }); if (BigInt(nc) !== 1n) throw new Error('Chain switch failed'); }
      catch (switchErr) { console.error('Chain switch failed:', switchErr); const wb = document.getElementById('walletBtn'); wb.textContent = 'connect'; wb.classList.remove('connected'); wb.classList.remove('reconnecting'); if (typeof showStatus === 'function') showStatus('Please switch to Ethereum mainnet in your wallet.', 'error'); if (walletKey === 'walletconnect') { try { Promise.resolve(_walletConnectProvider?.disconnect()).catch(() => {}); } catch (e) {} _walletConnectProvider = null; } _isWalletConnect = false; _wcDeepLink = null; return; }
    }
    const bp = new ethers.BrowserProvider(walletProvider);
    const sg = silent ? await _withTimeout(bp.getSigner(), 8000, 'getSigner') : await bp.getSigner();
    const addr = silent ? await _withTimeout(sg.getAddress(), 8000, 'getAddress') : await sg.getAddress();
    // A manual connect started while this silent one was still resolving owns the
    // wallet state now — drop this result rather than overwriting theirs.
    if (superseded()) return;
    _walletProvider = bp;
    _signer = sg;
    _connectedAddress = addr;
    const oldWP = _connectedWalletProvider;
    _connectedWalletProvider = walletProvider;
    setWalletLabel(_connectedAddress);
    document.getElementById('walletBtn').classList.remove('reconnecting');
    document.getElementById('walletBtn').classList.add('connected');
    resolveWeiName(_connectedAddress);
    updateWcBanner();
    // ERC-5792: probe wallet_sendCalls support (non-blocking, no delay to connect)
    _walletSendCalls = false;
    walletProvider.request({ method: 'wallet_getCapabilities', params: [_connectedAddress] }).then(caps => {
      if (caps) { const c = caps['0x1']; if (c?.atomicBatch?.supported || c?.['atomic-batch']?.supported || c?.atomic?.status === 'supported' || c?.atomic?.status === 'ready') _walletSendCalls = true; }
    }).catch(() => {});
    if (oldWP && _walletEventHandlers) { try { oldWP.removeListener('accountsChanged', _walletEventHandlers.accountsChanged); oldWP.removeListener('chainChanged', _walletEventHandlers.chainChanged); } catch (e) {} }
    _walletEventHandlers = {
      accountsChanged: (accts) => {
        if (!accts || accts.length === 0) {
          // Some wallets emit empty accounts transiently during page transitions.
          // Wait briefly and re-check before disconnecting.
          setTimeout(async () => {
            try {
              const recheck = await _connectedWalletProvider?.request({ method: 'eth_accounts' });
              if (!recheck || recheck.length === 0) window.disconnectWallet();
            } catch { window.disconnectWallet(); }
          }, 500);
          return;
        }
        // Clear previous session state (PP keys, loaded notes, proof workers)
        // before re-deriving, so the old account's data is never accessible.
        for (const fn of _onDisconnectCallbacks) { try { fn(); } catch (e) { console.error('onDisconnect callback error:', e); } }
        // Re-derive signer/address from the new account without a full reload
        (async () => {
          try {
            _walletProvider = new ethers.BrowserProvider(_connectedWalletProvider);
            _signer = await _walletProvider.getSigner();
            _connectedAddress = await _signer.getAddress();
            setWalletLabel(_connectedAddress);
            resolveWeiName(_connectedAddress);
            for (const fn of _onConnectCallbacks) { try { fn(); } catch (e) { console.error('onConnect callback error:', e); } }
          } catch (e) { console.error('Account change re-derive failed, reloading:', e); window.location.reload(); }
        })();
      },
      chainChanged: (chainId) => {
        try {
          if (BigInt(chainId) !== 1n) {
            window.disconnectWallet();
            if (typeof showStatus === 'function') showStatus('Switched to an unsupported chain. Please reconnect on Ethereum mainnet.', 'error');
          }
        } catch {}
      },
    };
    walletProvider.on('accountsChanged', _walletEventHandlers.accountsChanged);
    walletProvider.on('chainChanged', _walletEventHandlers.chainChanged);
    try {
      localStorage.setItem('zfi_wallet', walletKey);
      if (walletKey === 'walletconnect') {
        const name = _walletConnectProvider?.session?.peer?.metadata?.name;
        if (name) localStorage.setItem('zfi_wallet_name', name);
        else localStorage.removeItem('zfi_wallet_name');
      } else if (walletKey.startsWith('eip6963_')) {
        const uuid = walletKey.replace('eip6963_', '');
        const name = eip6963Providers.get(uuid)?.info?.name;
        if (name) localStorage.setItem('zfi_wallet_name', name);
        else localStorage.removeItem('zfi_wallet_name');
      } else if (walletKey.startsWith('provider_')) {
        const p = ((window.ethereum && window.ethereum.providers) || [])[parseInt(walletKey.slice(9), 10)];
        const name = p && (p.isMetaMask ? 'MetaMask' : p.isCoinbaseWallet ? 'Coinbase' : p.isRabby ? 'Rabby' : p.isRainbow ? 'Rainbow' : null);
        if (name) localStorage.setItem('zfi_wallet_name', name);
        else localStorage.removeItem('zfi_wallet_name');
      } else {
        localStorage.removeItem('zfi_wallet_name');
      }
    } catch (e) {}
    for (const fn of _onConnectCallbacks) { try { fn(); } catch (e) { console.error('onConnect callback error:', e); } }
  } catch (error) {
    if (silent) console.warn('Auto-connect failed:', error?.message || error);
    else console.error('Wallet connect error:', error);
    // Reset the button fully (an auto-connect may have optimistically shown the
    // last account's cached .wei name + connected styling before failing).
    // Don't reset the button on behalf of a superseded silent attempt — the
    // manual connect that replaced it may already have painted a live wallet.
    if (!superseded() && !_connectedAddress) {
      const wb = document.getElementById('walletBtn');
      wb.textContent = 'connect';
      wb.classList.remove('connected');
      wb.classList.remove('reconnecting');
    }
    if (silent) {
      // Auto-connect failed silently — clean up WC provider if applicable
      if (_walletConnectProvider) { try { Promise.resolve(_walletConnectProvider.disconnect()).catch(() => {}); } catch (_) {} _walletConnectProvider = null; }
      // A WC auto-connect sets _isWalletConnect before enable() resolves; leaving
      // it true after a failed/timed-out restore makes wcTransaction() deep-link
      // into a wallet app that was never connected.
      if (!_connectedAddress) { _isWalletConnect = false; _wcDeepLink = null; updateWcBanner(); }
      // Only clear saved wallet for permanent failures (wallet not found),
      // not transient ones (provider not ready, RPC timeout)
      const errMsg = error?.message || '';
      if (/not found|not available|unavailable/i.test(errMsg)) {
        try { localStorage.removeItem('zfi_wallet'); localStorage.removeItem('zfi_wallet_name'); } catch (_) {}
      }
    } else {
      const msg = error?.message || '';
      if (/user rejected|user denied|user cancelled/i.test(msg)) {
        if (typeof showStatus === 'function') showStatus('Wallet connection cancelled.', 'error');
      } else if (typeof showStatus === 'function') {
        showStatus('Wallet connection failed. Please try again.', 'error');
      }
    }
  } finally {
    // Only the newest attempt owns the flag; a superseded silent one must not
    // clear it out from under the manual connect that replaced it.
    if (!superseded()) { _isConnecting = false; _silentConnecting = false; }
  }
}

window.disconnectWallet = function() {
  if (_connectedWalletProvider && _walletEventHandlers) { try { _connectedWalletProvider.removeListener('accountsChanged', _walletEventHandlers.accountsChanged); _connectedWalletProvider.removeListener('chainChanged', _walletEventHandlers.chainChanged); } catch (e) {} }
  _walletEventHandlers = null;
  if (_walletConnectProvider) { try { Promise.resolve(_walletConnectProvider.disconnect()).catch(() => {}); } catch (e) {} _walletConnectProvider = null; }
  _walletProvider = null; _signer = null; _connectedAddress = null; _connectedWalletProvider = null; _isWalletConnect = false; _wcDeepLink = null; _walletSendCalls = false;
  document.getElementById('walletBtn').textContent = 'connect';
  document.getElementById('walletBtn').classList.remove('connected');
  document.getElementById('walletBtn').classList.remove('reconnecting');
  updateWcBanner();
  closeWalletModal();
  try { localStorage.removeItem('zfi_wallet'); localStorage.removeItem('zfi_wallet_name'); } catch (e) {}
  for (const fn of _onDisconnectCallbacks) { try { fn(); } catch (e) { console.error('onDisconnect callback error:', e); } }
};

window.connectWallet = async function() {
  if (_signer) return _signer;
  showWalletModal();
  return null;
};

let _rpcProvider = null;
function getRpcProvider() {
  if (_rpcProvider) return _rpcProvider;
  // Honor the same custom-RPC override the main app supports (?rpc= / wns_rpc) and
  // fail over across the public endpoints, so a single throttled node (publicnode is
  // the most rate-limited) can't silently break reverse resolution of the display name.
  let urls = RPCS;
  try {
    const custom = [];
    const q = new URLSearchParams(location.search).get('rpc');
    if (q) custom.push(...q.split(','));
    const ls = localStorage.getItem('wns_rpc');
    if (ls) custom.push(...ls.split(','));
    const cleaned = custom.map(s => s.trim()).filter(u => /^https?:\/\//i.test(u));
    if (cleaned.length) urls = cleaned;
  } catch (e) {}
  try {
    if (urls.length === 1) {
      _rpcProvider = new ethers.JsonRpcProvider(urls[0], 1, { staticNetwork: true });
    } else {
      // quorum:1 is load-bearing: one healthy endpoint is enough (the default
      // quorum of 2 would stall when only a single node is reachable).
      _rpcProvider = new ethers.FallbackProvider(
        urls.map(u => ({ provider: new ethers.JsonRpcProvider(u, 1, { staticNetwork: true }), stallTimeout: 2000, weight: 1 })),
        1,
        { quorum: 1 }
      );
    }
  } catch (e) {
    // Fall back to the first endpoint if FallbackProvider isn't available.
    _rpcProvider = new ethers.JsonRpcProvider(urls[0], 1, { staticNetwork: true });
  }
  return _rpcProvider;
}

function _shortAddr(addr) { return addr.slice(0, 6) + '...' + addr.slice(-4); }
function _cachedWeiName(addr) { try { return localStorage.getItem('wns_rev:' + addr.toLowerCase()) || null; } catch (_) { return null; } }
function _cacheWeiName(addr, name) {
  try {
    if (name) localStorage.setItem('wns_rev:' + addr.toLowerCase(), name);
    else localStorage.removeItem('wns_rev:' + addr.toLowerCase());
  } catch (_) {}
}

// Paint the wallet label immediately, preferring a cached reverse name so a
// returning user never sees their address flash to their .wei name.
function setWalletLabel(addr) {
  const btn = document.getElementById('walletBtn');
  if (!btn) return;
  try { localStorage.setItem('wns_last', addr.toLowerCase()); } catch (_) {}
  btn.textContent = _cachedWeiName(addr) || _shortAddr(addr);
}
window.setWalletLabel = setWalletLabel;

let _resolveSeq = 0;

// Paint the corner label from what the chain says the address reverse-resolves to.
//
// Called bare (on connect / account switch) this is a single read, as it always was.
// `opts.minBlock` and `opts.expect` are for the read-after-write case, which used to
// undo itself: waitForTx() gets its receipt from tx.wait(), i.e. the WALLET's own
// node, while this reads over the public endpoints through a different provider
// entirely. Asking them the instant a setPrimaryName receipt lands routinely returns
// the PRE-tx answer — and the old code took it at face value, writing that stale name
// into the wns_rev cache and painting it. So the corner flipped from the name the user
// had just set back to a bare 0x… address, nothing re-polled, and it stayed wrong
// until the next page load re-resolved it.
//
// minBlock waits for this provider to reach the block the tx landed in; expect keeps
// asking until the chain actually agrees. The last attempt accepts whatever it gets,
// so a name that legitimately does NOT reverse-resolve still settles correctly —
// setPrimaryName only needs ownership, but reverseResolve also requires resolve() to
// point back at you, so an owner who set the record elsewhere really does get "".
function resolveWeiName(addr, opts) {
  // expect: '' is a real expectation ("no name"), as unsetting the display name
  // wants — so test it against null, not for truthiness.
  const expect = opts && opts.expect != null ? String(opts.expect).toLowerCase() : null;
  const minBlock = Number(opts && opts.minBlock) || 0;
  const tries = (opts && opts.tries) || ((expect !== null || minBlock) ? 10 : 1);
  const delayMs = (opts && opts.delayMs) || 1200;
  const seq = ++_resolveSeq;
  const live = () => seq === _resolveSeq && _connectedAddress === addr;

  const paint = (label) => {
    const btn = document.getElementById('walletBtn');
    if (!btn) return;
    _cacheWeiName(addr, label);
    const target = label || _shortAddr(addr);
    if (btn.textContent === target) return; // already correct (e.g. from cache) — no flash
    // Gentle cross-fade only when the visible label actually changes.
    btn.style.opacity = '0';
    setTimeout(() => {
      if (!live()) return;
      btn.textContent = target;
      btn.style.opacity = '';
    }, 130);
  };

  (async () => {
    let p, ns;
    try { p = getRpcProvider(); ns = new ethers.Contract(WEINS, WEINS_ABI, p); } catch (e) { return; }

    for (let i = 0; i < tries; i++) {
      if (i) await new Promise(r => setTimeout(r, delayMs));
      if (!live()) return;
      const last = i === tries - 1;

      // Skip the read while the node is provably behind the tx — but never on the
      // last attempt, so a stuck or unreadable height can't starve it entirely.
      if (minBlock && !last) {
        let height = minBlock;
        try { height = await p.getBlockNumber(); } catch (_) {}
        if (!live()) return;
        if (height < minBlock) continue;
      }

      let label;
      try { label = ((await ns.reverseResolve(addr)) || '').toLowerCase(); }
      catch (_) { continue; }
      if (!live()) return;
      // Still the pre-tx answer: don't cache it, don't paint it, just ask again.
      if (expect !== null && label !== expect && !last) continue;
      paint(label);
      return;
    }
  })();
}
window.resolveWeiName = resolveWeiName;

function updateWcBanner() {
  const existing = document.getElementById('wcBanner');
  if (existing) existing.remove();
  if (_isWalletConnect && _connectedAddress) {
    const banner = document.createElement('div');
    banner.id = 'wcBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#1a1a2e;color:#fff;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;z-index:9000;font-size:13px;';
    banner.innerHTML = '<span>📱 Connected via WalletConnect</span><button onclick="disconnectWallet()" style="background:#fff;color:#000;border:none;padding:6px 12px;border-radius:0;cursor:pointer;font-size:12px;">Disconnect</button>';
    document.body.prepend(banner);
    document.body.style.paddingTop = '54px';
  } else {
    document.body.style.paddingTop = '';
  }
}
window.updateWcBanner = updateWcBanner;

let _autoConnectRan = false;
async function tryAutoConnect() {
  if (_autoConnectRan) return;
  _autoConnectRan = true;
  const savedWallet = localStorage.getItem('zfi_wallet');
  if (!savedWallet) return;
  const btn = document.getElementById('walletBtn');
  if (btn && !_connectedAddress) {
    // Optimistically show the last account's cached .wei name while we reconnect,
    // so a returning user sees it immediately on load instead of "..." → 0x → name.
    let last = null; try { last = localStorage.getItem('wns_last'); } catch (_) {}
    const cached = last && _cachedWeiName(last);
    btn.textContent = cached || '...';
    if (cached) btn.classList.add('reconnecting');
  }
  setTimeout(async () => {
    try {
      if (_isConnecting || _connectedAddress) return;
      // For EIP-6963 wallets, wait for the provider to announce
      if (savedWallet.startsWith('eip6963_')) {
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        const savedName = localStorage.getItem('zfi_wallet_name')?.toLowerCase();
        await new Promise(resolve => {
          const check = () => {
            const uuid = savedWallet.replace('eip6963_', '');
            if (eip6963Providers.has(uuid)) return true;
            if (savedName) { for (const [, { info }] of eip6963Providers) { if (info?.name?.toLowerCase() === savedName) return true; } }
            return false;
          };
          if (check()) { resolve(); return; }
          const handler = () => { if (check()) { window.removeEventListener('eip6963:announceProvider', handler); resolve(); } };
          window.addEventListener('eip6963:announceProvider', handler);
          setTimeout(() => { window.removeEventListener('eip6963:announceProvider', handler); resolve(); }, 2000);
        });
      }
      // Connect directly — eth_requestAccounts won't prompt if site is already authorized
      await connectWithWallet(savedWallet, { silent: true });
    } catch (e) {
    } finally {
      // The optimistic paint above can leave the button showing the last account's
      // .wei name in "connected" styling even though nothing connected — every
      // connectWithWallet() bail-out that returns early (already connecting, no
      // provider) skips its own reset. A button that claims to be connected while
      // _connectedAddress is null makes the whole app look broken: names the user
      // owns render "Connect as owner to manage" with no way to tell why.
      if (btn && !_connectedAddress && !_isConnecting) { btn.textContent = 'connect'; btn.classList.remove('connected'); btn.classList.remove('reconnecting'); }
    }
  }, 50);
}

// __WALLET_TEST_API__ is a gated test-only seam for PP wallet tests.
// Runtime behavior must never depend on it.
if (globalThis.__WALLET_ENABLE_TEST_API__ === true) {
  globalThis.__WALLET_TEST_API__ = Object.freeze({
    connectWithWallet,
  });
}

// --- Public init ---
window.walletInit = function(opts) {
  _appName = opts.appName || 'zFi';
  _onConnectCallbacks = Array.isArray(opts.onConnect) ? opts.onConnect : (opts.onConnect ? [opts.onConnect] : []);
  _onDisconnectCallbacks = Array.isArray(opts.onDisconnect) ? opts.onDisconnect : (opts.onDisconnect ? [opts.onDisconnect] : []);
  injectWalletDOM();
  tryAutoConnect();
};

})();
