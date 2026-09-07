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
// One address may hold an eighth of the budget. A 5219 contract is handed the
// path and query, so a single name can legitimately occupy unboundedly many
// keys; capping its share keeps a URL fan-out on one name from turning every
// other name's cached page cold. That name still pays a read per fresh URL —
// the contract is entitled to answer differently for each — but its neighbours
// no longer do.
const PAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024
const PAGE_CACHE_MAX_ADDRESS_BYTES = PAGE_CACHE_MAX_BYTES / 8
const pageCache = new TtlCache({
  maxEntries: 500,
  maxBytes: PAGE_CACHE_MAX_BYTES,
  maxGroupBytes: PAGE_CACHE_MAX_ADDRESS_BYTES,
})

// One in-flight call per key. N simultaneous readers of the same cold page
// cost one RPC chain, not N — the failure mode a cache alone doesn't fix,
// because on a cold entry every one of them misses at the same instant.
const resolveInflight = new Map()
const pageInflight = new Map()

// Proxy-mode bodies. In `redirect` mode the gateway is never in the data path,
// but in `proxy` mode it fetches the whole document from the IPFS gateway on
// every request — the CID cache above spares the RPC and nothing else, so a hot
// name is a full upstream fetch per hit and Render edge-caches none of it.
//
// Only `ipfs` is held, never `ipns`: a CID is content-addressed, so cid+path ->
// bytes cannot change and holding it is free correctness. An IPNS name is
// mutable and is deliberately resolved fresh each request so the owner can
// update the site with no on-chain transaction; caching it would break that.
//
// Bodies over PROXY_MAX_BODY_BYTES are streamed straight through and never
// held, so one large file can't be buffered into an OOM on a starter instance.
const PROXY_CACHE_MAX_BYTES = 16 * 1024 * 1024
const PROXY_MAX_BODY_BYTES = 2 * 1024 * 1024
const PROXY_TTL_MS = 300_000
const proxyCache = new TtlCache({ maxEntries: 500, maxBytes: PROXY_CACHE_MAX_BYTES })
const proxyInflight = new Map()

// Query parameters an IPFS gateway actually answers differently for. Everything
// else is dropped from both the upstream URL and the cache key.
//
// Dropping the query wholesale would be wrong — `?format=raw` and `?download=`
// change the response — but keeping it wholesale means `?x=1`, `?x=2`, … are
// each a distinct entry and a distinct upstream fetch for byte-identical
// content, which is the cheapest cache buster there is. So: keep what the
// gateway honours, drop what it ignores, and sort, so two orderings of the same
// request are one entry rather than two.
const IPFS_QUERY_KEYS = new Set([
  'format',
  'download',
  'filename',
  'dag-scope',
  'entity-bytes',
  'car-scope',
  'car-version',
  'car-order',
  'car-dups',
])

function ipfsQuery(search) {
  if (!search || search === '?') return ''
  const kept = []
  for (const [k, v] of new URLSearchParams(search)) {
    if (IPFS_QUERY_KEYS.has(k.toLowerCase())) kept.push([k.toLowerCase(), v])
  }
  if (!kept.length) return ''
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
  return '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

// Cap on concurrent outbound fetches to the IPFS gateway, mirroring the RPC
// semaphore in wns.js and for the same reason: a spike otherwise opens a socket
// per request, and the first thing that breaks is the upstream rate-limiting
// this gateway, which takes every name down at once rather than slowing one.
//
// The slot covers issuing the request and receiving its headers, and is
// released before the body is read. That bounds how fast connections are opened
// upstream rather than how many bodies are in flight; holding a slot for the
// whole transfer would let a handful of slow readers starve the queue into
// shedding requests that would otherwise have been served.
const PROXY_MAX_INFLIGHT = 10
const PROXY_MAX_QUEUE = 200

// How long an upstream gets to produce response HEADERS. Not the body: the
// semaphore slot is released once headers arrive, so a slow large file costs
// bandwidth, not a slot, and capping the whole transfer would truncate it.
//
// Without this a gateway that accepts the connection and then hangs holds a
// slot until the runtime's own default gives up — minutes, on Node. That is the
// failure mode wns.js already documents for blastapi.io, and a failover list
// makes it worse rather than better: one hung entry used to stall one request,
// and would now stall it once per entry, in series.
//
// Env-tunable (PROXY_TIMEOUT_MS) for the same reason the rate limits are: the
// right value depends on which gateways are in the list, and finding that out
// under load should not need a redeploy.
const PROXY_TIMEOUT_MS = 8_000

// An upstream that just failed is skipped for COOLDOWN_MS rather than retried
// on every single request. Same reasoning as the RPC benching in wns.js: a
// retiring gateway answering 429 for a minute at a time is not a one-off, and
// paying a full round trip per request to rediscover it turns a degraded
// upstream into a slow gateway for everyone.
//
// Benched entries are not removed, only deprioritised — the order becomes
// healthy-first, benched-after, so nothing is ever unreachable and a recovered
// gateway returns to the front on its own when the bench expires. A 404 never
// benches: the gateway is fine, the file isn't there.
const PROXY_COOLDOWN_MS = 30_000
export const upstreamHealth = new Map()

function benchUpstream(host) {
  upstreamHealth.set(host, Date.now() + PROXY_COOLDOWN_MS)
  // Bounded like the rate-limit buckets: the host list is operator-configured
  // and tiny, but nothing here should be able to grow without a ceiling.
  if (upstreamHealth.size > 100) {
    const oldest = upstreamHealth.keys().next()
    if (!oldest.done) upstreamHealth.delete(oldest.value)
  }
}

// Healthy entries first, benched ones after, each group keeping its configured
// order. Never returns fewer entries than it was given.
function byHealth(targets, now) {
  if (targets.length < 2) return targets
  const healthy = []
  const benched = []
  for (const t of targets) {
    const until = upstreamHealth.get(t.host)
    if (until === undefined || now >= until) {
      if (until !== undefined) upstreamHealth.delete(t.host)
      healthy.push(t)
    } else {
      benched.push(t)
    }
  }
  return healthy.concat(benched)
}
let proxyBusy = 0
const proxyWaiting = []

async function proxyAcquire() {
  if (proxyBusy < PROXY_MAX_INFLIGHT) {
    proxyBusy++
    return
  }
  if (proxyWaiting.length >= PROXY_MAX_QUEUE) {
    const e = new Error('gateway busy: proxy queue full')
    e.overloaded = true
    throw e
  }
  await new Promise((resolve) => proxyWaiting.push(resolve))
  proxyBusy++
}

function proxyRelease() {
  proxyBusy--
  const next = proxyWaiting.shift()
  if (next) next()
}

// Read a body while refusing to buffer more than `cap` bytes.
//
// Returns `{ body }` with the complete bytes when it fits — the only case that
// may be cached — and `{ stream }` when it doesn't: a stream that re-emits what
// was already pulled and then pipes the rest, so overrunning the cap costs a
// passthrough rather than a second upstream fetch or a truncated response.
async function readCapped(res, cap) {
  if (!res.body) return { body: new Uint8Array(0) }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (total > cap) {
      return {
        stream: new ReadableStream({
          start(c) {
            for (const ch of chunks) c.enqueue(ch)
          },
          async pull(c) {
            const next = await reader.read()
            if (next.done) c.close()
            else c.enqueue(next.value)
          },
          cancel(reason) {
            reader.cancel(reason)
          },
        }),
      }
    }
  }
  const body = new Uint8Array(total)
  let at = 0
  for (const ch of chunks) {
    body.set(ch, at)
    at += ch.length
  }
  return { body }
}

// How deep a subdomain may go before the gateway stops believing it.
//
// Exactly one rule, and it is about arithmetic rather than about any list of
// names: a wildcard cert covers one label, and `*.<parent>.<zone>` is the
// deepest entry that can exist, so nothing past two labels below the zone can
// be reached over TLS however DNS is configured. That is safe to refuse for
// free because it cannot misjudge a real name.
//
// Everything shallower goes to the chain. There was, briefly, an allowlist of
// parents here as well, on the theory that only parents with their own cert
// could legitimately appear. It was wrong twice over and took down two live
// names — `02.zswap.wei` and `token.list.wei` — because:
//
//   - it was a hand-maintained copy of DNS state living in code, so it went
//     stale the moment a subdomain was registered. That is precisely the
//     per-name provisioning this gateway exists to abolish; and
//   - it also shipped as a render.yaml env var, which meant deleting it from
//     the blueprint did NOT unset it on the running service. The stale value
//     kept enforcing an allowlist the code no longer even declared.
//
// So there is no list, and no env var to leave behind. The chain decides what
// exists, DNS and TLS decide what is reachable, and this refuses only what
// neither could ever produce.
const MAX_SUB_LABELS = 2


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

// `<cid>.<zone>` — serve that content directly, skipping WNS entirely.
//
// The same surface as an address label, for the other kind of fixed target: an
// address pins a contract's bytes, a CID pins a document's. Both answer the
// question "what exactly did I audit", and neither can be repointed by anyone,
// including whoever holds the name that used to carry it.
//
// It exists because the alternative was worse. The dapp used to link a name's
// contenthash at `ipfs.io/ipfs/<cid>`, which put a third party — and, as of
// 2026-09, a third party being retired — in the path of the one link whose
// entire point is that it does not depend on anybody's goodwill. This serves it
// through our own gateway instead, inheriting the failover in the proxy path.
//
// Shapes are restricted to the two multibase prefixes decodeContenthash emits:
//   base32 CIDv1  `b` + [a-z2-7] — 59 chars for the usual sha-256 dag-pb
//   base36 IPNS   `k` + [0-9a-z] — 62 for an ed25519 libp2p-key, ~57 for a
//                 sha-256 one, so this is a range and not a fixed width
// Both are bounded above at 63 by the DNS label limit anyway: a longer one
// could never arrive here over TLS in the first place.
//
// Collision, stated plainly: MAX_LABEL_LENGTH in NameNFT.sol is 255 bytes, so a
// `.wei` name of this shape is registrable, and this surface would shadow it.
// That is the same trade the address label already makes and it is resolved the
// same way — the label surface wins, because a reader following a
// content-addressed link must get the content they asked for and not whatever a
// name now points at. The floor of 50 characters is what keeps that set to
// strings nobody registers by accident: every shorter name is unaffected, and
// no plausible name is 50+ characters of nothing but base32.
const IPFS_CID_LABEL = /^b[a-z2-7]{49,62}$/
const IPNS_KEY_LABEL = /^k[0-9a-z]{49,62}$/

function contentLabel(sub) {
  if (IPFS_CID_LABEL.test(sub)) return { kind: 'ipfs', id: sub }
  if (IPNS_KEY_LABEL.test(sub)) return { kind: 'ipns', id: sub }
  return null
}

// Per-client rate limit — the one thing that keeps a flood from being everyone
// else's outage.
//
// The caches below make a REPEATED url cheap and MAX_INFLIGHT keeps the gateway
// from melting, but neither bounds how fast one client may ask for URLs it has
// never asked for. A 5219 contract is handed the path and query, so every fresh
// `?x=N` is a legitimately distinct response and a full document read: cheap to
// send, expensive to answer. Without a limit the queue fills, and MAX_INFLIGHT
// starts shedding 503s at everybody — the attacker's traffic and the real
// readers' alike. Refusing the source is the only version of that which the
// rest of the zone survives.
//
// A token bucket, not a fixed window: BURST requests may arrive back-to-back
// (one page pulls many assets), refilling at RATE per second. Set RATE_LIMIT_RPS
// to 0 to disable.
// Generous on burst, strict on sustained rate. A proxy-mode site pulls many
// assets on one page load, so a small burst would refuse real readers; what
// actually needs bounding is the client that keeps going after the page is up.
const RATE_LIMIT_RPS = 15
const RATE_LIMIT_BURST = 100
// Bounded so the limiter itself can't be turned into the memory exhaustion it
// exists to prevent: a flood from many spoofed sources evicts oldest-first.
const RATE_LIMIT_MAX_CLIENTS = 20_000
// Exported for the tests, which drive the clock by ageing a bucket rather than
// sleeping through a real refill.
export const buckets = new Map()

// Client identity belongs to the runtime adapter: Node knows its socket peer
// and trusted proxies; Cloudflare supplies a platform-authenticated header.
// Callers without transport context share a bucket rather than trusting headers.

// True when this request is over budget. Charges a token when it isn't.
function rateLimited(key, now, rps, burst) {
  if (rps <= 0) return false
  let b = buckets.get(key)
  if (!b) {
    b = { tokens: burst, last: now }
    // Touch-on-write keeps insertion order meaningful for eviction below.
    if (buckets.size >= RATE_LIMIT_MAX_CLIENTS) {
      const oldest = buckets.keys().next()
      if (!oldest.done) buckets.delete(oldest.value)
    }
  } else {
    buckets.delete(key)
    b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * rps)
    b.last = now
  }
  buckets.set(key, b)
  if (b.tokens < 1) return true
  b.tokens -= 1
  return false
}

// Statuses HTTP forbids a body on. `Response` throws rather than truncating.
const NULL_BODY_STATUS = new Set([204, 205, 304])

function readEnv(env, key, fallback) {
  const v = env?.[key]
  return v === undefined || v === null || v === '' ? fallback : v
}

// Comma-separated env var -> trimmed, non-empty entries, in order. Same shape
// as ZONE and RPC_URLS already use, so a single value stays a valid setting.
function envList(env, key, fallback) {
  return String(readEnv(env, key, fallback)).split(',').map((s) => s.trim()).filter(Boolean)
}

// Upstream answers that say "this gateway, right now" rather than "this
// content": worth asking the next gateway in the list, because another one
// holding the same CID will answer differently. A 404 is NOT in here — a
// missing path is a fact about the content and every gateway agrees on it, so
// retrying it upstream by upstream is latency spent to arrive at the same 404.
//
// 429 is the one that matters today: the public gateway fleet is being retired
// and answers 429 for a growing slice of each hour, so a name pinned and
// reachable everywhere else still goes dark on a schedule.
function shouldFailover(status) {
  return status === 429 || (status >= 500 && status <= 599)
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
function rememberPage(key, page, address) {
  if (!page) return page
  const ttl = parseCacheControl(page.cacheControl)
  if (ttl > 0) {
    // +512 for the entry's own overhead, so the byte budget isn't fooled by
    // many tiny bodies. Grouped by address so one contract's share is bounded.
    pageCache.set(key, page, {
      expires: page.fetchedAt + ttl * 1000,
      size: page.body.length + 512,
      group: address,
    })
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
  // A content label is already the answer — no registry lookup, no RPC at all.
  const direct = contentLabel(sub)
  if (direct) return { resolved: direct }

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

export async function handleRequest(request, env, { clientIp = 'unknown' } = {}) {
  const url = new URL(request.url)
  const zones = String(readEnv(env, 'ZONE', ZONE)).split(',').map((s) => s.trim()).filter(Boolean)

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  // Lightweight health check for Railway/Render.
  if (url.pathname === '/healthz') {
    return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } })
  }

  // After /healthz so platform monitoring is never limited, and before any
  // resolution so a refused request costs no RPC and no upstream fetch.
  const rps = Number(readEnv(env, 'RATE_LIMIT_RPS', RATE_LIMIT_RPS))
  const burst = Number(readEnv(env, 'RATE_LIMIT_BURST', RATE_LIMIT_BURST))
  if (rateLimited(clientIp || 'unknown', Date.now(), rps, burst)) {
    return new Response('Too many requests, slow down.\n', {
      status: 429,
      headers: {
        'cache-control': 'no-store',
        'retry-after': '1',
        'content-type': 'text/plain; charset=utf-8',
      },
    })
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
  if (sub.split('.').length > MAX_SUB_LABELS) {
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
      // `no-store` for the same reason the depth guard above carries it: 404 is
      // heuristically cacheable (RFC 9111 4.2.2), and this is precisely the 404
      // a name gets in the seconds BEFORE its owner sets a contenthash. Letting
      // a browser pin it defeats the whole premise that a freshly registered
      // name resolves instantly with no DNS write.
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
    )
  }

  // A contract page is read and written here — GATEWAY_MODE doesn't apply,
  // because there is no upstream to redirect to. Each `<label>.<zone>` is
  // already its own origin (see the Public Suffix List note in README.md).
  if (resolved.kind === 'contract') {
    // Path and query are part of the identity of a 5219 response.
    // What identifies the cached document, which is exactly what the mode says
    // it is. For 5219 the contract is handed the path and query and may answer
    // differently for each, so both belong in the key. For ERC-8244 there is
    // one document served at every path (see the html() call below), so putting
    // the URL in the key would store the SAME bytes under unboundedly many
    // keys: `?x=1`, `?x=2`, … each miss the cache, each cost a full-document
    // `eth_call`, and ~113 of them at zswap's 288 KB evict the entire 32 MB
    // budget. Keying an 8244 page by address alone makes that free — a cache
    // buster and a plain reload become the same entry, and singleFlight then
    // coalesces every concurrent reader of the name rather than one per URL.
    const pageKey =
      resolved.mode === '5219' ? `${resolved.address}|${url.pathname}${url.search}` : resolved.address
    let page = pageCache.get(pageKey, Date.now())
    if (!page) {
      try {
        if (prefetched) {
          // The html() read that classified this address is also its content;
          // don't call the contract a second time for the same bytes.
          page = rememberPage(pageKey, prefetched, resolved.address)
        } else {
          page = await singleFlight(pageInflight, pageKey, async () =>
            rememberPage(
              pageKey,
              resolved.mode === '5219'
                ? await fetchErc5219(resolved.address, url.pathname, url.search, opts)
                : // ERC-8244 has no notion of a path: one document, served at
                  // every path, the same shape as an SPA fallback.
                  await fetchErc8244(resolved.address, opts),
              resolved.address,
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
      // Include the original read's elapsed time on GET and HEAD. Round up so
      // sub-second timing cannot extend the contract's freshness deadline.
      'age': String(Math.max(0, Math.ceil((Date.now() - page.fetchedAt) / 1000))),
      'x-content-type-options': 'nosniff',
      'x-wns-name': sub,
      'x-wns-contract': resolved.address,
      // Which interface answered. `x-wns-contract` alone cannot say: it is set
      // for both ERC-4804 `request()` and ERC-8244 `html()`, and the two cache
      // and behave differently — 5219 is handed the path and query and may vary
      // per URL, html() is one document at every URL. Telling them apart from
      // outside otherwise means reading resolveMode() off the chain, which is
      // exactly the step everyone skips before concluding what this gateway is
      // doing.
      'x-wns-mode': resolved.mode,
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
  // `targets` is an ordered list, not one URL: in proxy mode each is tried
  // until one answers something that isn't shouldFailover(). One entry — the
  // historical setting — behaves exactly as before, so a single gateway's
  // status still passes straight through.
  let targets
  let idHeader
  if (resolved.kind === 'web3') {
    const chainId = readEnv(env, 'WEB3_CHAIN_ID', '1')
    targets = envList(env, 'WEB3_GATEWAY', 'w3link.io').map((gw) => ({
      host: gw,
      url: `https://${resolved.address}.${chainId}.${gw}${pathAndQuery}`,
    }))
    idHeader = ['x-wns-contract', resolved.address]
  } else {
    // Only the parameters the gateway honours reach it; see ipfsQuery.
    const query = ipfsQuery(url.search)
    targets = envList(env, 'IPFS_SUBDOMAIN_GATEWAY', 'dweb.link').map((gw) => ({
      host: gw,
      url: `https://${resolved.id}.${resolved.kind}.${gw}${url.pathname}${query}`,
    }))
    // Path-gateway fallbacks (`<origin>/ipfs/<cid>/<path>`), proxy mode only.
    // Deliberately last and deliberately never used for a redirect: a path
    // gateway serves every CID from one origin, so the site's `_redirects` /
    // SPA fallback does not apply and extensionless deep paths 404 there even
    // though `/` and the real filenames are fine. That is a worse answer than a
    // subdomain gateway and a much better one than the 429 a retiring gateway
    // returns. In proxy mode the bytes still arrive under <label>.<zone>, so
    // nothing about origin isolation changes for the visitor.
    if (mode === 'proxy') {
      for (const origin of envList(env, 'IPFS_PATH_GATEWAY', '')) {
        const base = origin.replace(/\/+$/, '')
        let host = base
        try {
          host = new URL(base).host
        } catch {}
        targets.push({ host, url: `${base}/${resolved.kind}/${resolved.id}${url.pathname}${query}` })
      }
    }
    idHeader = [resolved.kind === 'ipns' ? 'x-ipns-name' : 'x-ipfs-cid', resolved.id]
  }
  // An env var set to nothing but separators would otherwise leave no upstream
  // at all; fall back to the documented default rather than 502 every name.
  if (!targets.length) {
    targets = [
      resolved.kind === 'web3'
        ? { host: 'w3link.io', url: `https://${resolved.address}.1.w3link.io${pathAndQuery}` }
        : {
            host: 'dweb.link',
            url: `https://${resolved.id}.${resolved.kind}.dweb.link${url.pathname}${ipfsQuery(url.search)}`,
          },
    ]
  }
  const target = targets[0].url

  if (mode === 'proxy') {
    // Stream the content through the gateway, keeping <label>.wei.limo in the bar.
    // Heavier: the gateway carries the bandwidth. Prefer `redirect` at scale.
    //
    // A held body is only correct where the id is content-addressed, so this is
    // `ipfs` and GET only — see the proxyCache note above for why `ipns` is
    // excluded. HEAD shares the key with nothing: it has no body to store.
    const proxyKey =
      resolved.kind === 'ipfs' && request.method === 'GET'
        ? `${resolved.id}|${url.pathname}${ipfsQuery(url.search)}`
        : null
    if (proxyKey) {
      const hit = proxyCache.get(proxyKey, now)
      if (hit) return new Response(hit.body, { status: 200, headers: new Headers(hit.headers) })
    }

    // Join a fetch already running for this key rather than opening a second
    // one. A body can only be read once, so only a fully buffered result can be
    // handed to more than one caller: the originator resolves with the bytes
    // when it has them and with null when it cannot share (oversized, or not a
    // 200), and anyone who joined then falls through and fetches for itself.
    if (proxyKey && proxyInflight.has(proxyKey)) {
      const shared = await proxyInflight.get(proxyKey)
      if (shared) {
        return new Response(shared.body, { status: 200, headers: new Headers(shared.headers) })
      }
    }
    let settle
    if (proxyKey) {
      proxyInflight.set(
        proxyKey,
        new Promise((resolve) => {
          settle = resolve
        }),
      )
    }
    const done = (shared) => {
      if (!proxyKey) return shared
      proxyInflight.delete(proxyKey)
      settle(shared)
      return shared
    }

    // Walk the upstream list until one answers something worth serving. Only
    // shouldFailover() statuses and outright fetch failures move on; anything
    // else — a 200, a 404, a 304 — is this content's real answer and is served.
    //
    // The LAST candidate is never failed over from: whatever it says (429 and
    // all) is what the visitor gets, which is why a one-entry list is bit-for-
    // bit the old behaviour. `rejected` holds the best failure seen so far so a
    // list that fails all the way down still returns an upstream's own status
    // rather than flattening everything into a 502.
    let upstream = null
    let rejected = null
    let lastError = null
    let servedBy = targets[0]
    const proxyTimeoutMs =
      Number(readEnv(env, 'PROXY_TIMEOUT_MS', PROXY_TIMEOUT_MS)) || PROXY_TIMEOUT_MS
    // Try the ones that were working most recently first; see byHealth.
    const attempts = byHealth(targets, now)
    const discard = (res) => {
      try {
        res.body?.cancel()?.catch?.(() => {})
      } catch {}
    }
    for (let i = 0; i < attempts.length; i++) {
      const candidate = attempts[i]
      let res
      try {
        await proxyAcquire()
        // The timer is cleared the moment headers land, so the abort covers
        // connect-and-hang and nothing else — a large body still streams.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), proxyTimeoutMs)
        try {
          res = await fetch(candidate.url, {
            method: request.method,
            headers: { accept: request.headers.get('accept') || '*/*' },
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
          proxyRelease()
        }
      } catch (e) {
        lastError = e
        // A full outbound queue is this gateway's own back-pressure, not the
        // upstream misbehaving — benching it for that would be self-inflicted.
        if (!e?.overloaded) benchUpstream(candidate.host)
        // A full outbound queue is this gateway shedding load, not the upstream
        // being unwell — every candidate would hit the same closed door, so
        // stop rather than spending the whole list discovering that.
        if (e?.overloaded) break
        continue
      }
      if (shouldFailover(res.status)) {
        benchUpstream(candidate.host)
        if (i < attempts.length - 1) {
          if (rejected) discard(rejected)
          rejected = res
          servedBy = candidate
          continue
        }
      } else {
        upstreamHealth.delete(candidate.host)
      }
      upstream = res
      servedBy = candidate
      break
    }
    if (!upstream) {
      if (rejected) {
        upstream = rejected
        rejected = null
      } else {
        done(null)
        // An unreachable IPFS gateway is upstream trouble like any other; without
        // this it escaped handleRequest entirely and server.js turned it into a
        // bare 500 with no retry-after and no cache-control.
        return upstreamError(lastError, 'fetching ' + attempts[attempts.length - 1].url)
      }
    }
    if (rejected) discard(rejected)
    // Forward only a safe subset. Never propagate Set-Cookie: upstream content
    // is untrusted and must not be able to set cookies on a *.wei.limo origin.
    //
    // content-length is deliberately NOT forwarded. fetch() transparently
    // decodes content-encoding but leaves the ORIGINAL (compressed)
    // content-length on the header object, while content-encoding itself is not
    // in this list — so forwarding it would advertise the gzipped length for a
    // body we hand over decompressed, and every client would truncate there.
    // dweb.link happens to answer chunked today, which is the only reason this
    // has not bitten; IPFS_SUBDOMAIN_GATEWAY is env-configurable and the next
    // one need not. Let the runtime frame the body.
    const PASS = ['content-type', 'etag', 'last-modified']
    const headers = new Headers()
    for (const h of PASS) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    // Never let an upstream failure be cached: a 5xx from the IPFS gateway held
    // for five minutes outlives the outage that caused it, which is the exact
    // trap the depth-guard 404 above documents.
    headers.set('cache-control', upstream.ok ? 'public, max-age=300' : 'no-store')
    // Defense-in-depth for untrusted content executing on this origin.
    headers.set('x-content-type-options', 'nosniff')
    headers.set('x-wns-name', sub)
    headers.set('x-wns-mode', resolved.kind)
    headers.set(idHeader[0], idHeader[1])
    // Which upstream answered. With a failover list, "the gateway is serving a
    // 429" and "the third gateway in the list is serving a 429" are different
    // problems, and nothing else in the response tells them apart.
    headers.set('x-wns-upstream', servedBy.host)
    // `Response` throws rather than truncating when a null-body status carries
    // one — same guard the contract path already has.
    if (request.method === 'HEAD' || NULL_BODY_STATUS.has(upstream.status)) {
      done(null)
      return new Response(null, { status: upstream.status, headers })
    }

    // Nothing but a cacheable key on a healthy 200 may be held, and even then
    // only if it fits: readCapped hands back a passthrough stream instead of
    // bytes for anything larger, which is served and forgotten — and cannot be
    // shared with anyone who joined, so they are released to fetch their own.
    if (proxyKey && upstream.status === 200) {
      let read
      try {
        read = await readCapped(upstream, PROXY_MAX_BODY_BYTES)
      } catch (e) {
        done(null)
        return upstreamError(e, 'reading ' + servedBy.url)
      }
      if (read.stream) {
        done(null)
        return new Response(read.stream, { status: 200, headers })
      }
      const shared = { body: read.body, headers: [...headers] }
      proxyCache.set(proxyKey, shared, {
        expires: Date.now() + PROXY_TTL_MS,
        size: read.body.length + 512,
      })
      done(shared)
      return new Response(read.body, { status: 200, headers })
    }
    done(null)
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
      'x-wns-mode': resolved.kind,
      'x-wns-upstream': targets[0].host,
      [idHeader[0]]: idHeader[1],
    },
  })
}
