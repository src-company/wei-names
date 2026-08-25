<p align="center">
  <img src="./wns-icon.svg" alt="WNS" width="64" height="64">
</p>

# Wei Name Service (WNS)

A simple namespace on Ethereum named after the smallest unit of ether.

**Contract:** [`0x0000000000696760E15f265e828DB644A0c242EB`](https://etherscan.io/address/0x0000000000696760E15f265e828DB644A0c242EB) (Ethereum Mainnet)

**Subdomain Registrar:** [`0x53745292f0d30d68204a63002C17bDa16C772bf7`](https://etherscan.io/address/0x53745292f0d30d68204a63002C17bDa16C772bf7)

**Gateway:** [`wei.domains`](https://wei.domains) - resolves `name.wei.domains` to IPFS content

**Dapp:** [`wei.domains`](https://wei.domains) (hosted via IPFS)

**Integrating? / AI agents:** [`skills/wns/SKILL.md`](skills/wns/SKILL.md) — a single-file, copy-paste guide to resolving, registering, and serving `.wei` names (ENS-compatible, zero deps). Installable as a Claude Code plugin: `/plugin marketplace add src-company/wei-names` then `/plugin install wns@wei-names`.

---

## Overview

WNS provides `.wei` names as NFTs (ERC-721). Names can:
- Resolve to an Ethereum address (receive payments)
- Host a website via IPFS contenthash
- Have unlimited free subdomains
- Store multi-coin addresses and text records (ENS-compatible resolver)
- Display as your wallet's identity (reverse resolution)

The contract is a single, non-upgradeable Solidity file (`NameNFT.sol`) that combines ERC-721 ownership, registration logic, and resolver functionality.

- **Solidity:** `^0.8.30`
- **License:** MIT

---

## Architecture

### Inheritance

```
NameNFT
  ├── ERC721        (solady)   — gas-optimized NFT
  ├── Ownable       (solady)   — admin access control
  └── ReentrancyGuard (soledge) — reentrancy protection
```

### Token ID = Namehash

Token IDs are computed as `uint256(namehash)`, following the ENS namehash algorithm (EIP-137).

```
namehash("") = bytes32(0)
namehash("wei") = keccak256(abi.encodePacked(namehash(""), keccak256("wei")))
namehash("alice.wei") = keccak256(abi.encodePacked(namehash("wei"), keccak256("alice")))
namehash("sub.alice.wei") = keccak256(abi.encodePacked(namehash("alice.wei"), keccak256("sub")))
```

The precomputed constant:
```
WEI_NODE = namehash("wei")
         = keccak256(abi.encodePacked(bytes32(0), keccak256("wei")))
         = 0xa82820059d5df798546bcc2985157a77c3eef25eba9ba01899927333efacbd6f
```

**JavaScript example:**
```javascript
import { ethers } from 'ethers';

const WEI_NODE = '0xa82820059d5df798546bcc2985157a77c3eef25eba9ba01899927333efacbd6f';

function computeTokenId(label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return BigInt(ethers.keccak256(ethers.concat([WEI_NODE, labelHash])));
}

function computeSubdomainId(label, parentId) {
  const parentNode = ethers.zeroPadValue(ethers.toBeHex(parentId), 32);
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return BigInt(ethers.keccak256(ethers.concat([parentNode, labelHash])));
}
```

---

## Constants

| Constant | Value | Description |
|---|---|---|
| `WEI_NODE` | `0xa828...bd6f` | Namehash of "wei" TLD |
| `MAX_LABEL_LENGTH` | 255 bytes | Maximum label byte length |
| `MIN_LABEL_LENGTH` | 1 byte | Minimum label byte length |
| `MIN_COMMITMENT_AGE` | 60 seconds | Minimum wait before reveal |
| `MAX_COMMITMENT_AGE` | 86400 seconds (24h) | Commitment expiration |
| `REGISTRATION_PERIOD` | 365 days | Duration of one registration |
| `GRACE_PERIOD` | 90 days | Post-expiry renewal window |
| `MAX_SUBDOMAIN_DEPTH` | 10 | Maximum nesting of subdomains |
| `COIN_TYPE_ETH` | 60 | SLIP-44 coin type for ETH |
| `MAX_PREMIUM_CAP` | 10,000 ETH | Admin cap on premium setting |
| `MAX_DECAY_PERIOD` | 3,650 days | Admin cap on decay period setting |
| `DEFAULT_FEE` | 0.001 ETH | Initial default registration fee |

---

## Constructor

```solidity
constructor() payable {
    _initializeOwner(tx.origin);
    defaultFee = DEFAULT_FEE;       // 0.001 ether
    maxPremium = 100 ether;
    premiumDecayPeriod = 21 days;
}
```

**Note:** Owner is set to `tx.origin`, not `msg.sender`. This is intentional for deployment via `CREATE2` factory patterns where `msg.sender` would be the factory contract. The owner controls fee settings and ETH withdrawal.

---

## Name Lifecycle

### 1. Registration (Commit-Reveal)

A two-step commit-reveal pattern prevents frontrunning:

1. **Commit** — Submit `keccak256(abi.encode(normalizedLabel, owner, secret))` on-chain. The commitment uses the *normalized* label bytes (ASCII lowercased), not the raw input.
2. **Wait** — At least 60 seconds (`MIN_COMMITMENT_AGE`).
3. **Reveal** — Submit the label, secret, and payment. The commitment must be no older than 24 hours (`MAX_COMMITMENT_AGE`).

The commitment is deleted after a successful reveal. An expired commitment (>24h) can be overwritten by a new `commit()`.

**Off-chain commitment computation:**
```javascript
// IMPORTANT: normalize the label the same way the contract does (lowercase ASCII)
const normalized = label.toLowerCase(); // for ASCII-only labels
const commitment = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes', 'address', 'bytes32'],
    [ethers.toUtf8Bytes(normalized), ownerAddress, secret]
  )
);
```

### 2. Active Period

- Registration lasts **365 days** from the time of reveal.
- The name is **active** while `block.timestamp <= expiresAt`.
- While active: transfers, resolver writes, and resolution all work.

### 3. Expiry + Grace Period

- After `expiresAt`, the name enters a **90-day grace period**.
- During grace: the name is **not active** — transfers are blocked, resolver reads return empty, resolver writes revert.
- During grace: **renewal is allowed** and extends from the original `expiresAt` (not from current time).
- Anyone can call `renew()` for any name (not restricted to the owner).

### 4. Full Expiration

- After `expiresAt + GRACE_PERIOD`, the name is fully expired.
- It can be re-registered by anyone through a new commit-reveal cycle.
- Re-registration increments the `epoch`, invalidating all existing subdomains.
- Re-registration increments `recordVersion`, clearing all resolver data.

### 5. Premium Pricing (Dutch Auction)

Immediately after a name fully expires (grace period ends), a premium is charged on top of the base fee. The premium starts at `maxPremium` (default: 100 ETH) and decays linearly to 0 over `premiumDecayPeriod` (default: 21 days).

```
premium = maxPremium * (premiumDecayPeriod - elapsed) / premiumDecayPeriod
```

Where `elapsed` is seconds since `expiresAt + GRACE_PERIOD`. After the decay period, premium is 0.

---

## Fee Structure

### Defaults at Deployment

The contract deploys with `defaultFee = 0.001 ETH` for all label lengths. No length-specific fees are set at deployment.

### Admin-Configurable Fees

The owner can set per-length fees via `setLengthFees()`. When a length-specific fee is set, it overrides the default. The owner can also change the default fee.

```
getFee(length):
  if lengthFeeSet[length] → return lengthFees[length]
  else → return defaultFee
```

The fee is determined by `bytes(label).length` (UTF-8 byte length, not character count). For example, an emoji label may be 4 bytes despite being 1 "character".

### Renewal Fee

Renewal costs the same as the base registration fee for that label length. No premium is charged on renewal.

---

## Subdomains

### Registration

- Parent owner calls `registerSubdomain(label, parentId)` or `registerSubdomainFor(label, parentId, to)`.
- Subdomains are **free** (no fee).
- Subdomains have **no independent expiry** — they are active as long as the parent chain is active.
- Maximum nesting depth: 10 levels below the top-level name.

### Epoch-Based Invalidation

Each name record has an `epoch` counter. When a subdomain is created, it stores `parentEpoch` — the parent's epoch at creation time. A subdomain is considered **stale** (inactive) if its `parentEpoch` does not match the parent's current `epoch`.

This happens when:
- The parent name expires and is re-registered (epoch increments).
- The parent owner reclaims the subdomain via `registerSubdomain()` (burns the old token, mints a new one with incremented epoch).

Stale subdomains:
- Return empty strings from resolver reads.
- Show `[Invalid]` in `tokenURI`.
- Cannot be transferred (blocked by `_isActive` check in `_beforeTokenTransfer`).

### Reclaim

The parent owner can always call `registerSubdomain()` with an existing subdomain label. This burns the old token (clearing the previous owner's holding), increments the epoch, and mints a fresh token to the parent owner. The previous owner's `primaryName` is cleared if it pointed to the reclaimed token.

**Note:** `isAvailable()` returns `false` for active subdomains, even though the parent owner can overwrite them. Parent owners should call `registerSubdomain()` directly — it will succeed for reclaim regardless of `isAvailable()` result.

---

## Record Versioning

Each token has a `recordVersion` counter. All resolver data (address, contenthash, multi-coin addresses, text records) is keyed by `(tokenId, recordVersion)`. When a name is re-registered after expiry, `recordVersion` is incremented, effectively clearing all previous resolver data without paying gas to delete storage.

---

## Resolution

### Forward Resolution

```
resolve(tokenId):
  if name is not active → return address(0)
  if explicit address is set → return that address
  else → return ownerOf(tokenId)
```

The fallback to `ownerOf` means a freshly registered name resolves to its owner by default.

### Reverse Resolution

Users set a **primary name** via `setPrimaryName(tokenId)`. The caller must be the token owner or the address that the token resolves to.

```
reverseResolve(addr):
  if primaryName[addr] is 0, or name is not active, or resolve(tokenId) != addr → return ""
  else → return "label.wei" (or "sub.label.wei" etc.)
```

Setting `primaryName` to `tokenId = 0` clears the primary name.

### Multi-Coin Addresses

`setAddrForCoin(tokenId, coinType, addr)` stores addresses for any SLIP-44 coin type. For coin type 60 (ETH), the `addr()` function first checks the explicit coin address, then falls back to `resolve()`.

### Text Records

Standard key-value text records via `setText` / `text`. Common keys: `avatar`, `url`, `description`, `com.twitter`, `com.github`, etc.

### Contenthash

`setContenthash` / `contenthash` for IPFS/Swarm/etc. content addressing. Used by the gateway (`wei.domains`) to serve websites.

---

## Normalization & Validation

### On-Chain Validation (`_validateAndNormalize`)

The contract enforces:
- Label byte length: 1–255 bytes
- Valid UTF-8 encoding (rejects invalid sequences, overlong encodings, surrogates, codepoints above U+10FFFF)
- No control characters (0x00–0x1F), space (0x20), dot (0x2E), or DEL (0x7F)
- No leading or trailing hyphens
- ASCII A–Z is lowercased to a–z

The contract does **not** perform Unicode normalization (NFC/NFD), confusable detection, or script restriction. These are delegated to the client layer.

### Off-Chain Normalization (ENSIP-15)

For proper Unicode safety, callers SHOULD pre-normalize labels using [ENSIP-15](https://docs.ens.domains/ensip/15/) via the `@adraffy/ens-normalize` library before calling the contract.

```javascript
import { ens_normalize } from '@adraffy/ens-normalize';

function normalizeLabel(label) {
  try {
    const normalized = ens_normalize(label);
    if (normalized.includes('.')) return null; // No dots in labels
    return normalized;
  } catch (e) {
    return null; // Invalid (confusables, invisible chars, etc.)
  }
}
```

### Why Client-Side Normalization

1. **Future-proof** — Normalization standards evolve (ENSIP-15 replaced ENSIP-1, Unicode updates yearly). On-chain rules would be frozen or require expensive upgrades.
2. **Ecosystem alignment** — ENS, DNS, and other naming systems handle normalization at the application layer.
3. **International support** — Overly restrictive on-chain validation could block legitimate international names.
4. **Gas efficiency** — Full Unicode normalization tables are impractical on-chain.

### Helper Functions

- `normalize(label)` — On-chain validation + ASCII lowercasing. Reverts on invalid input.
- `isAsciiLabel(label)` — Returns `true` if label is pure ASCII. If true, on-chain normalization is sufficient.
- `computeNamehash(fullName)` — Computes namehash for a full name (e.g., `"sub.name"` or `"sub.name.wei"`). Lowercases ASCII but does not validate label characters (no UTF-8 check, no hyphen rules). Does reject empty labels (leading/trailing/consecutive dots). Strips `.wei` suffix if present.
- `computeId(fullName)` — Returns `uint256(computeNamehash(fullName))`.

---

## Access Control

| Function | Access |
|---|---|
| `commit` | Anyone |
| `reveal` | Anyone (must match commitment owner) |
| `registerSubdomain` / `registerSubdomainFor` | Parent token owner only |
| `renew` | Anyone (for any name) |
| `setAddr`, `setContenthash`, `setAddrForCoin`, `setText` | Token owner only |
| `setPrimaryName` | Token owner or resolved address |
| `setDefaultFee`, `setLengthFees`, `clearLengthFee`, `setPremiumSettings` | Contract owner only |
| `withdraw` | Contract owner only |

---

## Transfer Restrictions

The `_beforeTokenTransfer` hook blocks transfers of **inactive** tokens. A token is inactive when:
- Top-level name: `block.timestamp > expiresAt` (after expiry, including during grace period)
- Subdomain: parent epoch mismatch, or parent chain is inactive

Mint (`from == address(0)`) and burn (`to == address(0)`) are always allowed regardless of active status.

---

## Security Properties

### Reentrancy Protection

The following functions have the `nonReentrant` modifier:
- `reveal` — uses `_safeMint` which calls `onERC721Received` on contract recipients
- `registerSubdomain` / `registerSubdomainFor` — also uses `_safeMint`
- `renew` — sends ETH refund
- `withdraw` — sends ETH

### Refund Handling

`reveal` and `renew` refund excess ETH to `msg.sender` via `SafeTransferLib.safeTransferETH`. If the caller cannot receive ETH (e.g., a contract without a `receive` function), the transaction reverts.

### Frontrunning Protection

The commit-reveal scheme requires a 60-second minimum delay between commit and reveal, preventing miners/searchers from observing a reveal transaction and frontrunning it.

### Primary Name Cleanup

When a name is re-registered or a subdomain is reclaimed, if the previous owner's `primaryName` pointed to that token, it is deleted.

---

## Contract Interface

### Read Functions

```solidity
// Registration helpers
function makeCommitment(string label, address owner, bytes32 secret) pure returns (bytes32)
function isAvailable(string label, uint256 parentId) view returns (bool)
function getFee(uint256 length) view returns (uint256)
function getPremium(uint256 tokenId) view returns (uint256)
function normalize(string label) pure returns (string)
function isAsciiLabel(string label) pure returns (bool)

// Lookup
function computeId(string fullName) pure returns (uint256)
function computeNamehash(string fullName) pure returns (bytes32)
function getFullName(uint256 tokenId) view returns (string)

// Expiration
function expiresAt(uint256 tokenId) view returns (uint256)
function isExpired(uint256 tokenId) view returns (bool)     // true after expiresAt + GRACE_PERIOD
function inGracePeriod(uint256 tokenId) view returns (bool) // true between expiresAt and expiresAt + GRACE_PERIOD

// Resolution (uint256 tokenId overloads)
function resolve(uint256 tokenId) view returns (address)
function reverseResolve(address addr) view returns (string)
function contenthash(uint256 tokenId) view returns (bytes)
function text(uint256 tokenId, string key) view returns (string)
function addr(uint256 tokenId, uint256 coinType) view returns (bytes)

// Resolution (bytes32 node overloads — ENS-compatible)
function addr(bytes32 node) view returns (address)
function addr(bytes32 node, uint256 coinType) view returns (bytes)
function text(bytes32 node, string key) view returns (string)
function contenthash(bytes32 node) view returns (bytes)

// ERC-165
function supportsInterface(bytes4 interfaceId) view returns (bool)
// Supported: ERC-721, ERC-165, addr(bytes32) [0x3b3b57de], addr(bytes32,uint256) [0xf1cb7e06],
//            text [0x59d1d43c], contenthash [0xbc1c58d1]

// ERC-721 read functions
function name() pure returns (string)             // "Wei Name Service"
function symbol() pure returns (string)           // "WEI"
function tokenURI(uint256 tokenId) view returns (string)
function ownerOf(uint256 tokenId) view returns (address)
function balanceOf(address owner) view returns (uint256)
function getApproved(uint256 tokenId) view returns (address)
function isApprovedForAll(address owner, address operator) view returns (bool)

// Storage accessors (auto-generated)
function records(uint256 tokenId) view returns (string label, uint256 parent, uint64 expiresAt, uint64 epoch, uint64 parentEpoch)
function recordVersion(uint256 tokenId) view returns (uint256)
function commitments(bytes32) view returns (uint256)
function primaryName(address) view returns (uint256)
function defaultFee() view returns (uint256)
function maxPremium() view returns (uint256)
function premiumDecayPeriod() view returns (uint256)
function lengthFees(uint256) view returns (uint256)
function lengthFeeSet(uint256) view returns (bool)
function WEI_NODE() view returns (bytes32)
```

### Write Functions

```solidity
// Commit-reveal registration
function commit(bytes32 commitment)
function reveal(string label, bytes32 secret) payable returns (uint256 tokenId)

// Subdomains
function registerSubdomain(string label, uint256 parentId) returns (uint256 tokenId)
function registerSubdomainFor(string label, uint256 parentId, address to) returns (uint256 tokenId)

// Renewal
function renew(uint256 tokenId) payable

// Resolver writes (token owner only)
function setAddr(uint256 tokenId, address addr)
function setContenthash(uint256 tokenId, bytes hash)
function setAddrForCoin(uint256 tokenId, uint256 coinType, bytes addr)
function setText(uint256 tokenId, string key, string value)

// Reverse resolution
function setPrimaryName(uint256 tokenId)

// Admin (contract owner only)
function setDefaultFee(uint256 fee)
function setLengthFees(uint256[] lengths, uint256[] fees)
function clearLengthFee(uint256 length)
function setPremiumSettings(uint256 maxPremium, uint256 decayPeriod)
function withdraw()

// Standard ERC-721
function transferFrom(address from, address to, uint256 tokenId)
function safeTransferFrom(address from, address to, uint256 tokenId)
function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)
function approve(address to, uint256 tokenId)
function setApprovalForAll(address operator, bool approved)
```

---

## Events

```solidity
// Registration
event NameRegistered(uint256 indexed tokenId, string label, address indexed owner, uint256 expiresAt)
event SubdomainRegistered(uint256 indexed tokenId, uint256 indexed parentId, string label)
event NameRenewed(uint256 indexed tokenId, uint256 newExpiresAt)
event PrimaryNameSet(address indexed addr, uint256 indexed tokenId)
event Committed(bytes32 indexed commitment, address indexed committer)

// ENS-compatible resolver events
event AddrChanged(bytes32 indexed node, address addr)
event ContenthashChanged(bytes32 indexed node, bytes contenthash)
event AddressChanged(bytes32 indexed node, uint256 coinType, bytes addr)
event TextChanged(bytes32 indexed node, string indexed key, string value)

// Admin
event DefaultFeeChanged(uint256 fee)
event LengthFeeChanged(uint256 indexed length, uint256 fee)
event LengthFeeCleared(uint256 indexed length)
event PremiumSettingsChanged(uint256 maxPremium, uint256 decayPeriod)
```

---

## Custom Errors

| Error | Condition |
|---|---|
| `Expired()` | Operation requires active name but name is expired/inactive |
| `TooDeep()` | Subdomain nesting exceeds `MAX_SUBDOMAIN_DEPTH` (10) |
| `EmptyLabel()` | Label is empty or name contains consecutive dots |
| `InvalidName()` | Label contains invalid characters or fails validation |
| `InvalidLength()` | Label byte length outside 1–255 range |
| `LengthMismatch()` | `setLengthFees` called with mismatched array lengths |
| `NotParentOwner()` | Subdomain registration attempted by non-parent-owner |
| `PremiumTooHigh()` | Admin tried to set premium > 10,000 ETH |
| `InsufficientFee()` | `msg.value` less than required fee + premium |
| `AlreadyCommitted()` | Commitment already exists and hasn't expired |
| `CommitmentTooNew()` | Reveal attempted before `MIN_COMMITMENT_AGE` (60s) |
| `CommitmentTooOld()` | Reveal attempted after `MAX_COMMITMENT_AGE` (24h) |
| `AlreadyRegistered()` | Top-level name still active or in grace period |
| `CommitmentNotFound()` | No matching commitment on-chain |
| `DecayPeriodTooLong()` | Admin tried to set decay period > 3,650 days |

The contract also uses inherited errors:
- `Unauthorized()` (from Ownable) — used in `setAddr`, `setContenthash`, `setAddrForCoin`, `setText`, `setPrimaryName`, and `renew` (subdomains cannot be renewed)
- `TokenDoesNotExist()` (from ERC721) — used in `tokenURI` and `renew` when the token has no record

---

## Storage Layout

```solidity
// Fee configuration
uint256 public defaultFee;
uint256 public maxPremium;
uint256 public premiumDecayPeriod;
mapping(uint256 => uint256) public lengthFees;
mapping(uint256 => bool) public lengthFeeSet;

// Name records
mapping(uint256 => NameRecord) public records;   // tokenId → record
mapping(uint256 => uint256) public recordVersion; // tokenId → version (increments on re-registration)

// Commitments
mapping(bytes32 => uint256) public commitments;   // commitment hash → timestamp

// Reverse resolution
mapping(address => uint256) public primaryName;   // address → tokenId

// Versioned resolver data (keyed by tokenId, recordVersion)
mapping(uint256 => mapping(uint256 => address)) internal _resolvedAddress;
mapping(uint256 => mapping(uint256 => bytes)) internal _contenthash;
mapping(uint256 => mapping(uint256 => mapping(uint256 => bytes))) internal _coinAddr;
mapping(uint256 => mapping(uint256 => mapping(string => string))) internal _text;

struct NameRecord {
    string label;        // Normalized label (ASCII lowercased)
    uint256 parent;      // Parent token ID (0 for top-level)
    uint64 expiresAt;    // Expiry timestamp (0 for subdomains)
    uint64 epoch;        // Increments on re-registration
    uint64 parentEpoch;  // Parent's epoch at time of subdomain creation
}
```

---

## IPFS Contenthash

To host a website at `name.wei.domains`:

1. Pin your site to IPFS (Pinata, web3.storage, etc.)
2. Get the CID (`Qm...` or `baf...`)
3. Call `setContenthash(tokenId, encodedHash)`

**Encoding:**
```javascript
// Contenthash = 0xe3 (IPFS namespace) + CID bytes
function encodeContenthash(cid) {
  let cidBytes;
  if (cid.startsWith('Qm')) {
    // CIDv0 -> CIDv1
    cidBytes = new Uint8Array([0x01, 0x70, ...base58Decode(cid)]);
  } else if (cid.startsWith('baf')) {
    // CIDv1 base32
    cidBytes = base32Decode(cid.slice(1));
  }
  return ethers.concat(['0xe3', cidBytes]);
}
```

---

## Gateway (wei.domains)

The Cloudflare Worker at `wei.domains`:

1. Extracts name from subdomain (`name.wei.domains`)
2. Queries contract for contenthash
3. Decodes CID and fetches from IPFS
4. Serves content with caching

**Root domain** (`wei.domains`) resolves to `wns.wei` (the official dapp).

---

## Verification Tool

The official dapp includes a "verify name" helper:
- Enter a token ID (from OpenSea URL, etc.)
- See the actual on-chain name and byte representation
- Check ENSIP-15 normalization status
- Compare against an expected name

Useful for secondary market purchases or inspecting unfamiliar names.

---

## Multicall

For efficient batching, use Multicall3:

```javascript
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const results = await multicall.aggregate3([
  { target: WNS, callData: encodeFunctionData('isAvailable', [name, 0]) },
  { target: WNS, callData: encodeFunctionData('getFee', [byteLength]) },
  { target: WNS, callData: encodeFunctionData('getPremium', [tokenId]) }
]);
```

---

## Best Practices for Integrators

1. **Normalize input** with ENSIP-15 before registration (same as ENS)
2. **Use the verification tool** or compute expected token IDs when buying on secondary markets
3. **Display normalization warnings** for names that don't pass ENSIP-15
4. **Link to the official dapp** (`wei.domains/#name`) for name lookups
5. **Check `isActive` state** before displaying resolver data — expired names return empty from all resolver reads
6. **Handle refund failures** — if your contract calls `reveal` or `renew`, ensure it can receive ETH refunds

---

## Governance (WeiDAO)

`WeiDAO.sol` is a conviction-voting DAO + treasury built entirely on WNS primitives, deployed to Ethereum mainnet. Named in homage to Wei Dai. Solady-only (`accounts/Receiver`, `utils/Multicallable`, `utils/LibString`, `utils/SSTORE2`); no Merkle tree, no off-chain indexer, no server — treasury, proposals, roles, and even the frontend are read and rendered live on-chain. It is designed to own `NameNFT`, so the withdrawal fees and every `onlyOwner` setter become governable.

### Deployment (Ethereum Mainnet)

| | |
|---|---|
| **WeiDAO** | [`0x00000007988A79d16cf76B5dc4cF54dc3Af24936`](https://etherscan.io/address/0x00000007988a79d16cf76b5dc4cf54dc3af24936#code) (verified) |
| Parent name | `dao.wei` — owned by the DAO, reverse-resolves to it |
| `veto.dao.wei` / `exec.dao.wei` | [`0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`](https://etherscan.io/address/0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2) — timelocked multisig |
| `alpha` | `999998853923940000` — 7-day conviction half-life |
| `threshold` | `159446457364257519435776` — ≈10% of live WNS weight sustained one half-life passes |
| `proposalFee` | `0.002 ETH` |
| `executionDelay` | `3 days` — the veto-window floor |

The DAO pulls `dao.wei` in and mints both role subdomains to the multisig **atomically in the constructor** on deploy (via a pre-approval + CreateX CREATE3 — see [ops/DEPLOY.md](ops/DEPLOY.md)).

### Conviction voting

You `support(id, tokenId)` a proposal with a name you own; its *conviction* accrues over time from the weight backing it and decays when support is withdrawn:

```
conviction' = conviction · α^Δ  +  supportWeight · (1 − α^Δ) / (1 − α)
```

A proposal executes once `conviction ≥ threshold`. Because conviction starts at 0 and needs *sustained* support, freshly-minted weight has ~no effect — the ramp itself is the flash-mint defence and the warning window. One support per name (transfer-safe). Support-only: opposition is withholding/withdrawing support, or the veto.

**Calibration (7-day half-life):** `alpha = 999998853923940000` (= `round(2^(-1/604800)·1e18)`). With `threshold = convictionMax(W_req)/2` (where `convictionMax(w) = w·1e18/(1e18−alpha)`), a proposal holding sustained weight `W_req` passes in exactly one half-life.

### Weight = ETH contributed to WNS

```
weightOf(name) = getFee(byteLength(label)) × (expiresAt − now) / 365 days
```
Weight tracks the two things that cost ETH in WNS: the **length fee tier** (short = pricier = more weight) and the **paid-ahead runway** (renewing boosts weight; a near-expiry name is nudged to renew). Subdomains cost no ETH → 0 weight, so they can't be spam-minted for votes. Active top-level names only.

### Roles are WNS subdomains of `dao.wei`

Two roles are resolved **live** from names under the DAO's parent `dao.wei`, so holding the name *is* holding the role and handing it off is just an NFT transfer:

| Role name | Power |
|---|---|
| `veto.dao.wei` | Its holder may `veto(id)` any not-yet-executed proposal (negative power only). |
| `exec.dao.wei` | **God-mode operator**: veto, **force-`execute` bypassing conviction**, and call the DAO's admin setters directly. |

The `exec` role is meant as a **launch multisig** that can rescue WNS if a bug appears — e.g. force-execute `NameNFT.transferOwnership(safe)` — then be relinquished by transferring/burning `exec.dao.wei` to progressively decentralise.

Because subdomains lapse when their parent expires or is re-registered, both roles **auto-lapse if `dao.wei` isn't maintained** — a dead-man's-switch (`vetoer()`/`executor()` return `address(0)`). Role resolution is activity-aware, so a stale/expired role never retains power.

### On-chain dapp (ERC-8244)

`html()` returns the DAO's entire frontend as a self-contained HTML page, rendered live from chain state — treasury, knobs, roles, and recent proposals with their conviction and descriptions — with an inlined vanilla-JS wallet bridge for connect / support / unsupport / execute / propose. Because the DAO owns `dao.wei`, the name resolves to the contract, so an ERC-8244 / ERC-4804 (`resolveMode` + `request`) gateway renders the dapp at `dao.wei` with no server. The page is a governable shell (`setHtml`), and the large CSS/JS blobs live in SSTORE2 data contracts to keep runtime under EIP-170.

### Setup

Constructor: `WeiDAO(nameNFT, alpha, threshold, proposalFee, executionDelay, roleHolder)`. The intended deploy uses CreateX CREATE3 for a deterministic vanity address, pre-approved for `dao.wei`, so the constructor **pulls `dao.wei` in, sets the DAO's primary name, and mints `veto.dao.wei` / `exec.dao.wei` to `roleHolder` — all in one transaction** (the role mints are mandatory once the pull succeeds, so a deploy can't launch without its backstop). Runbook, calibration, and a mainnet-fork rehearsal are in [`ops/`](ops/): [DEPLOY.md](ops/DEPLOY.md), [LAUNCH.md](ops/LAUNCH.md).

The final step hands WNS to governance: `NameNFT.transferOwnership(weiDAO)` from the current owner. After that, WNS admin (fee schedule, `withdraw`, ownership) runs through a passed proposal or `exec.rescue` — and exec can always reclaim ownership while the role is held. The role/parent names are **hardcoded namehash constants** (`PROPOSAL_PARENT`, `VETO_ROLE`, `EXEC_ROLE` for `dao.wei` / `veto.dao.wei` / `exec.dao.wei`).

### Adjustable knobs

`nft` and the role/parent namehashes are immutable. `alpha`, `threshold`, `proposalFee`, and `executionDelay` (the timelock floor, capped at 30 days) are adjustable by **governance (a passed proposal) or the executor**. `threshold` in particular should rise as participation grows — re-run [`ops/weight_scan.py`](ops/weight_scan.py) to recalibrate against the live book.

### Names as identity — proposals *are* a namespace

While the DAO holds `dao.wei`, **every proposal atomically mints `<id>.dao.wei` to the DAO and writes its description into that name's resolver** — governance becomes a browsable, resolvable WNS namespace (add a contenthash record and each proposal name can serve a page via the wei.domains gateway). A proposer must hold a WNS **primary name** (`reverseResolve`), and `propose` emits it, so feeds read as `alice.wei proposed …`.

### Caveats

Support-only (no explicit "against"). Weight is captured at `support` time along with the name's epoch and expiry; a transferred name stays valid, but once its supported runway elapses or the name is re-registered, anyone may prune it. Roles are recognised only while the DAO owns the active `dao.wei`, so a lapse-and-re-register can't hand them to a new parent owner. The fixed-point `α^Δ` is differential-tested against an independent exp/ln to ~1 ppm and analysed in [ops/MATH_REVIEW.md](ops/MATH_REVIEW.md). The `exec` god-mode key is fully trusted until relinquished.

---

## Lottery (WeiRoll)

`WeiRoll.sol` is an **ownerless** ETH lottery for `.wei` holders, funded by WeiDAO and drawn with **Chainlink VRF v2.5**. There is no owner, no admin and no withdrawal: value leaves only as a prize or as the VRF fee. It runs itself — an empty pot means no round, ETH arriving opens one, and settling pays the whole pot out and stops until the next funding. No keeper, no schedule.

### The pot is staked

ETH sent here is submitted to **Lido** on arrival, so a pot waiting out a round earns and anyone can watch it grow. Everything owed is denominated in **shares**, not stETH:

```
reservedShares          shares owed to drawn-but-unclaimed rounds
pot()                   getPooledEthByShares(sharesOf(this) − reservedShares)
prizeSharesOf(r)        a settled round's claim, fixed
prizeOf(r)              what that claim is worth in stETH today
```

Shares are what a rebase holds constant, so a prize **keeps earning while it waits to be claimed**, and `transferShares` sidesteps the 1–2 wei rounding stETH puts on `transfer` — measured at 2 wei on the live contract. `draw` never touches Lido: its fee comes from the caller and goes straight to Chainlink, so a paused or rate-limited staking queue can stall *funding* but never a *settlement*.

The constructor stakes its whole balance rather than just `msg.value`, which sweeps in any stray wei already sitting at the deploy address (there was 0.000577 ETH at the one the fork test lands on). `stake()` is a permissionless no-op sweeper for the one case `receive()` cannot catch — a forced `selfdestruct` transfer, which runs no code.

**Lido is a dependency this contract cannot be rescued from**, and the prize is stETH rather than ETH: it traded near 0.94 in June 2022, so a prize can lose ETH value between draw and claim.

### Entries — an opt-in registry, because WNS isn't enumerable

Token IDs are namehashes and `NameNFT` implements no `ERC721Enumerable`, so "the set of holders" doesn't exist on-chain to index into. Holders opt in per round with `enter(tokenId, boostPid)`, which checks ownership and eligibility live. That registry *is* the candidate set — no snapshot, no Merkle root, no indexer, nothing to trust.

### Odds = the same weight governance uses

```
weightOf(name) = getFee(byteLength(label)) × (expiresAt − now) / 365 days
```

Identical to `WeiDAO.weightOf`: current cost-to-hold for the remaining runway. Odds are proportional to it, which makes a draw **EV-equivalent to a pro-rata airdrop** — just lumpier, and paid in one transfer instead of N. Flat one-name-one-ticket isn't viable: at the 0.001 ETH default fee, odds would be for sale at 0.001 ETH each. Subdomains cost no ETH, weigh 0, and are excluded, exactly as in governance.

Tickets are stored as **cumulative** weights, so the winner is the first ticket whose running total exceeds a uniform draw — a binary search in the callback rather than a loop that could run out of gas.

### Rounds are names

While the contract holds `roll.wei`, claiming writes the round into the namespace:

```
roll.wei  →  7.roll.wei  →  alice.7.roll.wei
```

`7.roll.wei` is kept by the contract, resolves to the winner, and carries the winning label and prize in its text records. `alice.7.roll.wei` goes to the claimer. Giving every round its own parent is what makes repeat wins work — `alice.7` and `alice.12` never collide, so nothing is ever overwritten. That matters: `NameNFT` lets a parent owner **re-register its own subdomains**, which would burn a badge its holder already has. Naming is a swallowed self-call and can never block a payout.

### Winners hold names, not addresses

A draw records a **tokenId**. `claim` pays whoever *holds* that name — that's the whole test. **Selling** it forfeits to the buyer, by design. **Lapsing** doesn't: `NameNFT` freezes an inactive name's transfers, so a winner whose name drifts into grace still holds it and still claims, and the 90-day grace exceeds the 30-day claim window, so no one can re-register it in time to claim in their place.

### The DAO boost is a bond, not a snapshot

`enter` takes an optional `boostPid`. If the name backs that proposal and the proposal is still **open**, the ticket weighs `BOOST_BPS` more. `claim` re-checks the backing, so support-enter-unsupport buys better odds on an unclaimable prize. Only the *backing* is re-checked, never the proposal's state — a boosted entrant is never punished for the thing they backed passing. Requiring the proposal to be open is what keeps this about current governance: support left on a long-settled proposal can't buy odds forever.

### Randomness

| | |
|---|---|
| Source | Chainlink VRF v2.5, **direct funding**, paid in native ETH |
| Wrapper | [`0x02aae1A04f9828517b3007f83f6181900CaD910c`](https://etherscan.io/address/0x02aae1a04f9828517b3007f83f6181900cad910c) |
| `requestConfirmations` | `64` — two epochs, Ethereum's finality bound |
| `callbackGasLimit` | `200_000` (measured 123k at 64 tickets, +~2.1k per doubling) |
| Cost per draw | paid by whoever calls `draw`, not from the pot — send at least `drawPrice()` |

Direct funding rather than a subscription: there is no subscription to underfund and stall on, and no subscription owner — the role at the centre of the [2022 VRF v2 critical report](https://blog.chain.link/smart-contract-research-case-study/). Confirmations are set to **64** rather than Chainlink's floor of 3 because a reorg that moves the request into a different block re-rolls the seed; past finality no reorg can change it. Confirmations aren't priced, so this costs ~13 minutes on a 30-day round and nothing in fees.

Against Chainlink's [VRF security checklist](https://docs.chain.link/vrf/v2-5/security): inputs halt **before** the request, not at it (entries close at `roundEnd`, which is strictly before `draw` is callable); only one request is ever in flight, so out-of-order fulfilment can't apply; the callback does a binary search and seven writes and nothing else.

**One documented deviation.** Chainlink states that *any* re-request of randomness is incorrect use, because it lets someone discard a result they dislike. `resetRequest` re-requests after `REQUEST_TIMEOUT` (3 days). It's kept because this contract is ownerless with no withdrawal: an undelivered request with no retry would strand the pot **permanently**. Nothing can be discarded — the reset only fires when no result was ever delivered and no participant has seen one. The residual is that whoever controls fulfilment could withhold, or starve the callback of gas, to force a fresh draw: one roll per three days, each burning another VRF fee from the pot. That takes a malicious DON, which is the same adversary that would otherwise brick the contract outright. A grindable lottery beats a bricked one.

### Reading it from a dapp

Every stage is drivable from views alone — no event indexing needed for the live screen.

| Call | Gives you |
|---|---|
| `state()` | one struct: `phase`, `round`, `roundEnd`, `pot`, `reserved`, `tickets`, `totalWeight`, `requestId`, `resetAt`, `drawPrice`, `resets`, `drawSettles`, `naming` — stETH-denominated |
| `phase()` | `Idle` (waiting on funding) · `Open` (entries) · `Ready` (`draw` callable) · `Drawing` (seed in flight) |
| `roundInfo(r)` | one struct per round: tickets, weight, winner, boost, prize, `claimBy`, `roundName`, `trophy`, `settled`, `resolved` |
| `weightIn(r, tokenId)` | a name's own ticket weight — over `totalWeight(r)` for its odds |
| `canClaim(r, who)` | whether `claim` would succeed right now, for the button's enabled state |
| `ticketsIn(r, offset, limit)` | a page of the field, clamped rather than reverting past the end |
| `drawSettles()` | whether `draw` would settle or merely reopen the round |
| `roundName(r)` | the id `<r>.roll.wei` will have, computable before it is minted |

`drawPrice()` is quoted off `tx.gasprice`, which is `0` in an `eth_call` — send a realistic gas price or treat it as a floor. `resolved` covers both a claim and a forfeit; the `Claimed` and `RolledOver` events tell them apart. Views never revert on missing names: `canClaim` answers `false` and `state().naming` reports whether `roll.wei` is held.

### Setup

Constructor: `WeiRoll(nameNFT, weiDAO, vrfWrapper, steth)`, `payable`. Every dependency is checked non-zero — an ownerless contract has no way back from a mistyped one. Pre-approve the address the deploy will land at for `roll.wei` and the constructor **pulls it in and sets its primary name**, so the contract reverse-resolves to `roll.wei` — the same handover trick WeiDAO uses for `dao.wei`. Send ETH with the deploy and the first round opens in the same transaction. Unlike WeiDAO, **none of it is load-bearing**: with no approval the deploy still succeeds and the name can be transferred in later, and the lottery runs without it — only naming stops. Runbook: [ops/ROLL.md](ops/ROLL.md).

WeiDAO funds it with an ordinary proposal targeting the contract with a `value` and empty calldata. Anyone may top it up the same way at any time; a top-up mid-round does not extend the window.

### Caveats

Weight is snapshotted at `enter` and drifts down as runway burns — normally by at most one `ROUND_LENGTH`, but a round that keeps reopening for want of tickets or funding carries its tickets with it, so the drift is bounded only by how long funding takes to arrive. A ticket whose name lapses meanwhile keeps its odds and can't claim if drawn; the prize rolls over. Nobody profits from that, but it wastes a round. Odds track the **current** fee schedule, which WeiDAO governs: raising a length tier lifts the odds of everyone already holding that length without their paying anything — the same caveat WeiDAO carries for voting weight. (Buying odds stays fairly priced: weight is linear in the fee you'd pay today, so registering or renewing never beats its cost.) The boost is available to anyone willing to back a proposal and pay the gas, so it confers no edge — it doesn't differentiate so much as tax the unengaged, which is the safe failure mode. A name whose supported runway elapses makes its DAO position prunable by anyone, so a boosted winner in that state must re-`support` before claiming. `NameNFT` blocks transfers of inactive names, so a lapsed `roll.wei` freezes every badge under it — renewal is left outside the contract because `renew` is permissionless and badge holders are motivated. `draw` is permissionless and its caller pays the VRF fee out of their own pocket, so the pot is entirely prize money. There's no keeper reward, but every entrant has one waiting for them — and the caller picks the moment, so they pick what the fee costs.

---

## Audits

AI-assisted audits performed on the codebase:

| Audit | Scope | Findings | Status |
|---|---|---|---|
| [Plainshift AI](audit/plainshift.md) | NameNFT, SubdomainRegistrar | 1 High, 1 Medium | All fixed |
| [Cantina Apex](audit/cantina.md) | NameNFT, Dapp | 3 Medium | All patched |
| [Zellic V12](audit/zellic/weinames_findings_2026-03-08-findings.md) | NameNFT, SubdomainRegistrar | 1 Medium, 1 Low | Both invalid |
| [WeiRoll AI](audit/weiroll.md) | WeiRoll | 1 High, 3 Med (fixed) + late-draw (accepted) | Fixed / accepted |
| [WeiDAO AI](audit/weidao.md) | WeiDAO | 2 Med, 2 Low (all gov/operational) | No code bug |
| [ConvictionVeto AI](audit/convictionveto.md) | ConvictionVeto | 2 Med (griefing, exec-recoverable) | No theft |

**Plainshift AI** found two valid SubdomainRegistrar issues: subdomain hijacking via missing `isAvailable` check (High), and stale escrow controller enabling NFT theft via epoch mismatch (Medium). Both were fixed in the redeployed SubdomainRegistrar.

**Cantina Apex** found three valid dapp/integration issues: XSS via unescaped name in `innerHTML`, router commit-reveal frontrunning, and refund misdirection through router. All were patched in the dapp and zRouter. NameNFT contract was not affected. (SubdomainRegistrar not included.)

**Zellic V12** reported two findings on SubdomainRegistrar, both self-invalidated: flash mode `transferFrom` does not trigger `onERC721Received` (incorrect premise), and `tx.origin` in constructor is intentional for CREATE2/CREATE3 deployment.

**WeiRoll** has had three AI-assisted review passes ([ops-style writeup](audit/weiroll.md)) and no formal audit. The second raised the NameNFT integration surface as the highest-value place to look, and following that pointer found a real bug: a round that could not settle used to carry its entries forward, so a ticket could outlive the name that bought it. Once that name lapsed past its 90-day grace, anyone could re-register it — returning under the very same tokenId, since IDs are namehashes — and claim on the ticket its previous holder had paid for. The fix was to delete the cause rather than check for it: an unsettleable round is now abandoned and a fresh one opened, so no ticket outlives its round.

That bug was in WeiRoll, not NameNFT — NameNFT behaved as designed. The lesson generalises: NameNFT's own audits do not cover WeiRoll's *assumptions about* it, so each one is pinned by a test — the namehash identity against `computeId`, the `records` decode against `WeiDAO.weightOf`, the epoch bump on re-registration, grace exceeding the claim window, subdomains weighing zero, a parent's power to overwrite its own subdomains, `ownerOf` reverting on unregistered names, permissionless `renew`, and inactive names being untransferable. Its VRF integration is exercised end-to-end against the live mainnet wrapper in [test/ForkWeiRollVRF.t.sol](test/ForkWeiRollVRF.t.sol), which makes a real paid request and settles through the genuine coordinator→wrapper→callback path under the real gas limit. Start the pot small regardless.

**WeiDAO** was hardened across several independent AI-assisted review passes (one recorded in [ops/AUDIT.md](ops/AUDIT.md)) plus a fixed-point precision analysis ([ops/MATH_REVIEW.md](ops/MATH_REVIEW.md)) and a mainnet-fork deploy rehearsal ([test/ForkDeploySim.t.sol](test/ForkDeploySim.t.sol)). The one serious finding — role seizure via a re-registered `dao.wei` — was fixed and regression-tested; a machine-checked pass on `_pow`/`_accrue` is still recommended before large treasury value.

---

## Links

- **Dapp:** https://wei.domains
- **Contract:** https://etherscan.io/address/0x0000000000696760E15f265e828DB644A0c242EB
- **Subdomain Registrar:** https://etherscan.io/address/0x53745292f0d30d68204a63002C17bDa16C772bf7
- **OpenSea:** https://opensea.io/collection/wei-name-service
- **ENSIP-15:** https://docs.ens.domains/ensip/15/
- **ens-normalize:** https://github.com/adraffy/ens-normalize.js
