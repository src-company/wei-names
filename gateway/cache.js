// Caching and request coalescing — the difference between a gateway that
// survives a traffic spike and one that melts.
//
// The gateway reads whole documents over `eth_call`. Uncached, a hot contract
// page is a few hundred KB of RPC *per request*, and N simultaneous readers of
// the same cold page are N identical call chains. Both are fixed here:
//
//   TtlCache     — bounded LRU with a byte budget, so a page is read once per
//                  TTL instead of once per request.
//   singleFlight — one in-flight call per key; everybody else awaits it, so a
//                  thundering herd on a cold entry costs exactly one RPC chain.
//
// How long a page may be held is NOT this gateway's decision — it comes from
// the contract's own Cache-Control (see parseCacheControl). An immutable build
// authorises a long hold; a resolver that follows the chain authorises 300s.
// Serving a cached copy INSIDE the max-age the contract itself published is not
// staleness, it's the header being honoured. Serving one PAST it would be, and
// nothing here ever does: expired entries are dropped, never revalidated-while-
// stale and never used as a fallback when RPC is down.

// --- bounded LRU with a byte budget -----------------------------------------

export class TtlCache {
  // `maxBytes` bounds memory (page bodies are large); `maxEntries` bounds the
  // small stuff (resolutions, which have no meaningful size). Eviction is LRU:
  // a Map preserves insertion order, and a hit re-inserts to move to the end.
  constructor({ maxEntries = 5_000, maxBytes = Infinity } = {}) {
    this.map = new Map()
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
    this.bytes = 0
  }

  get(key, now) {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (now >= hit.expires) {
      this.map.delete(key)
      this.bytes -= hit.size
      return undefined
    }
    // Touch: delete + re-insert moves this key to the newest position.
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key, value, { expires, size = 0 }) {
    const prev = this.map.get(key)
    if (prev) this.bytes -= prev.size
    this.map.delete(key)
    // An entry larger than the whole budget is not cacheable; don't evict the
    // entire cache trying to fit it.
    if (size > this.maxBytes) return
    this.map.set(key, { value, expires, size })
    this.bytes += size
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      const victim = this.map.get(oldest.value)
      this.map.delete(oldest.value)
      this.bytes -= victim.size
    }
  }

  get size() {
    return this.map.size
  }
}

// --- request coalescing ------------------------------------------------------

// Run `fn` under `key`, or join the call already running under it. Every
// awaiter gets the same result — including the same rejection, so a failure
// isn't retried N times by N callers either.
export function singleFlight(inflight, key, fn) {
  const running = inflight.get(key)
  if (running) return running
  const p = (async () => fn())()
  inflight.set(key, p)
  const clear = () => {
    if (inflight.get(key) === p) inflight.delete(key)
  }
  p.then(clear, clear)
  return p
}

// --- Cache-Control -----------------------------------------------------------

// How long the *contract* says its answer may be held, in seconds.
//
// `no-store`/`no-cache`/`max-age=0` -> 0, i.e. don't hold it at all. Otherwise
// max-age, capped: `immutable` gets the longer cap because it means the bytes
// cannot change, everything else gets the short one. The caps are about this
// process's memory, not about doubting the contract — a year-long max-age is
// meaningless to a service that redeploys, and holding every version of every
// page forever is how a gateway OOMs.
export function parseCacheControl(value, { cap = 3600, immutableCap = 86_400 } = {}) {
  const cc = String(value || '').toLowerCase()
  if (/(^|[\s,])(no-store|no-cache|private)([\s,;]|$)/.test(cc)) return 0
  const m = /(?:^|[\s,])max-age\s*=\s*"?(\d+)"?/.exec(cc)
  if (!m) return 0
  const maxAge = Number(m[1])
  if (!Number.isFinite(maxAge) || maxAge <= 0) return 0
  return Math.min(maxAge, /(^|[\s,])immutable([\s,;]|$)/.test(cc) ? immutableCap : cap)
}
