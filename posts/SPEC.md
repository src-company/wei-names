# WNS posts

Posts are short documents (blog posts, notes, articles) published under a `.wei` name or subname.
Their text travels in EIP-4844 blobs, and a small ownerless contract records who vouched for what.
Nothing here has an operator: anyone can publish, anyone can index, and every publisher's posts
count the same.

This is a fork of [gwei-names' posts](https://github.com/lucadonnoh/gwei-names/blob/main/posts/SPEC.md)
(they forked WNS; this is the fork back). The events and the byte formats are the same, so a post
makes the same blob, the same versioned hash and the same IPFS CIDs on both name services, and a
publisher, indexer or mirror written for one works for the other with a different contract address.

wei.domains runs one publisher and one index, described at the end. Neither is special.

## Contract

`WeiPosts` ([src/WeiPosts.sol](../src/WeiPosts.sol), mainnet
[`0xDDe00Ec43095fA81d615B61e668eA8a5EF1c9Fad`](https://etherscan.io/address/0xDDe00Ec43095fA81d615B61e668eA8a5EF1c9Fad),
deployed in block 26335211) has no owner, admin or upgrades, and its only
balance is fees in escrow. It checks name ownership against NameNFT
(`0x0000000000696760E15f265e828DB644A0c242EB`) and emits events. Clients rebuild everything from
those events, so no archive state is needed.

A blob's versioned hash depends only on its bytes, and a post's blob is fixed by the post (see
[Blob format](#blob-format)). So the author computes the versioned hash before anyone publishes and
authorizes the post against it. The fee for a publisher sits in escrow until that publisher sends a
blob transaction carrying a blob with exactly that versioned hash (read on-chain with `BLOBHASH`)
and calls `publish`, which pays the fee out in the same transaction. No other blob matches, so
delivery needs no trust, challenge or proof. A fee that no publisher delivered for within a day can
be taken back.

| Function | Who | Effect |
|---|---|---|
| `authorize(tokenId, postHash, blobHash, publisher)` payable | owner of an active name | `PostAuthorized`; any fee goes into escrow for (`blobHash`, `publisher`) |
| `publish()` | anyone, in a blob transaction | `BlobPublished` for each attached blob; pays the caller the escrow held for it for those blobs |
| `post(tokenId, postHash, blobIndex)` | owner, in a blob transaction | authorize and publish at once (self-publishing) |
| `refund(blobHash, publisher)` | a payer | after `REFUND_DELAY` (1 day), returns their undelivered fee; `FeeRefunded` |
| `remove(tokenId, postHash)` | owner | `PostRemoved` |

```
event PostAuthorized(uint256 indexed tokenId, bytes32 indexed postHash, address indexed author, bytes32 blobHash, address publisher, uint256 fee);
event BlobPublished(bytes32 indexed blobHash, address indexed publisher, uint256 paid);
event FeeRefunded(bytes32 indexed blobHash, address indexed publisher, address indexed payer, uint256 amount);
event PostRemoved(uint256 indexed tokenId, bytes32 indexed postHash, address indexed author);
```

"Active" is NameNFT's `resolve(tokenId) != 0`: the name is registered and unexpired and, for a
subname, every parent is too and still in the epoch the subname was made in. A subname's owner posts
under it exactly as a top-level owner does.

Contract wallets can't send blobs, but they can still `authorize`. Paying a publisher for a blob it
already delivered reverts, so nobody pays a fee for work that is already done.

## Post format

A post is a UTF-8 JSON object, at most 126,968 bytes:

```json
{"v":1,"title":"Exploring the blobspace","body":"Markdown text…"}
```

- `v`: `1`.
- `title`: a non-empty string of at most 200 characters.
- `body`: Markdown (below).
- Clients ignore other fields, so later versions can add some (gwei-names uses `"replies": true`).

A post has no date of its own. It is dated by the block of the first blob that carries it, or by the
block of its first authorization while no blob carries it yet.

`postHash` is the keccak-256 hash of the exact bytes. Any byte change is a different post.

### Markdown

Bodies are untrusted, so clients must never render HTML from them. The gateway's renderer
([gateway/markdown.js](../gateway/markdown.js)) supports headings, paragraphs (a newline is a line
break), `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, fenced code blocks, `>` quotes, `-` and
`1.` lists, `---`, `[links](url)`, `![images](url)`, bare `https://` links, and TeX math as `$…$` and
`$$…$$`. Links may be `https`, `http`, `mailto`, `ipfs://`, a `/path` or a `#anchor`. Images may be
`https`, `ipfs://` or a base64 `data:image` URL (png, jpeg, gif, webp or svg+xml).

A `data:image` URL puts the picture inside the post, so it lives in the blob with the text and
needs nothing pinned anywhere. The dapp's editor stores attached pictures this way, resized to fit.
They share the post's 126,968 bytes with the text, and cost nothing extra, since a blob costs the
same full or not. gwei-names' renderer caps every link and image destination at 2,000 characters,
so gwei.domains currently shows a stored picture as text; `https` and `ipfs://` images render on
both.

### Images in other posts

A post is at most one blob, so a post with more pictures than fit keeps them in **image posts**:
ordinary posts whose bodies are just pictures (`data:image` URLs, about two to a blob), each
authorized by the same owner and then removed (`PostRemoved`), so no reader lists them. Their bytes
stay in their blobs. The post shows each picture by its address on the gateway:

```
https://posts.wei.domains/img/<image post hash>/<n>
```

`<n>` counts the `data:image` pictures in the image post's body from 1, in order. The gateway serves
the picture only if some owner authorized that post (an upload alone is never served), whether or not
the post is listed, and caches it for good, since a post's bytes never change. The address follows
from public data alone, so any gateway can serve the same one, and to every reader it is an ordinary
`https` image: gwei.domains and anything else that shows `https` images shows these too. The host in
an address is only a hint: a gateway that holds the image post serves the picture whatever host the
address names, and ours points every such address at its own copy. The dapp's editor does all of
this when a post's pictures outgrow it.

### Keeping the bytes

Ethereum keeps a post's fingerprint for good: its hash in `PostAuthorized`, and its blob's versioned
hash in the block. The bytes themselves ride in a blob, which ordinary nodes drop after about 18 days.
wei.domains keeps them in a private archive, a copy of the index with its own disk, and the gateway
recovers anything it lost from there first, then from Blobscan and beacon nodes, then IPFS. Every copy
is checked the same way, whoever holds it: the bytes must hash to the post, and the post must rebuild
the blob Ethereum recorded.

### Image captions

A line written directly under an image, with no blank line between them, is that image's caption:
wei.domains shows the two as a figure with the caption beneath. Anywhere else they read the same, as
the image with a line of text under it.

```
![A phone running Pokémon Emerald](https://…)
POV you are a sentient being in 2026.
```

### Embedded X posts

A link to an X post (`https://x.com/<handle>/status/<id>`, or on twitter.com) alone on its own line
is drawn on wei.domains as a card, the way X articles show one: the author, the text, any photos, and
a link to the post. Post pages run no scripts, so the gateway reads the post from X's public
syndication endpoint and writes the card itself, and keeps it for a day. The post's bytes keep only
the link, so it reads as a link anywhere else, and if X stops answering for a post (deleted, or the
endpoint is down) the card falls back to a plain link to it. The images load from X's image host.

### Cover image

An image alone on the body's first line, followed by a blank line or nothing, is the post's
**cover**: wei.domains shows it as a banner above the title, uses it as the post's thumbnail in
lists, and gives it to link previews (`og:image`; a stored cover is served at
`/posts/<id>/cover`). It needs no field of its own, so a reader that doesn't know covers shows it
as the post's first image.

```
![](data:image/webp;base64,UklGR…)

The post starts here.
```

## Blob format

A blob is 4096 field elements of 32 bytes. The first byte of each field element is `0x00` and the
other 31 carry data, which gives a 126,976-byte payload:

```
"gwei" (4 bytes) | version 0x01 | length (3 bytes, big-endian) | post bytes | length | post bytes | … | 0x000000 or end
```

The magic is `gwei` on both name services. It names the format, not the name service, and keeping it
is what makes the same post produce the same blob on both.

**A post's blob** is the container holding just that post, zero-padded. This is the blob an
authorization names, so its bytes, and therefore its versioned hash, follow from the post alone.
Self-publishers can put several posts in one container, but a post must fit in a single blob.

## Validity

A client shows a post under name `N` (token `T`) when all of these hold:

1. `PostAuthorized(T, h, author, …)` was emitted, `author` is `N`'s current owner, and `N` is
   active. A sold name doesn't carry its previous owner's posts.
2. The client has bytes whose keccak-256 is `h` and that parse as a post. It doesn't matter where
   the bytes came from: a blob, an upload, a friend.
3. There is no `PostRemoved(T, h, author)` after `author`'s latest `PostAuthorized(T, h, …)`.

A post is **in a blob** when, in addition, the blob its authorization names was published
(`BlobPublished(blobHash, …)`, by anyone) and that blob's payload contains bytes that hash to `h`.
Clients may show authorized posts that aren't in a blob yet, marked as pending. The gateway does so
for one day.

Ordinary beacon nodes drop blobs after about 18 days (4096 epochs). Indexers should fetch the blobs
that authorized posts point at well before then, and keep them. Blob archives such as
[Blobscan](https://blobscan.com) keep blobs longer, and mirrors keep posts on IPFS for good (below).

## Mirroring

A post's bytes are named by its `postHash`, so anyone can keep and serve them, and anyone can check
them against Ethereum. On IPFS:

- **A post** is a raw block whose CID is its `postHash`: CIDv1, raw codec (`0x55`), keccak-256
  multihash (`0x1b`), base32 (`bafkrwi…`). The CID follows from the `PostAuthorized` event alone.
  Kubo: `ipfs block put --cid-codec raw --mhtype keccak-256 --pin post.json`.
- **A blob** is a raw block named by its sha-256: CIDv1, raw codec, sha2-256 (`bafkrei…`), which is
  what `ipfs add --cid-version=1 --raw-leaves` gives for its 131,072 bytes.

gwei-names' [`gwei-mirror`](https://github.com/lucadonnoh/gwei-names/tree/main/mirror) pins both for
every published post. Pointed at WeiPosts and at `https://posts.wei.domains`, it mirrors `.wei` posts.

## Publishing

- **Yourself:** send a blob transaction from the name's owner, with the post's blob attached, calling
  `post(tokenId, postHash, 0)`. One transaction, no one else involved.
- **Through a publisher:** build the post's blob, compute its versioned hash, and call
  `authorize(tokenId, postHash, blobHash, publisher)` with the publisher's fee. Upload the post's
  bytes somewhere the publisher can read them. The publisher rebuilds the blob, checks the hash,
  sends it and is paid by `publish`. If it hasn't done so within a day, call `refund`. Anyone else
  can also deliver the blob, since the bytes and the authorization are public, but the escrow only
  ever pays the publisher you named.

## wei.domains

**Pages.** Every name's posts, subnames at any depth included, are at
`https://posts.wei.domains/<name>.wei/`, with a page per post at `/posts/<id>-<slug>` and an Atom
feed at `/feed.xml`. A top-level name with no website set also shows them on its own host
(`alice.wei.limo/`). A subname such as `blog.alice.wei` has no host of its own unless its parent has a
wildcard certificate, which is why the posts host serves every name by path. Post pages run no
scripts. Shared links show a 1200x630 card (the post's title and the name's generated mark), or a
post's cover when it has one.

**API.** The gateway serves its index at `https://posts.wei.domains/api`, readable from any origin:

| Request | Answer |
|---|---|
| `POST /api/posts` (body: post bytes) | `{ "hash" }`. Anyone may upload. Bytes nobody authorizes are dropped after a day. Bytes of an already-authorized hash are always accepted |
| `GET /api/posts?after=<seq>&limit=<n>` | every post found in a blob, in the order the index found them: `{ "posts", "next" }`. Pass `next` back as `after` to read on |
| `GET /api/posts/<hash>` | the post, its CID and its authorizations, each with whether its blob carries the post |
| `GET /api/posts/<hash>/raw` | the exact post bytes |
| `GET /api/names/<tokenId>/posts` | posts shown for a name, newest first |
| `GET /api/authors/<address>/paid` | fees an address put in escrow, latest per blob and publisher (for finding refunds; the contract says what is left) |
| `GET /api/posts/recent` | newest posts across all names |
| `POST /api/posts/preview` (body: post bytes) | `{ "title", "html" }` rendered by the gateway |
| `POST /api/sync` | asks the index to catch up now (at most every 10 seconds) |

The index reads the contract's events every minute. For each published blob, it checks every post
claimed for it. It first rebuilds the post's own blob from bytes it holds and compares the versioned
hash. If that doesn't match, it fetches the blob from Blobscan or a beacon node and keeps it only if
its KZG commitment matches the versioned hash. Posts carried by a blob are kept for good. Bytes that
never reach a blob expire after three days.

**Publisher.** The wei.domains publisher ([poster/](poster/)) is gwei-names' publisher pointed at
WeiPosts. It rebuilds each blob from the post's bytes (`GET /api/posts/<hash>/raw`) and checks that
its versioned hash is the one the author named. A payment counts only if it can't be refunded for at
least six more hours. The publisher sends a blob only if those payments cover sending it alone at
current prices, packs up to six blobs into one transaction, and never lets a transaction spend more
than its blobs' payments. The dapp pays three times the current cost of a one-blob transaction.
