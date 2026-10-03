# Granular Permission Contracts for WNS Names

## Introduction

Currently, a WNS name must be comprehensively controlled by a single account.

This means the security model is limited to timelocks and multi-sigs.

This doc explores approaches to granular permissions, introduced as 2 proposals:

- [Proposal 1 - Single Beneficiary Approaches](PROPOSAL_1_SINGLE_BENEFICIARY.md)
- [Proposal 2 - Multi-Tenant Owner Approach](PROPOSAL_1_MULTI_BENEFICIARY.md)

## Core constraint: the permission contract must own the NFT

Most WNS management functions require:

```solidity
ownerOf(tokenId) == msg.sender
```

WNS does not recognize an external permission manager, an ERC-721 approved account, or an operator for resolver and subdomain-management functions.

Therefore, each proposed contract must custody the WNS NFT. The original NFT holder becomes the contract’s controller or beneficial owner, while the permission contract becomes the address returned by WNS `ownerOf(tokenId)`.

```text
Delegate
   ↓
Permission contract
   ↓ authorization check
WNS contract
```

## Shared permission model

Both proposals should use typed wrapper functions instead of a generic external-call executor.

```solidity
uint256 constant SET_ADDR               = 1 << 0;
uint256 constant SET_CONTENTHASH        = 1 << 1;
uint256 constant SET_COIN_ADDR          = 1 << 2;
uint256 constant SET_TEXT               = 1 << 3;
uint256 constant SET_VAULT_PRIMARY_NAME = 1 << 4;
uint256 constant RENEW                  = 1 << 5;
uint256 constant CREATE_SUBDOMAIN       = 1 << 6;
uint256 constant CREATE_SUBDOMAIN_FOR   = 1 << 7;
uint256 constant RECLAIM_SUBDOMAIN      = 1 << 8;
uint256 constant TRANSFER_NAME          = 1 << 9;
uint256 constant MANAGE_PERMISSIONS     = 1 << 10;
```

Each delegate receives a grant:

```solidity
struct Grant {
    uint256 permissions;
    uint48 validAfter;
    uint48 validUntil;
    uint32 policyEpoch;
}
```

A policy epoch permits all existing grants to be invalidated without iterating through every delegate:

```solidity
policyEpoch++;
```

This should occur whenever control of a name or account changes.

## Native and vault-defined primary names

### What a primary name represents

Normal WNS resolution asks:

```text
alice.wei → 0xAlice
```

Primary-name or reverse resolution asks:

```text
0xAlice → alice.wei
```

A primary name is therefore associated with an **address**, not inherently with a token ID.

Native WNS primary-name management is difficult to proxy because WNS associates the primary name with `msg.sender`.

If Alice calls through a vault:

```text
Alice → Vault → WNS.setPrimaryName(tokenId)
```

WNS sees the vault as the caller and records the name as the vault’s primary name:

```text
Vault address → alice.wei
```

It does not record:

```text
Alice address → alice.wei
```

### Vault-aware reverse registrar

Both proposals therefore maintain a secondary primary-name registry:

```solidity
mapping(address subject => uint256 tokenId)
    public vaultPrimaryToken;
```

The vault can expose:

```solidity
function setVaultPrimaryName(
    address subject,
    uint256 tokenId,
    bytes calldata authorization
) external;

function clearVaultPrimaryName(
    address subject
) external;

function vaultReverseResolve(
    address subject
) external view returns (
    uint256 tokenId,
    string memory name
);
```

The lookup is address-based:

```solidity
function vaultReverseResolve(
    address subject
) public view returns (
    uint256 tokenId,
    string memory name
) {
    tokenId = vaultPrimaryToken[subject];

    if (!_isValidVaultPrimary(subject, tokenId)) {
        return (0, "");
    }

    return (tokenId, wns.getFullName(tokenId));
}
```

Validation should require:

```solidity
function _isValidVaultPrimary(
    address subject,
    uint256 tokenId
) internal view returns (bool) {
    if (tokenId == 0) return false;
    if (!_isManaged(tokenId)) return false;
    if (!wns.isActive(tokenId)) return false;

    return wns.resolve(tokenId) == subject;
}
```

This preserves forward-confirmed reverse resolution:

```text
0xAlice selects alice.wei
alice.wei still resolves to 0xAlice
```

If the name later resolves to another address, the old primary-name record automatically becomes invalid.

### Authorization by the subject

A controller should not be able to arbitrarily claim that a name is another address’s primary name.

For example, the vault should not be able to declare:

```text
0xVictim → scam.wei
```

without authorization from `0xVictim`.

Setting a vault primary name should therefore require either:

1. `msg.sender == subject`;
2. An EIP-712 signature from `subject`; or
3. An ERC-1271 signature when `subject` is a smart-contract account.

It should additionally require:

```solidity
wns.resolve(tokenId) == subject
```

The `SET_VAULT_PRIMARY_NAME` permission allows a delegate to administer the operation, but it should not replace the subject’s consent.

For example, a relayer with this permission could submit an authorization signed by the subject.

# Approval restrictions

## `setApprovalForAll`

A WNS-level `setApprovalForAll` affects every WNS NFT owned by the calling contract.

For a multi-tenant vault, this would give the approved operator authority over every tenant’s name.

The multi-tenant vault should therefore never expose:

```solidity
wns.setApprovalForAll(operator, true);
```

The portfolio account should also avoid exposing it except, potentially, as an emergency root-controller operation.

## Token-specific `approve`

An approved address can transfer the NFT out of the permission contract, bypassing:

- Permission expirations;
- Transfer destination restrictions;
- Timelocks;
- Policy-epoch invalidation;
- Internal revocation.

Token-specific approval should therefore be treated as equivalent to withdrawal permission or omitted entirely.

Controlled transfer functions are safer than raw ERC-721 approvals.

# Subdomain permissions

WNS allows the direct parent owner to reclaim or overwrite subdomains.

Because the permission contract is the direct parent owner, it should separate:

```text
CREATE_NEW_SUBDOMAIN
RECLAIM_EXISTING_SUBDOMAIN
```

A subdomain manager may be allowed to create new names without being allowed to burn and replace existing subdomains.

Reclaiming an existing subdomain should require:

- A separate permission bit;
- A prominent event;
- Optionally, a timelock;
- Explicit handling of any primary-name association attached to the replaced child token.

If a child token is burned or replaced, its vault-defined primary record must be cleared.

# Comparison

| Model | Permission scope | Reverse-name scope | Isolation | Best use |
|---|---|---|---:|---|
| Single-name account | One name | One managed token, potentially one current subject | Highest | Valuable names and distinct teams |
| Portfolio account | All names under one policy | Multiple subjects and names in one owner’s portfolio | Medium | One organization with uniform operators |
| Multi-tenant vault | Per name and beneficial owner | Multiple unrelated subjects and names | Lowest systemic isolation | Shared permission-management protocol |

# Recommendation

All 3 solutions get built, audited, and tested on increasingly critical sets of names and all 3 enforce a shared interface for beneficial balances and lookups.

## Beneficial `balanceOf`

Because custody changes the ERC-721 owner, the underlying `nameNFT.balanceOf(voter)` no longer reflects the number of names beneficially controlled by the voter.

Under **Proposal 1, Mode A — the single-name account**, the proxy’s standard `balanceOf(address account)` view should return `1` when `account` is the account’s current controller and `0` otherwise.

Under **Proposal 1, Mode B — the single-owner portfolio account**, it should return the total number of WNS NFTs currently managed by the portfolio when `account` is the portfolio controller, and `0` for every other address.

Under **Proposal 2 — the multi-tenant vault**, it should return the number of deposited WNS NFTs whose per-name controller equals `account`.

This common interface allows voting integrations to query the beneficial balance through the permission contract rather than relying on WNS’s raw ERC-721 `balanceOf`, which would otherwise attribute every deposited name to the proxy or vault address.

## Combined native and vault-aware lookup

The permission system can expose a resolver that first checks native WNS and then falls back to the secondary registry:

```solidity
function reverseResolve(
    address subject
) external view returns (
    uint256 tokenId,
    string memory name
) {
    string memory nativeName =
        wns.reverseResolve(subject);

    if (bytes(nativeName).length != 0) {
        return (
            wns.primaryToken(subject),
            nativeName
        );
    }

    return vaultReverseResolve(subject);
}
```

The recommended lookup order is:

```text
1. Valid native WNS primary name
2. Valid vault-defined primary name
3. No primary name
```

Applications that specifically want the vault’s selection can call `vaultReverseResolve` directly.

Existing applications that only call native WNS will not automatically discover the secondary record. They must use the vault-aware resolver or a general reverse-resolution router.

# Shared Interface

A useful shared interface would expose both vault-aware reverse resolution and the number of names beneficially controlled by an address:

```solidity
interface IVaultAwareNameAccount {
    /**
     * @notice Returns the vault-defined primary name for a subject.
     * @dev Does not fall back to native WNS reverse resolution.
     */
    function vaultReverseResolve(
        address subject
    ) external view returns (
        uint256 tokenId,
        string memory name
    );

    /**
     * @notice Returns the subject's primary name.
     * @dev Checks native WNS reverse resolution first, then falls back
     *      to the vault-defined primary-name registry.
     */
    function reverseResolve(
        address subject
    ) external view returns (
        uint256 tokenId,
        string memory name
    );

    /**
     * @notice Returns the number of WNS names beneficially controlled
     *         by an account through this permission contract.
     * @dev This is distinct from WNS.balanceOf(account), which reflects
     *      ERC-721 custody and therefore assigns deposited names to the
     *      permission contract itself.
     */
    function balanceOf(
        address account
    ) external view returns (
        uint256 balance
    );
}
```

The meaning of `balanceOf` depends on the permission-contract model:

- In a **single-name account**, it returns `1` for the current controller and `0` for every other address.
- In a **single-owner portfolio account**, it returns the total number of managed WNS names for the portfolio controller and `0` for every other address.
- In a **multi-tenant vault**, it returns the number of deposited WNS names whose per-name controller is the queried address.

The architectural distinctions are:

```text
WNS resolver records belong to names.

Native WNS primary-name records belong to msg.sender.

Vault-defined primary-name records belong to explicitly authorized subjects.

WNS balanceOf reflects ERC-721 custody.

Vault balanceOf reflects beneficial control.
```

The permission contract does not alter native WNS behavior. It creates a vault-aware compatibility layer that applications can deliberately support for reverse resolution and name-based voting power.

For example, instead of relying exclusively on:

```solidity
uint256 votingPower = nameNFT.balanceOf(voter);
```

a compatible application can query the permission contract:

```solidity
uint256 votingPower = vault.balanceOf(voter);
```

This prevents voting power from being assigned only to the vault address when the underlying WNS NFTs are held in custody on behalf of their controllers.