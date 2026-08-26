// Unit tests for the cache primitives. `TtlCache.get` takes `now` explicitly,
// so expiry is tested by passing a later clock rather than by sleeping.

import { TtlCache, singleFlight, parseCacheControl } from './cache.js'

let pass = 0
let fail = 0
function eq(label, got, want) {
  const g = typeof got === 'object' ? JSON.stringify(got) : got
  const w = typeof want === 'object' ? JSON.stringify(want) : want
  if (g === w) {
    pass++
    console.log('ok   ', label)
  } else {
    fail++
    console.log('FAIL ', label, '\n  got ', g, '\n  want', w)
  }
}

// --- TtlCache: expiry --------------------------------------------------------

const c = new TtlCache({ maxEntries: 3 })
c.set('a', 1, { expires: 1000 })
eq('hit before expiry', c.get('a', 999), 1)
eq('miss at expiry', c.get('a', 1000), undefined)
eq('expired entry is dropped, not kept', c.size, 0)

// This is the Rule 3 corollary in miniature: once past its TTL an entry is
// gone, so there is nothing for a failing RPC path to fall back onto.
c.set('b', 'body', { expires: 500 })
eq('expired entry is not a fallback', c.get('b', 100000), undefined)

// --- TtlCache: LRU eviction --------------------------------------------------

const lru = new TtlCache({ maxEntries: 3 })
for (const k of ['a', 'b', 'c']) lru.set(k, k, { expires: Infinity })
lru.get('a', 0) // touch 'a' so 'b' becomes the oldest
lru.set('d', 'd', { expires: Infinity })
eq('LRU keeps the touched entry', lru.get('a', 0), 'a')
eq('LRU evicts the least recently used', lru.get('b', 0), undefined)
eq('LRU keeps the newest', lru.get('d', 0), 'd')
eq('LRU respects maxEntries', lru.size, 3)

// --- TtlCache: byte budget ---------------------------------------------------

const bytes = new TtlCache({ maxEntries: 100, maxBytes: 1000 })
bytes.set('x', 'x', { expires: Infinity, size: 600 })
bytes.set('y', 'y', { expires: Infinity, size: 600 })
eq('byte budget evicts to fit', bytes.get('x', 0), undefined)
eq('byte budget keeps the newcomer', bytes.get('y', 0), 'y')
eq('byte accounting is exact', bytes.bytes, 600)

// An entry bigger than the whole budget must not evict everything for nothing.
bytes.set('huge', 'huge', { expires: Infinity, size: 5000 })
eq('oversized entry is not cached', bytes.get('huge', 0), undefined)
eq('oversized entry did not evict the rest', bytes.get('y', 0), 'y')

// Overwriting a key must not double-count its bytes.
const rebound = new TtlCache({ maxEntries: 10, maxBytes: 1000 })
rebound.set('k', 1, { expires: Infinity, size: 100 })
rebound.set('k', 2, { expires: Infinity, size: 300 })
eq('overwrite replaces the value', rebound.get('k', 0), 2)
eq('overwrite replaces the byte count', rebound.bytes, 300)

// --- singleFlight ------------------------------------------------------------

const inflight = new Map()
let runs = 0
let release
const gate = new Promise((r) => (release = r))
const started = Array.from({ length: 10 }, () =>
  singleFlight(inflight, 'k', async () => {
    runs++
    await gate
    return 'once'
  }),
)
eq('single-flight: one runner for 10 callers', runs, 1)
release()
eq('single-flight: all callers get the result', (await Promise.all(started)).join(','), Array(10).fill('once').join(','))
eq('single-flight: key released after settle', inflight.has('k'), false)

// A later call is a fresh run, not a replay of the finished one.
await singleFlight(inflight, 'k', async () => {
  runs++
  return 'again'
})
eq('single-flight: does not memoize past the call', runs, 2)

// Failures are shared too, so a broken upstream is hit once per herd, not
// once per caller.
let failRuns = 0
const failers = Array.from({ length: 5 }, () =>
  singleFlight(inflight, 'boom', async () => {
    failRuns++
    throw new Error('nope')
  }).then(
    () => 'resolved',
    (e) => e.message,
  ),
)
eq('single-flight: one run for a failing herd', failRuns, 1)
eq('single-flight: every caller sees the error', (await Promise.all(failers)).join(','), Array(5).fill('nope').join(','))
eq('single-flight: failed key released', inflight.has('boom'), false)

// --- parseCacheControl -------------------------------------------------------

eq('max-age', parseCacheControl('public, max-age=300'), 300)
eq('immutable gets the longer cap', parseCacheControl('public, max-age=31536000, immutable'), 86_400)
eq('plain max-age is capped', parseCacheControl('public, max-age=31536000'), 3600)
eq('no-store is not cacheable', parseCacheControl('no-store'), 0)
eq('no-cache is not cacheable', parseCacheControl('public, no-cache'), 0)
eq('private is not cacheable', parseCacheControl('private, max-age=600'), 0)
eq('max-age=0 is not cacheable', parseCacheControl('public, max-age=0'), 0)
eq('missing max-age is not cacheable', parseCacheControl('public'), 0)
eq('empty is not cacheable', parseCacheControl(''), 0)
eq('undefined is not cacheable', parseCacheControl(undefined), 0)
eq('case-insensitive', parseCacheControl('PUBLIC, MAX-AGE=120'), 120)
eq('quoted value', parseCacheControl('max-age="60"'), 60)
// `immutable` must be its own token — a directive that merely contains the
// word must not unlock the longer cap.
eq('not-immutable does not match', parseCacheControl('max-age=31536000, x-immutable-ish'), 3600)

// --- per-group byte cap ------------------------------------------------------
//
// A 5219 contract is handed the path and query, so one address can legitimately
// occupy unboundedly many keys. The cap keeps that fan-out from evicting the
// names next to it.

{
  const c = new TtlCache({ maxBytes: 1000, maxGroupBytes: 300 })
  const far = Date.now() + 60_000
  c.set('other|/', 'neighbour', { expires: far, size: 100, group: 'other' })
  // One address floods with distinct URLs, well past its own share.
  for (let i = 0; i < 20; i++) {
    c.set(`hog|/?x=${i}`, 'page' + i, { expires: far, size: 100, group: 'hog' })
  }
  eq('group cap: the hog is held to its share', c.groupSize('hog') <= 300, true)
  eq('group cap: the neighbour survives the flood', c.get('other|/', Date.now()), 'neighbour')
  eq('group cap: the hog keeps its newest', c.get('hog|/?x=19', Date.now()), 'page19')
  eq('group cap: the hog loses its oldest', c.get('hog|/?x=0', Date.now()), undefined)
  eq('group cap: total stays under the whole budget', c.bytes <= 1000, true)
}

{
  // Freeing a group's entries must free its accounting too, or the cap leaks
  // shut and the address can never cache again.
  const c = new TtlCache({ maxBytes: 1000, maxGroupBytes: 200 })
  const now = Date.now()
  c.set('a|1', 'x', { expires: now + 10, size: 100, group: 'a' })
  eq('group cap: counted while held', c.groupSize('a'), 100)
  c.get('a|1', now + 50) // expired -> dropped
  eq('group cap: expiry releases the group budget', c.groupSize('a'), 0)
  c.set('a|2', 'y', { expires: now + 60_000, size: 100, group: 'a' })
  eq('group cap: the address can cache again', c.get('a|2', now), 'y')
}

{
  // An ungrouped entry keeps working exactly as before.
  const c = new TtlCache({ maxBytes: 1000, maxGroupBytes: 100 })
  const far = Date.now() + 60_000
  c.set('plain', 'v', { expires: far, size: 500 })
  eq('group cap: ungrouped entries are unaffected', c.get('plain', Date.now()), 'v')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
