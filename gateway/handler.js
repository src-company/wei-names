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
  const opts = { rpc, contract }

  // Resolve label -> a servable target, with a short cache. Two kinds:
  //   { kind: 'web3', address }  — an on-chain (ERC-4804) dapp: the name's addr
  //       record is a contract whose resolveMode() is a web3:// mode. Served via
  //       a web3:// HTTP gateway so deep paths / raw files (…/tokenlist.json)
  //       come straight from chain, always live. Takes precedence over any IPFS
  //       contenthash the same name may also carry (an ERC-8244 loader).
  //   { kind: 'ipfs' | 'ipns', id } — a contenthash. For IPNS `id` is a stable
  //       key the gateway resolves fresh each request, so the owner can update
  //       the site with no new on-chain transaction.
  let resolved
  const cached = cache.get(sub)
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) {
    resolved = cached.resolved
  } else {
    try {
      const tokenId = await computeId(sub, opts)
      if (tokenId === 0n) {
        resolved = null
      } else {
        // Address record and contenthash in parallel (one round-trip); the
        // resolveMode() probe only runs when the name resolves to an address.
        const [address, contenthash] = await Promise.all([
          resolveAddress(tokenId, opts),
          contenthashOf(tokenId, opts),
        ])
        const mode = address ? await resolveMode(address, opts) : ''
        if (WEB3_MODES.has(mode)) {
          resolved = { kind: 'web3', address }
        } else {
          const content = decodeContenthash(contenthash)
          resolved = content ? { kind: content.ns, id: content.id } : null
        }
      }
    } catch (e) {
      return new Response('Upstream RPC error resolving ' + sub, {
        status: 502,
        headers: { 'cache-control': 'no-store' },
      })
    }
    cacheSet(sub, { resolved, at: now })
  }

  if (!resolved) {
    // Registered names without servable content, or unregistered names.
    return new Response(
      `No on-chain dapp or IPFS/IPNS content set for ${sub}.\n` +
        `Set an addr (ERC-4804 contract) or a contenthash on this name at https://wei.domains to publish here.\n`,
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    )
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
