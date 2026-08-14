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
import { TtlCache, singleFlight, parseCacheControl } from './cache.js'

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

// Short in-memory cache of label -> servable target, to spare RPCs on repeat
// hits. Best-effort (per worker isolate / per Node process); not a correctness
// path. Bounded, so a flood of random `*.wei.limo` labels can't OOM the
// instance. 60s is short enough that a newly registered name still resolves
// essentially instantly, which is the point of the wildcard design.
const RESOLUTION_TTL_MS = 60_000
const resolutionCache = new TtlCache({ maxEntries: 5_000 })

// Contract page bodies, held for exactly as long as the contract's own
// Cache-Control allows (see cache.js). This is the difference between one
// `eth_call` per request and one per TTL: a hot page is a few hundred KB of
// RPC every single time without it, which is how the gateway falls over under
// traffic. Byte-budgeted because the entries are documents, not pointers.
const PAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024
const pageCache = new TtlCache({ maxEntries: 500, maxBytes: PAGE_CACHE_MAX_BYTES })

// One in-flight call per key. N simultaneous readers of the same cold page
// cost one RPC chain, not N — the failure mode a cache alone doesn't fix,
// because on a cold entry every one of them misses at the same instant.
const resolveInflight = new Map()
const pageInflight = new Map()

// How deep a subdomain may go before the gateway stops believing it.
//
// `<x>.<parent>.<zone>` is real — `02.zswap.wei` is a registered name carrying
// its own contenthash — and the chain is the only authority on which of these
// exist. So depth 2 always resolves. Only depth 3+ is refused without a lookup,
// because no wildcard cert secures it at any level: `*.<parent>.<zone>` covers
// exactly one label below the parent, so `a.b.c.<zone>` cannot be reached over
// TLS however it is configured. Refusing that costs a scanner its `eth_call`s
// and costs a real name nothing.
//
// An earlier version of this guard hardcoded the parents that had wildcard
// certs and 404'd everything else. It dropped `02.zswap.wei.limo` — a live name
// behind a cert that already existed — because the list was a hand-maintained
// copy of DNS state and went stale the moment a subdomain was registered. The
// certificate, not the hostname pattern, is the thing that decides
// reachability, and the gateway cannot see certificates: a version scan and a
// real versioning scheme look identical from here. A list that must be updated
// per name is also the exact per-name provisioning this gateway exists to
// avoid. So: the chain decides what exists, DNS/TLS decides what is reachable,
// and the gateway only refuses what neither could ever produce.
const MAX_SUB_LABELS = 2

// Optional tightening for operators who want it: if set, only these parents may
// serve `<x>.<parent>.<zone>`. Unset (the default) means any parent may, and
// the chain answers. Empty on purpose — opt-in hardening, not a registry the
// gateway needs in order to stay correct.
const SUBDOMAIN_PARENTS = new Set([])

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

// Hold a page for exactly as long as its own Cache-Control allows, and no
// longer. A contract saying `immutable` gets held; one saying `max-age=300`
// gets held for five minutes; one saying `no-store` isn't held at all. The
// gateway never picks this number itself. Returns the page for chaining.
function rememberPage(key, page) {
  if (!page) return page
  const ttl = parseCacheControl(page.cacheControl)
  if (ttl > 0) {
    // +512 for the entry's own overhead, so the byte budget isn't fooled by
    // many tiny bodies.
    pageCache.set(key, page, { expires: Date.now() + ttl * 1000, size: page.body.length + 512 })
  }
  return page
}

// RPC trouble, told apart: a full outbound queue is this gateway shedding load
// and worth retrying shortly (503), anything else is upstream (502). Neither is
// ever cacheable — a cached error would outlive the condition that caused it.
function upstreamError(e, what) {
  if (e?.overloaded) {
    return new Response('Gateway busy, retry shortly.\n', {
      status: 503,
      headers: { 'cache-control': 'no-store', 'retry-after': '2', 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  return new Response('Upstream RPC error ' + what, {
    status: 502,
    headers: { 'cache-control': 'no-store', 'retry-after': '5' },
  })
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

  // Depth guard, before any RPC — see MAX_SUB_LABELS. Depth 2 always resolves
  // (the chain decides whether `02.zswap.wei` exists); depth 3+ never can, so
  // it is refused for free rather than costing three `eth_call`s per probe.
  const labels = sub.split('.')
  const parents = new Set([
    ...SUBDOMAIN_PARENTS,
    ...String(readEnv(env, 'SUBDOMAIN_PARENTS', '')).split(',').map((s) => s.trim()).filter(Boolean),
  ])
  const tooDeep = labels.length > MAX_SUB_LABELS
  const parentNotAllowed = labels.length === 2 && parents.size > 0 && !parents.has(labels[1])
  if (tooDeep || parentNotAllowed) {
    return new Response(
      `No such host: ${sub}.${zone}\n` +
        `A wildcard certificate covers one label, so this name cannot be reached over TLS.\n`,
      // Never cacheable. This response once carried `max-age=300`, and when the
      // guard behind it turned out to be wrong those 404s kept being served
      // from browser caches long after the server was fixed — the outage
      // outlived its own cause. An error a client can pin is a liability.
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
    )
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
  // Concurrent requests for the same label share one resolution.
  let resolved
  let prefetched
  const now = Date.now()
  const cached = resolutionCache.get(sub, now)
  if (cached !== undefined) {
    resolved = cached
  } else {
    try {
      const hit = await singleFlight(resolveInflight, sub, async () => {
        const out = await resolveTarget(sub, opts)
        resolutionCache.set(sub, out.resolved, { expires: Date.now() + RESOLUTION_TTL_MS })
        return out
      })
      resolved = hit.resolved
      prefetched = hit.prefetched
    } catch (e) {
      return upstreamError(e, 'resolving ' + sub)
    }
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
    // Path and query are part of the identity of a 5219 response.
    const pageKey = `${resolved.address}|${url.pathname}${url.search}`
    let page = pageCache.get(pageKey, now)
    if (!page) {
      try {
        if (prefetched) {
          // The html() read that classified this address is also its content;
          // don't call the contract a second time for the same bytes.
          page = rememberPage(pageKey, prefetched)
        } else {
          page = await singleFlight(pageInflight, pageKey, async () =>
            rememberPage(
              pageKey,
              resolved.mode === '5219'
                ? await fetchErc5219(resolved.address, url.pathname, url.search, opts)
                : // ERC-8244 has no notion of a path: one document, served at
                  // every path, the same shape as an SPA fallback.
                  await fetchErc8244(resolved.address, opts),
            ),
          )
        }
      } catch (e) {
        // Rule 3's corollary: never serve stale here. An expired entry is not a
        // fallback — a page saying `max-age=300` because it can change is
        // exactly the one where a stale copy would keep serving a superseded
        // version after the chain moved on. Only unexpired entries are served,
        // and those were already returned by the lookup above.
        return upstreamError(e, 'reading ' + resolved.address)
      }
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
