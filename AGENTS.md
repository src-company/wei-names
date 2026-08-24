# AGENTS.md

Guidance for AI agents working **in this repository**. (To *integrate* WNS from
elsewhere, read [`skills/wns/SKILL.md`](skills/wns/SKILL.md) instead — this file
is about developing wei-names itself.)

## Layout

- `src/` — Solidity contracts. `NameNFT.sol` is the whole system (ERC-721 +
  registrar + ENS-compatible resolver, single non-upgradeable file).
  `SubdomainRegistrar.sol`, `WeiDAO.sol` alongside it.
- `test/`, `script/` — Foundry tests and deploy scripts.
- `gateway/` — the `*.wei.limo` / `.wei.is` / `.wei.domains` HTTP gateway.
  Zero-dependency ESM; `handler.js` is runtime-agnostic, wrapped by `worker.js`
  (Cloudflare) and `server.js` (Node/Render). Serves IPFS/IPNS contenthashes and
  contract pages read straight from chain (`onchain.js`: ERC-5219 `request()`,
  ERC-8244 `html()`), plus `0x<address>.<zone>` labels that skip WNS.
- `dapp/` — static client-side app (no build step; vendored bundles committed,
  `#hash` routing). Served at wei.domains and pinned on IPFS.
- `skills/` — integration skill(s) for external agents/devs.
- Deploy config: `render.yaml` (Render), `gateway/wrangler.toml` (Cloudflare).

## Build, test, verify

**Contracts** (Foundry, solc 0.8.34, `via_ir`, optimizer 20 runs):
```bash
forge build
forge test            # fork tests hit public RPCs; each file uses a different endpoint
forge snapshot        # update .gas-snapshot after gas-affecting changes
```

**Gateway** (Node ≥18, zero deps):
```bash
cd gateway && npm test        # contenthash + ERC-5219 codecs, handler e2e (no network)
node live-check.mjs zswap.wei.limo   # same handler, against live mainnet
node server.js                # run locally (GET/HEAD only)
```

**Dapp**: no build — open `dapp/index.html` (or serve the folder). It's static.
```bash
npm run test:dapp    # wallet connect paths + roll.wei panel / token-id parsing
```
Both suites lift functions straight out of the shipping source (`index.html`,
`wallet.js`) into a `vm` sandbox with a DOM shim — no network, no chain, no deps
beyond the vendored ethers. Rename a function they cover and they fail loudly
rather than silently testing nothing.

## Conventions

- **Commits:** terse, lower-case, `area: summary` (e.g. `gateway: fix …`,
  `dapp: …`, `docs: …`). No AI attribution or co-author trailers.
- **Contracts are non-upgradeable and deployed.** Treat `src/NameNFT.sol` as a
  spec of live mainnet behavior; changes there don't affect the deployed
  contract at `0x0000000000696760E15f265e828DB644A0c242EB`. Keep `README.md`'s
  ABI/behavior tables in sync with the source.
- **Gateway edits** must stay dependency-free and work under both `worker.js`
  and `server.js`. `handler.js` takes a Web `Request` and returns a `Response`.
- **The `ZONE` env var and the `render.yaml` `domains:` list must agree** — a
  zone only resolves if it's both served by the handler and has a wildcard cert.
  Same for `SUBDOMAIN_PARENTS` and the `*.<parent>.<zone>` entries: a parent not
  listed there 404s before any RPC, which is deliberate (a `Host` header is free
  to forge, so unreachable hosts must not cost `eth_calls`).
- **Never cache a contract page longer than its own `Cache-Control`.** The
  contract decides, not the gateway, and an expired entry is never a fallback
  when RPC fails — that stays a `502`. See `cache.js`.
- Prefer `redirect` gateway mode for per-CID origin isolation; `proxy` keeps the
  name in the URL bar but runs untrusted content same-site with the zone.

## Deploy

Push to `main` — Render auto-deploys the blueprint (`wei-dapp` static site +
`wns-gateway` Node service). Cloudflare Worker deploys via `wrangler deploy`
from `gateway/`.
