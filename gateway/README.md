# wei.limo wildcard gateway

Serve every `.wei` name at `<name>.wei.limo`, driven entirely by an on-chain
lookup against the WNS contract. **No per-name DNS records** — one wildcard
`*.wei.limo` record points here and the gateway resolves each request live.

```
GET alice.wei.limo/some/path
  ├─ eth_call WNS.computeId("alice.wei")      -> tokenId
  ├─ eth_call WNS.resolve(tokenId)            -> addr record
  ├─ eth_call addr.resolveMode()              -> ERC-4804 mode
  │    ├─ "5219"  -> eth_call addr.request(["some","path"], [?query])
  │    │             serve the returned body, status and headers  ← from chain
  │    └─ auto/manual -> 302 / proxy  https://<addr>.1.w3link.io/…
  ├─ else eth_call addr.html()                -> ERC-8244 document, served as-is
  └─ else eth_call WNS.contenthash(tokenId)   -> 0xe301…/0xe501…  (EIP-1577)
       ├─ decode contenthash                   -> bafy… (IPFS) or k51… (IPNS)
       └─ 302  https://bafy….ipfs.dweb.link/   (default) — or proxy the bytes
              https://k51….ipns.dweb.link/     (IPNS → .ipns. gateway)

GET 0x1234…cdef.wei.limo/          # an address label: skips WNS, serves that
                                   # exact contract and no other
```

A newly registered `.wei` name works **instantly**, with zero provisioning.
Unregistered / expired names, and names with neither an on-chain dapp nor a
contenthash, return `404`.

## Contract pages (ERC-5219 / ERC-8244)

Some contracts don't *point at* a page — their bytecode **is** the page. There
is nothing to mirror and nowhere to mirror it to, so the gateway calls the
contract and writes the response itself. No CID, no pin, no third party in the
path, and nothing that can drift from what the chain says.

Two interfaces, probed in this order:

| Probe | Interface | What the gateway does |
|---|---|---|
| `resolveMode() == "5219"` | ERC-5219 `request(string[] resource, KeyValue[] params)` → `(uint16 statusCode, string body, KeyValue[] headers)` | Serve the body with the contract's status, `Content-Type` and `Cache-Control`. The request path becomes `resource` and the query becomes `params`, so deep paths and raw files (`…/tokenlist.json`) work. |
| `resolveMode()` is `auto` / `manual` | ERC-4804 | Serving means translating a URL into calldata — a web3:// job. 302 / proxy to a web3:// HTTP gateway (`w3link.io`). |
| `html()` answers | ERC-8244 | Serve the string as `text/html`. One document, no paths — served at every path, the same shape as an SPA fallback. |

Both take **precedence** over an IPFS contenthash on the same name: a
contenthash can only carry the ERC-8244 *loader* HTML, which bootstraps `/` in a
browser but has no sub-paths.

`GATEWAY_MODE` doesn't apply to `5219` and `html()` pages — there is no upstream
to redirect to. Each `<label>.<zone>` is already its own origin (see
[the Public Suffix List note](#operator-note-the-public-suffix-list)).

### Address labels: `0x<40 hex>.wei.limo`

An address label serves **that exact contract**, skipping WNS entirely. This is
a deliberately different surface from a name:

| URL | serves | changes? |
|---|---|---|
| `zswap.wei.limo` | whatever the name resolves to now | yes, when the owner repoints it |
| `0x<address>.wei.limo` | that contract's bytes | never |

A reader who wants the moving target uses the name; a reader who audited a build
keeps its address and keeps getting exactly those bytes. Neither surface can be
turned into the other by anybody, including whoever holds the name.

It also costs nothing on the page side: a contract page that reads its own
address out of the first hostname label can name its own version, link a block
explorer, and point at a successor — all without leaving this gateway.

The gateway adds **no promotion delay of its own**. A contract that wants a
newly deployed version to sit unchallenged before a name points at it already
enforces that in `resolveMode()`/`request()`; a second delay here would compose
into a longer one nobody chose. Reaching a version by its own address is never
delayed, which is what keeps an urgent fix reachable while a name waits.

### Cache-Control comes from the contract

Both possible answers are correct and they are opposites, so the gateway takes
whichever the contract gives and does not second-guess it:

- an **immutable** build can say `public, max-age=31536000, immutable` and mean
  it — its bytes cannot change, so cache forever;
- a contract that **follows the chain** says something short like
  `public, max-age=300`, because its answer changes the moment the chain does.
  Cached as permanent it would serve a superseded version long after the fact.

Pages that set no `Cache-Control` (and every `html()` page, which has nowhere to
put one) get `public, max-age=300`.

Corollary: **stale is never served on RPC failure.** A `502` with `no-store` is
honest; a cached copy of a superseded page is a lie with a UI.

### Contract-authored headers are untrusted

Only `Content-Type` and `Cache-Control` survive the `request()` header array,
and both are validated (media-type shape, no control characters, length-capped).
Everything else is dropped.

Anyone can deploy a contract and point a name at it, so the header array is in
the general case attacker-authored. A page must not be able to set its own CSP,
hand out cookies, or emit a `Location` through this gateway. Responses are
always sent with `X-Content-Type-Options: nosniff`.

Status codes outside `200`–`599` become `502`; malformed ABI, an oversized body
(cap: 8 MB) or a body the contract won't return is a `404`/`502`, never a guess.

**IPFS or IPNS.** An IPFS contenthash pins a fixed site (a new CID = a new
on-chain tx). An **IPNS** contenthash points at a stable key set on-chain
**once**; the owner republishes the IPNS record off-chain on every update, so
the site changes with **no further transaction**. The gateway never resolves
IPNS itself — it hands the `k51…` name to the IPNS subdomain gateway, which
resolves it fresh per request.

## Why a wildcard, not per-name records

`.wei` names live on-chain and change (registration, contenthash updates,
expiry) without any signal to DNS. Writing a DNS record per name means an
indexer, provider API keys, and constant reconciliation. A wildcard + a
request-time `eth_call` makes the chain the single source of truth and can't
drift. It's the same model eth.limo uses for ENS.

Explicit records still win by DNS specificity, so `zfi.wei.limo`,
`api.zfi.wei.limo`, `multisig.wei.limo` etc. are **never shadowed** by the wildcard.
The gateway also keeps a `RESERVED_LABELS` guard as defense-in-depth.

## Files

| File | Role |
|------|------|
| `wns.js` | Minimal WNS read client (`computeId`, `contenthash`, `resolve` addr, ERC-4804 `resolveMode`) + the shared `ethCall` failover, zero deps |
| `onchain.js` | ERC-5219 `request()` / ERC-8244 `html()` ABI codec, header whitelist, page reads |
| `contenthash.js` | EIP-1577 contenthash → IPFS CIDv1 (base32) or IPNS name (base36) |
| `handler.js` | Core `handleRequest(request, env)` — runtime-agnostic Web Fetch |
| `worker.js` | Cloudflare Worker entrypoint |
| `server.js` | Node / Railway / Render entrypoint |
| `wrangler.toml` | Worker config + `*.wei.limo` route |

## Config (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `GATEWAY_MODE` | `redirect` | `redirect` (302 to a subdomain IPFS gateway, bandwidth-light) or `proxy` (stream through the gateway, keeps `<name>.wei.limo` in the URL bar). Does **not** apply to ERC-5219 / ERC-8244 contract pages, which are always read and written here |
| `IPFS_SUBDOMAIN_GATEWAY` | `dweb.link` | Subdomain gateway used in **both** modes → `https://<id>.<ipfs\|ipns>.<gw>`. Subdomain (not path) form so the site's `_redirects`/SPA fallback applies and deep paths like `/docs` resolve. |
| `WEB3_GATEWAY` | `w3link.io` | web3:// HTTP gateway for on-chain (ERC-4804) dapps → `https://<addr>.<chainId>.<gw>` |
| `WEB3_CHAIN_ID` | `1` | Chain id used in the web3:// gateway host (mainnet) |
| `RPC_URLS` | built-in list | Comma-separated mainnet RPCs with fallback |
| `PAGE_TIMEOUT_MS` | `15000` | Per-endpoint timeout for contract page reads (`request()` / `html()`), which return whole documents — longer than a registry lookup's `5000` |
| `WNS_CONTRACT` | mainnet WNS | Override the registry address |
| `RESERVED_LABELS` | — | Extra labels to never treat as `.wei` names (added to the built-in set) |
| `ZONE` | `wei.limo` | The apex zone this gateway serves |
| `PORT` | `8080` | Node server only |

## Operator note: the Public Suffix List

**`wei.limo`, `wei.is` and `wei.domains` are not on the [PSL](https://publicsuffix.org/)**
(checked against `public_suffix_list.dat`, 2026-08-14 — only the `limo` TLD
itself is listed, in the ICANN section). This should be fixed, and it matters
more than anything else in this file.

Subdomains already give origin separation for `localStorage`, the DOM and
`postMessage`. **Cookies do not follow the origin rule** — they follow the
*registrable domain*. Without a PSL entry, `evil.wei.limo` can set a cookie
scoped to `.wei.limo`, and `zswap.wei.limo` will send it. Since anyone can
register a `.wei` name and point it at any contract, that is a cookie-injection
path between unrelated names, and it exists whether or not the gateway serves
contract HTML. The PSL entry is what makes each name a separate *site* rather
than merely a separate host.

Submit to the list's PRIVATE section. Prefer the wildcard form:

```
// wei.limo / wei.is / wei.domains : Wei Name Service
// https://wei.domains
*.wei.limo
*.wei.is
*.wei.domains
```

The wildcard matters because of the second-level wildcards in `render.yaml`
(`*.id.wei.limo`, `*.multisig.wei.limo`, …). A plain `wei.limo` rule makes
`alice.wei.limo` its own site but leaves `id.wei.limo` as the registrable domain
for everything under it, so all `*.id.wei.limo` names would still share cookies
with each other. `*.wei.limo` makes each level a public suffix in turn, so every
served name is isolated.

## Deploy

Pick one runtime. In every case, the DNS side is a **single wildcard record**.

### A) Railway / Render / any Node host (recommended — no Cloudflare dependency)

```bash
cd gateway
npm start        # node server.js, listens on $PORT
```

DNS: add a wildcard pointing at the service, e.g.

```
*.wei.limo   CNAME   <your-service>.up.railway.app.
```

(or an `A`/`ALIAS` record to the host's IP). This works with wei.limo on its
current Namecheap zone — no migration needed. Existing app subdomains keep
their explicit records and are unaffected.

Render blueprint block (drop into `render.yaml` if you deploy there):

```yaml
  - type: web
    name: weilimo-gateway
    runtime: node
    rootDir: gateway
    plan: starter            # always-on; avoids cold starts
    buildCommand: "true"     # no build — plain ESM
    startCommand: node server.js
    healthCheckPath: /healthz
    domains:
      - "*.wei.limo"
```

### B) Cloudflare Worker

Requires wei.limo to be a Cloudflare zone. The `*.wei.limo/*` route in
`wrangler.toml` handles the wildcard; explicit routes like `api.zfi.wei.limo/*`
(zFi's existing worker) still win by specificity.

```bash
cd gateway
wrangler deploy
```

> Note: zFi previously moved **off** Cloudflare Workers after hitting the
> free-plan request cap (error 1027, see `../render.yaml`). If you go this
> route, use a paid Workers plan or keep `GATEWAY_MODE=redirect` so the Worker
> stays out of the data path.

## Local test

```bash
cd gateway
npm test          # contenthash codec, ERC-5219 codec + header whitelist,
                  # and the handler end to end against a stubbed RPC node
```

No network and no dependencies: `onchain.test.mjs` checks the ABI encoder and
decoder against fixtures generated by a real ABI coder, and `handler.test.mjs`
stubs `globalThis.fetch` with a fake mainnet so it can assert both the response
and which `eth_call`s were (and weren't) made.

Against the real chain:

```bash
# decode a contenthash -> { ns, id }
node --input-type=module -e 'import {decodeContenthash} from "./contenthash.js"; console.log(decodeContenthash("0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f"))'
# live resolve a real name
node --input-type=module -e 'import {resolveContenthash} from "./wns.js"; console.log(await resolveContenthash("z0r0z"))'
# serve a live contract page through the handler, headers and all
node live-check.mjs zswap.wei.limo
```
