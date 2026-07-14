# wei.limo wildcard gateway

Serve every `.wei` name at `<name>.wei.limo`, driven entirely by an on-chain
lookup against the WNS contract. **No per-name DNS records** — one wildcard
`*.wei.limo` record points here and the gateway resolves each request live.

```
GET alice.wei.limo
  ├─ eth_call WNS.computeId("alice.wei")      -> tokenId
  ├─ eth_call WNS.contenthash(tokenId)        -> 0xe301…/0xe501…  (EIP-1577)
  ├─ decode contenthash                        -> bafy… (IPFS) or k51… (IPNS)
  └─ 302  https://bafy….ipfs.dweb.link/        (default) — or proxy the bytes
         https://k51….ipns.dweb.link/          (IPNS → .ipns. gateway)
```

A newly registered `.wei` name works **instantly**, with zero provisioning.
Unregistered / expired names, and names without a contenthash, return `404`.

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
| `wns.js` | Minimal WNS read client (`computeId` + `contenthash` via `eth_call`), zero deps |
| `contenthash.js` | EIP-1577 contenthash → IPFS CIDv1 (base32) or IPNS name (base36) |
| `handler.js` | Core `handleRequest(request, env)` — runtime-agnostic Web Fetch |
| `worker.js` | Cloudflare Worker entrypoint |
| `server.js` | Node / Railway / Render entrypoint |
| `wrangler.toml` | Worker config + `*.wei.limo` route |

## Config (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `GATEWAY_MODE` | `redirect` | `redirect` (302 to a subdomain IPFS gateway, bandwidth-light) or `proxy` (stream through the gateway, keeps `<name>.wei.limo` in the URL bar) |
| `IPFS_SUBDOMAIN_GATEWAY` | `dweb.link` | Used in redirect mode → `https://<id>.<ipfs\|ipns>.<gw>` |
| `IPFS_PATH_GATEWAY` | `https://ipfs.io` | Used in proxy mode → `<gw>/<ipfs\|ipns>/<id>` |
| `RPC_URLS` | built-in list | Comma-separated mainnet RPCs with fallback |
| `WNS_CONTRACT` | mainnet WNS | Override the registry address |
| `RESERVED_LABELS` | — | Extra labels to never treat as `.wei` names (added to the built-in set) |
| `ZONE` | `wei.limo` | The apex zone this gateway serves |
| `PORT` | `8080` | Node server only |

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
npm test          # contenthash codec round-trips (IPFS + IPNS)
# decode a contenthash -> { ns, id }
node --input-type=module -e 'import {decodeContenthash} from "./contenthash.js"; console.log(decodeContenthash("0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f"))'
# live resolve a real name
node --input-type=module -e 'import {resolveContenthash} from "./wns.js"; console.log(await resolveContenthash("z0r0z"))'
```
