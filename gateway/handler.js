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

  // Resolve label -> { ns, id }, with a short cache. `ns` is 'ipfs' or 'ipns';
  // for IPNS `id` is a stable key and the IPNS gateway resolves it fresh each
  // request, so the owner can update the site with no new on-chain transaction.
  let content
  const cached = cache.get(sub)
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) {
    content = cached.content
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
    content = decodeContenthash(contenthash)
    cacheSet(sub, { content, at: now })
  }

  if (!content) {
    // Registered names without an IPFS/IPNS contenthash, or unregistered names.
    return new Response(
      `No IPFS or IPNS content set for ${sub}.\n` +
        `Set a contenthash on this name at https://wei.domains to publish here.\n`,
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    )
  }

  const { ns, id } = content // ns: 'ipfs' | 'ipns'
  const mode = readEnv(env, 'GATEWAY_MODE', 'redirect')
  const pathAndQuery = url.pathname + url.search

  if (mode === 'proxy') {
    // Stream the content through the gateway, keeping <label>.wei.limo in the bar.
    // Heavier: the gateway carries the bandwidth. Prefer `redirect` at scale.
    const pathGw = readEnv(env, 'IPFS_PATH_GATEWAY', 'https://ipfs.io')
    const target = `${pathGw}/${ns}/${id}${pathAndQuery}`
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
    headers.set(ns === 'ipns' ? 'x-ipns-name' : 'x-ipfs-cid', id)
    return new Response(upstream.body, { status: upstream.status, headers })
  }

  // Default: 302 to a subdomain IPFS/IPNS gateway. Bandwidth-light (the gateway
  // is never in the data path) and per-name origin isolation comes for free from
  // the CID/key subdomain. Each <label>.wei.limo is already its own origin too.
  const subGw = readEnv(env, 'IPFS_SUBDOMAIN_GATEWAY', 'dweb.link')
  const target = `https://${id}.${ns}.${subGw}${pathAndQuery}`
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      'cache-control': 'public, max-age=300',
      'x-wns-name': sub,
      [ns === 'ipns' ? 'x-ipns-name' : 'x-ipfs-cid']: id,
    },
  })
}
