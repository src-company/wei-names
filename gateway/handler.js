// Core wildcard gateway: <label>.wei.limo / <label>.wei.is  ->  IPFS of <label>.wei.
//
// This is the whole automation. There is NO per-name DNS provisioning: a single
// `*.wei.limo` wildcard record points every undefined subdomain here, and this
// handler does the on-chain lookup at request time. A newly registered `.wei`
// name works instantly with zero DNS writes; expired/unregistered names 404.
//
// Runtime-agnostic: takes a standard `Request`, returns a standard `Response`.
// Used by both worker.js (Cloudflare) and server.js (Node/Railway).

import { resolveContenthash } from './wns.js'
import { contenthashToCid } from './contenthash.js'

// Zones this gateway serves. Comma-separated; a request to <label>.<zone>
// resolves the IPFS content of <label>.wei for ANY listed zone.
const ZONE = 'wei.limo,wei.is'

// Labels that must never be treated as `.wei` names.
//
// SECURITY: with a `*.wei.limo` wildcard in place, a *missing* explicit record no
// longer fails safe (NXDOMAIN) — it fails OPEN to whatever this gateway
// resolves. So every real app subdomain MUST be listed here: if e.g. the
// `srcco.wei.limo` record is ever dropped again, this list stops an attacker who
// registered `srcco.wei` from silently taking over that hostname. Keep it in
// sync with the app subdomains on wei.limo (also settable via RESERVED_LABELS).
const DEFAULT_RESERVED = new Set([
  'www', 'api', 'mail', 'ns1', 'ns2', '_dmarc', '_domainkey',
  'zfi', 'multisig', 'srcco', // <-- app subdomains; extend as you add apps
])

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
// `alice.wei.limo` -> `alice.wei`, `docs.alice.wei.is` -> `docs.alice.wei`.
// Returns null for a zone apex, or a host in none of the served zones.
function labelFromHost(host, zones) {
  if (!host) return null
  const h = host.toLowerCase().split(':')[0] // strip port
  for (const zone of zones) {
    const suffix = '.' + zone
    if (!h.endsWith(suffix)) continue
    const sub = h.slice(0, -suffix.length)
    return sub || null // null for the zone apex (e.g. `wei.limo`)
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
  const sub = labelFromHost(host, zones)
  if (!sub) {
    // Apex or unexpected host — send people to the WNS site.
    return Response.redirect('https://wei.domains', 302)
  }

  const firstLabel = sub.split('.')[0]
  const reserved = new Set([
    ...DEFAULT_RESERVED,
    ...String(readEnv(env, 'RESERVED_LABELS', '')).split(',').map((s) => s.trim()).filter(Boolean),
  ])
  if (reserved.has(firstLabel)) {
    return new Response('Not Found', { status: 404 })
  }

  const rpc = String(readEnv(env, 'RPC_URLS', '')).split(',').map((s) => s.trim()).filter(Boolean)
  const contract = readEnv(env, 'WNS_CONTRACT', undefined)
  const opts = { rpc, contract }

  // Resolve label -> CID, with a short cache.
  let cid
  const cached = cache.get(sub)
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) {
    cid = cached.cid
  } else {
    let contenthash
    try {
      contenthash = await resolveContenthash(sub, opts)
    } catch (e) {
      return new Response('Upstream RPC error resolving ' + sub, {
        status: 502,
        headers: { 'cache-control': 'no-store' },
      })
    }
    cid = contenthashToCid(contenthash)
    cacheSet(sub, { cid, at: now })
  }

  if (!cid) {
    // Registered names without an IPFS contenthash, or unregistered names.
    return new Response(
      `No IPFS content set for ${sub}.\n` +
        `Set a contenthash on this name at https://wei.domains to publish here.\n`,
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    )
  }

  const mode = readEnv(env, 'GATEWAY_MODE', 'redirect')
  const pathAndQuery = url.pathname + url.search

  if (mode === 'proxy') {
    // Stream the content through the gateway, keeping <label>.wei.limo in the bar.
    // Heavier: the gateway carries the bandwidth. Prefer `redirect` at scale.
    const pathGw = readEnv(env, 'IPFS_PATH_GATEWAY', 'https://ipfs.io')
    const target = `${pathGw}/ipfs/${cid}${pathAndQuery}`
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
    headers.set('x-ipfs-cid', cid)
    return new Response(upstream.body, { status: upstream.status, headers })
  }

  // Default: 302 to a subdomain IPFS gateway. Bandwidth-light (the gateway is
  // never in the data path) and per-name origin isolation comes for free from
  // the CID subdomain. Each <label>.wei.limo is already its own origin too.
  const subGw = readEnv(env, 'IPFS_SUBDOMAIN_GATEWAY', 'dweb.link')
  const target = `https://${cid}.ipfs.${subGw}${pathAndQuery}`
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      'cache-control': 'public, max-age=300',
      'x-wns-name': sub,
      'x-ipfs-cid': cid,
    },
  })
}
