# wei-poster

The wei.domains publisher for WNS posts ([../SPEC.md](../SPEC.md)). It is gwei-names'
[`gwei-poster`](https://github.com/lucadonnoh/gwei-names/tree/main/posts/poster) with our defaults:
the contract, the event log and the blob format are the same, so only `POSTER_CONTRACT` and
`POSTER_API` differ.

Authors put a fee in escrow on `WeiPosts` for the exact blob their post makes. This publisher
rebuilds that blob from the post, checks its versioned hash, delivers it, and is paid in the same
transaction. Anyone can run a publisher like this one; it has no special standing.

**Money rules.** A blob is sent only if its deposits that can't be refunded within six hours
(`SAFETY_MARGIN`) cover sending it alone at current prices (`min_fee`), so a cheap post never rides
on other posts' fees. No transaction may spend more than those deposits, replacements included
(`fee_caps`, checked again in `send`). A payment counts after 3 confirmations, and only once.
`test_poster.py` has a test for each griefing case, and its end-to-end tests check on anvil that the
publisher's balance never ends lower than it started.

**What it can still lose.** A sent transaction stays valid until it is mined. If prices stay above
its fee caps for most of a day, the publisher neither resends nor replaces it once its deposits near
their refund time, but it can still land later, after authors have taken their fees back. The most
that can cost is that one transaction's fee caps, which are at most what its blobs paid. (The dapp
pays three times the cost at quote time, so this takes a sustained price spike.)

**Needs:** a node that accepts blob transactions with Fusaka (EIP-7594) cell proofs
(`POSTER_WRAPPER_VERSION=1`, the default), a hot key with a little ETH, and somewhere to keep its
SQLite file. A batch needs its worst-case cost up front, before the posts' fees reimburse it. Fees
accumulate on the same address. The database is bound to the contract it was started for.

**Run it:** put this directory on the host, with an `.env` setting `POSTER_RPC`,
`POSTER_CONTRACT=0xDDe00Ec43095fA81d615B61e668eA8a5EF1c9Fad` and `POSTER_FROM_BLOCK=26335211`, and
optionally `POSTER_IPFS_API`, `POSTER_NTFY_URL` and `POSTER_NTFY_TOKEN_FILE=/run/secrets/ntfy-token`.

```sh
sudo install -d -m 0750 -o 10088 /etc/wei-poster /var/lib/wei-poster
docker compose build
docker compose run --rm --no-deps -v /etc/wei-poster:/keys --entrypoint python wei-poster \
  /opt/wei-poster/wei_poster.py keygen /keys/key        # prints the address; the key never leaves the file
docker compose up -d
docker compose run --rm wei-poster status
```

Then put the printed address in `POSTS_PUBLISHER` in `dapp/index.html`. wei.domains runs this as the
`wei-poster` Render worker (`render.yaml`, `start.sh`), at `0xB63Cb6f9D921C1C2639bEb587046584fcF181EDF`.

**Test:** `POSTER_TRUSTED_SETUP=trusted_setup.txt python -m unittest test_poster` (from this
directory; the end-to-end tests need anvil, cast, node and `forge build`). They run the publisher
against NameNFT and WeiPosts on a local Osaka chain, and `index_check.mjs` runs the gateway's index
(`gateway/posts.js`) over the result.
