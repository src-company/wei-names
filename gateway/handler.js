// Core wildcard gateway: <label>.wei.limo / <label>.wei.is  ->  IPFS of <label>.wei.
//
// This is the whole automation. There is NO per-name DNS provisioning: a single
// `*.wei.limo` wildcard record points every undefined subdomain here, and this
// handler does the on-chain lookup at request time. A newly registered `.wei`
// name works instantly with zero DNS writes; expired/unregistered names 404.
//
// Runtime-agnostic: takes a standard `Request`, returns a standard `Response`.
// Used by both worker.js (Cloudflare) and server.js (Node/Railway).

import { computeId, contenthashOf, resolveAddress, resolveMode, WEB3_MODES } from './wns.js'
import { decodeContenthash } from './contenthash.js'
import { fetchErc5219, fetchErc8244 } from './onchain.js'

// Zones this gateway serves. Comma-separated; a request to <label>.<zone>
// resolves the IPFS content of <label>.wei for ANY listed zone.
const ZONE = 'wei.limo,wei.is,wei.domains'

// Labels that must never be treated as `.wei` names.
//
// Currently EMPTY: every subdomain resolves as a `.wei` name on every zone.
// Real app subdomains (zfi.wei.is, multisig.wei.is, …) are protected solely by
// their explicit DNS records, which win over the `*` wildcard by specificity —
// so the gateway never even sees those hostnames.
//
// Trade-off: no defense-in-depth backstop. If such an explicit record is ever
// dropped, whoever owns the matching `.wei` name could serve content at that
// hostname. Re-add labels below (or via the RESERVED_LABELS env var) to restore
// it. RESERVED_ALL applies to every zone; RESERVED_BY_ZONE only to the named one.
const RESERVED_ALL = new Set([
  // e.g. 'www' — reserve a label on every served zone
])
const RESERVED_BY_ZONE = {
  // e.g. 'wei.is': ['zfi', 'multisig'] — reserve labels only on that zone
}

// Short in-memory cache of label -> { cid, at } to spare RPCs from repeat hits.
// Best-effort (per worker isolate / per Node process); not a correctness path.
// SECURITY: bounded so a flood of random `*.wei.limo` labels can't grow the map
// unbounded and OOM the instance. Oldest entries are evicted first.
const CACHE_TTL_MS = 60_000
const CACHE_MAX = 5_000
const cache = new Map()

function cacheSet(key, value) {
  // Evict the oldest entry when at capacity (Map preserves insertion order).
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

// `0x<40 hex>.<zone>` — serve that contract directly, skipping WNS entirely.
//
// This is a second, deliberately different surface from a name. A name points
// at whatever version is current and can be repointed; an address is a fixed
// set of bytes and cannot. A reader who audited a build keeps its address and
// keeps getting exactly those bytes, and no key — including the one that owns
// the name — can turn one surface into the other.
//
// It also costs nothing on the page side: a contract page that reads its own
// address out of the first hostname label (as the zSwap build does) can name
// its own version and link its successor without leaving this gateway.
const ADDRESS_LABEL = /^0x[0-9a-f]{40}$/

// Statuses HTTP forbids a body on. `Response` throws rather than truncating.
const NULL_BODY_STATUS = new Set([204, 205, 304])

function readEnv(env, key, fallback) {
  const v = env?.[key]
  return v === undefined || v === null || v === '' ? fallback : v
}

// Pull the WNS subdomain out of a Host header, for any served zone.
// `alice.wei.limo` -> { sub: 'alice.wei', zone: 'wei.limo' }.
// Returns null for a zone apex, or a host in none of the served zones.
function labelFromHost(host, zones) {
  if (!host) return null
  const h = host.toLowerCase().split(':')[0] // strip port
  for (const zone of zones) {
    const suffix = '.' + zone
    if (!h.endsWith(suffix)) continue
    const sub = h.slice(0, -suffix.length)
    if (!sub) return null // zone apex (e.g. `wei.limo`)
    return { sub, zone }
  }
  return null
}

// Classify an address the gateway has been pointed at, in the order the
// contracts assume (ERC-4804 mode first, ERC-8244 second, neither last):
//
//   1. resolveMode() == "5219"      -> read the page out of request()
//   2. resolveMode() == auto/manual -> a web3:// URL nobody here can build;
//                                      hand it to a web3:// HTTP gateway
//   3. html() answers               -> serve that string as a document
//   4. otherwise                    -> not a page; caller falls back
//
// Returns `{ resolved, prefetched }`. `prefetched` is the html() body we had to
// read to answer step 3 at all — carried to the caller so the same document
// isn't fetched twice on a cache miss. It is per-request only and is NEVER
// cached: bodies come from the contract on every request, so that the
// contract's own Cache-Control is the only thing deciding how long they live.
async function classifyContract(address, opts) {
  const mode = await resolveMode(address, opts)
  if (mode === '5219') return { resolved: { kind: 'contract', address, mode: '5219' } }
  if (WEB3_MODES.has(mode)) return { resolved: { kind: 'web3', address } }
  const page = await fetchErc8244(address, opts)
  if (page) return { resolved: { kind: 'contract', address, mode: 'html' }, prefetched: page }
  return { resolved: null }
}

// name (or address label) -> a servable target. Throws on RPC failure; the
// caller turns that into a 502 rather than anything cached.
async function resolveTarget(sub, opts) {
  if (ADDRESS_LABEL.test(sub)) return classifyContract(sub, opts)

  const tokenId = await computeId(sub, opts)
  if (tokenId === 0n) return { resolved: null }

  // Address record and contenthash in parallel (one round-trip); the contract
  // probes below only run when the name resolves to an address at all.
  const [address, contenthash] = await Promise.all([
    resolveAddress(tokenId, opts),
    contenthashOf(tokenId, opts),
  ])
  if (address) {
    const hit = await classifyContract(address, opts)
    if (hit.resolved) return hit
  }
  const content = decodeContenthash(contenthash)
  return { resolved: content ? { kind: content.ns, id: content.id } : null }
}

export async function handleRequest(request, env) {
  const url = new URL(request.url)
  const zones = String(readEnv(env, 'ZONE', ZONE)).split(',').map((s) => s.trim()).filter(Boolean)

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  // Lightweight health check for Railway/Render.
  if (url.pathname === '/healthz') {
    return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } })
  }

  const host =
    request.headers.get('x-forwarded-host') || request.headers.get('host') || url.hostname
  const match = labelFromHost(host, zones)
  if (!match) {
    // Apex or unexpected host — send people to the WNS site.
    return Response.redirect('https://wei.domains', 302)
  }
  const { sub, zone } = match

  const firstLabel = sub.split('.')[0]
  const reserved = new Set([
    ...RESERVED_ALL,
    ...(RESERVED_BY_ZONE[zone] || []),
    ...String(readEnv(env, 'RESERVED_LABELS', '')).split(',').map((s) => s.trim()).filter(Boolean),
  ])
  if (reserved.has(firstLabel)) {
    return new Response('Not Found', { status: 404 })
  }

  const rpc = String(readEnv(env, 'RPC_URLS', '')).split(',').map((s) => s.trim()).filter(Boolean)
  const contract = readEnv(env, 'WNS_CONTRACT', undefined)
  // Page reads pull whole documents over `eth_call`, so they get their own
  // (longer) budget than a registry lookup.
  const pageTimeoutMs = Number(readEnv(env, 'PAGE_TIMEOUT_MS', 0)) || undefined
  const opts = { rpc, contract, pageTimeoutMs }

  // Resolve label -> a servable target, with a short cache. Three kinds:
  //   { kind: 'contract', address, mode } — the contract IS the page. `5219`
  //       reads it from request() (path- and query-aware); `html` from html().
  //       The gateway writes the response itself: nothing is mirrored anywhere,
  //       so there is no copy to go stale and no third party in the path.
  //   { kind: 'web3', address }  — an ERC-4804 dapp in `auto`/`manual` mode,
  //       where serving means translating a URL into calldata. That's a
  //       web3:// job, so it goes to a web3:// HTTP gateway. Both take
  //       precedence over any IPFS contenthash the same name may also carry
  //       (which can only be an ERC-8244 loader, with no sub-paths).
  //   { kind: 'ipfs' | 'ipns', id } — a contenthash. For IPNS `id` is a stable
  //       key the gateway resolves fresh each request, so the owner can update
  //       the site with no new on-chain transaction.
  //
  // Only the CLASSIFICATION is cached, never a page body — see classifyContract.
  let resolved
  let prefetched
  const cached = cache.get(sub)
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) {
    resolved = cached.resolved
  } else {
    try {
      const hit = await resolveTarget(sub, opts)
      resolved = hit.resolved
      prefetched = hit.prefetched
    } catch (e) {
      return new Response('Upstream RPC error resolving ' + sub, {
        status: 502,
        headers: { 'cache-control': 'no-store' },
      })
    }
    cacheSet(sub, { resolved, at: now })
  }

  if (!resolved) {
    // Registered names without servable content, unregistered names, and
    // address labels that aren't a page.
    return new Response(
      ADDRESS_LABEL.test(sub)
        ? `${sub} is not an on-chain page: it answers neither ERC-4804 resolveMode() nor ERC-8244 html().\n`
        : `No on-chain dapp or IPFS/IPNS content set for ${sub}.\n` +
            `Set an addr (ERC-4804 contract) or a contenthash on this name at https://wei.domains to publish here.\n`,
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    )
  }

  // A contract page is read and written here — GATEWAY_MODE doesn't apply,
  // because there is no upstream to redirect to. Each `<label>.<zone>` is
  // already its own origin (see the Public Suffix List note in README.md).
  if (resolved.kind === 'contract') {
    let page
    try {
      page =
        prefetched ||
        (resolved.mode === '5219'
          ? await fetchErc5219(resolved.address, url.pathname, url.search, opts)
          : // ERC-8244 has no notion of a path: one document, served at every
            // path, which is the same shape as an SPA fallback.
            await fetchErc8244(resolved.address, opts))
    } catch (e) {
      // Rule 3's corollary: never serve stale here. A page that says
      // `max-age=300` because it can change is exactly the one where a cached
      // copy would keep serving a superseded version after the chain moved on.
      return new Response('Upstream RPC error reading ' + resolved.address, {
        status: 502,
        headers: { 'cache-control': 'no-store' },
      })
    }
    if (!page) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    // Content-Type and Cache-Control come from the contract (already whitelisted
    // and validated in onchain.js); everything else on the response is ours.
    // Taking Cache-Control from the page is the point: an immutable version
    // says `immutable`, a resolver that follows the chain says `max-age=300`,
    // and the gateway never has to know which address it is holding.
    const headers = new Headers({
      'content-type': page.contentType,
      'cache-control': page.cacheControl,
      'x-content-type-options': 'nosniff',
      'x-wns-name': sub,
      'x-wns-contract': resolved.address,
    })
    if (request.method === 'HEAD') {
      headers.set('content-length', String(page.body.length))
      return new Response(null, { status: page.status, headers })
    }
    // `Response` throws if a null-body status carries one, and the status is
    // contract-authored — a page answering 204/304 with bytes attached would
    // otherwise take the whole request down. Drop the body, keep the status.
    if (NULL_BODY_STATUS.has(page.status)) {
      return new Response(null, { status: page.status, headers })
    }
    return new Response(page.body, { status: page.status, headers })
  }

  const mode = readEnv(env, 'GATEWAY_MODE', 'redirect')
  const pathAndQuery = url.pathname + url.search

  // Build the upstream target + the id header that records what we served.
  //   web3 -> a web3:// HTTP gateway: `https://<addr>.<chainId>.<gw>/<path>`.
  //   ipfs/ipns -> a SUBDOMAIN gateway (`<id>.ipfs.<gw>`), NOT a path gateway
  //     (`<gw>/ipfs/<id>`): path gateways don't apply the site's `_redirects` /
  //     SPA fallback, so deep paths 404 even when `/` works. Subdomain gateways
  //     serve each id as its own origin and honour `_redirects`. Needs a base32
  //     CIDv1 / base36 IPNS name (fits a DNS label) — decodeContenthash emits it.
  let target
  let idHeader
  if (resolved.kind === 'web3') {
    const web3Gw = readEnv(env, 'WEB3_GATEWAY', 'w3link.io')
    const chainId = readEnv(env, 'WEB3_CHAIN_ID', '1')
    target = `https://${resolved.address}.${chainId}.${web3Gw}${pathAndQuery}`
    idHeader = ['x-wns-contract', resolved.address]
  } else {
    const subGw = readEnv(env, 'IPFS_SUBDOMAIN_GATEWAY', 'dweb.link')
    target = `https://${resolved.id}.${resolved.kind}.${subGw}${pathAndQuery}`
    idHeader = [resolved.kind === 'ipns' ? 'x-ipns-name' : 'x-ipfs-cid', resolved.id]
  }

  if (mode === 'proxy') {
    // Stream the content through the gateway, keeping <label>.wei.limo in the bar.
    // Heavier: the gateway carries the bandwidth. Prefer `redirect` at scale.
    const upstream = await fetch(target, {
      method: request.method,
      headers: { accept: request.headers.get('accept') || '*/*' },
    })
    // Forward only a safe subset. Never propagate Set-Cookie: upstream content
    // is untrusted and must not be able to set cookies on a *.wei.limo origin.
    const PASS = ['content-type', 'content-length', 'etag', 'last-modified']
    const headers = new Headers()
    for (const h of PASS) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    headers.set('cache-control', 'public, max-age=300')
    // Defense-in-depth for untrusted content executing on this origin.
    headers.set('x-content-type-options', 'nosniff')
    headers.set('x-wns-name', sub)
    headers.set(idHeader[0], idHeader[1])
    return new Response(upstream.body, { status: upstream.status, headers })
  }

  // Default: 302 to the upstream gateway. Bandwidth-light (the gateway is never
  // in the data path) and per-target origin isolation comes for free from the
  // CID/key/contract subdomain. Each <label>.wei.limo is already its own origin.
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      'cache-control': 'public, max-age=300',
      'x-wns-name': sub,
      [idHeader[0]]: idHeader[1],
    },
  })
}
