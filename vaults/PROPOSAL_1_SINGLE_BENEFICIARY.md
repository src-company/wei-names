# Proposal 1: Permissioned Name Account

*Ideal for* - A single owner controls one single super critical domain.

`PermissionedNameAccount` is a custodial smart account controlled by one person, organization, DAO, or multisig.

It can be deployed in two modes.

## Mode A: One contract to one name

Each WNS name receives its own dedicated smart account.

```text
NameAccount A → alice.wei
NameAccount B → community.wei
NameAccount C → project.wei
```

### Suggested storage

```solidity
contract SingleNameAccount is IERC721Receiver {
    IWNS public immutable wns;

    uint256 public tokenId;
    address public controller;
    uint32 public policyEpoch;
    bool public initialized;

    mapping(address delegate => Grant grant)
        public grants;

    mapping(address subject => uint256 tokenId)
        public vaultPrimaryToken;
}
```

Because the account manages only one token, `vaultPrimaryToken[subject]` can only contain either zero or the account’s configured token ID.

The contract should reject all WNS NFT deposits other than its configured token.

### Example interface

```solidity
interface ISingleNameAccount {
    function grant(
        address delegate,
        uint256 permissions,
        uint48 validAfter,
        uint48 validUntil
    ) external;

    function revoke(address delegate) external;

    function setAddr(address newAddr) external;

    function setContenthash(
        bytes calldata hash
    ) external;

    function setAddrForCoin(
        uint256 coinType,
        bytes calldata addr
    ) external;

    function setText(
        string calldata key,
        string calldata value
    ) external;

    function setVaultPrimaryName(
        address subject,
        bytes calldata authorization
    ) external;

    function clearVaultPrimaryName(
        address subject
    ) external;

    function reverseResolve(
        address subject
    ) external view returns (
        uint256 tokenId,
        string memory name
    );

    function renew() external payable;

    function createManagedSubdomain(
        string calldata label,
        address newController
    ) external returns (
        uint256 childTokenId
    );

    function createExternalSubdomain(
        string calldata label,
        address recipient
    ) external returns (
        uint256 childTokenId
    );

    function releaseName(
        address recipient
    ) external;

    function transferControl(
        address newController
    ) external;
}
```

### Primary-name workflow

Suppose the account owns `alice.wei`, which resolves to Alice:

```text
WNS ownerOf(alice.wei): NameAccount
WNS resolve(alice.wei): Alice
```

Alice signs or directly submits:

```text
“Use alice.wei as my vault-defined primary name.”
```

The account records:

```text
vaultPrimaryToken[Alice] = aliceTokenId
```

Vault-aware reverse resolution then returns:

```text
Alice → alice.wei
```

even though the WNS NFT itself is owned by the account.

If `alice.wei` later resolves to Bob, the reverse record for Alice becomes invalid automatically.

### Advantages

- Maximum isolation between names.
- A compromised delegate affects only one name.
- Primary-name state is isolated to one account.
- A guardian, multisig, delay, or recovery policy can differ for each name.
- Simple reasoning about subdomains and transfers.

### Disadvantages

- One deployment per name.
- Permission changes must be repeated across accounts.
- More contracts to index and manage.
- Higher aggregate deployment costs for large portfolios.

### Deployment recommendation

Use a clone factory so each name receives an inexpensive minimal-proxy account based on one audited implementation.

## Mode B: One contract to many names with one owner and one policy

*Ideal for* - A single owner controls a portfolio of critical domains.

A `PortfolioNameAccount` holds multiple WNS NFTs controlled by the same person or organization.

```text
PortfolioNameAccount
   ├── alice.wei
   ├── project.wei
   ├── foundation.wei
   └── events.project.wei
```

All names share the same delegate permissions and parameter restrictions.

### Suggested storage

```solidity
contract PortfolioNameAccount is IERC721Receiver {
    IWNS public immutable wns;

    address public controller;
    uint32 public policyEpoch;

    mapping(uint256 tokenId => bool managed)
        public managedNames;

    mapping(address delegate => Grant grant)
        public grants;

    mapping(address subject => uint256 tokenId)
        public vaultPrimaryToken;

    mapping(uint256 tokenId => address subject)
        public primarySubject;
}
```

The reverse mapping from token ID to subject makes it easier to clear or replace stale associations.

### Example interface

```solidity
interface IPortfolioNameAccount {
    function grantPortfolioPermission(
        address delegate,
        uint256 permissions,
        uint48 validAfter,
        uint48 validUntil
    ) external;

    function revokePortfolioPermission(
        address delegate
    ) external;

    function setAddr(
        uint256 tokenId,
        address newAddr
    ) external;

    function setContenthash(
        uint256 tokenId,
        bytes calldata hash
    ) external;

    function setText(
        uint256 tokenId,
        string calldata key,
        string calldata value
    ) external;

    function setVaultPrimaryName(
        address subject,
        uint256 tokenId,
        bytes calldata authorization
    ) external;

    function clearVaultPrimaryName(
        address subject
    ) external;

    function reverseResolve(
        address subject
    ) external view returns (
        uint256 tokenId,
        string memory name
    );

    function renew(
        uint256 tokenId
    ) external payable;

    function createManagedSubdomain(
        uint256 parentId,
        string calldata label
    ) external returns (
        uint256 childTokenId
    );

    function releaseName(
        uint256 tokenId,
        address recipient
    ) external;

    function batchSetAddr(
        uint256[] calldata tokenIds,
        address newAddr
    ) external;
}
```

### Primary-name behavior

A single subject can select one managed name as its vault-defined primary name:

```text
Alice → alice.wei
```

If several portfolio names resolve to Alice:

```text
alice.wei     → Alice
founder.wei   → Alice
alicecorp.wei → Alice
```

Alice chooses one:

```solidity
vaultPrimaryToken[Alice] = aliceTokenId;
```

Selecting another replaces the previous selection.

The contract can support many subjects at once:

```text
Alice            → alice.wei
ProjectMultisig  → project.wei
FoundationDAO    → foundation.wei
```

even though all names are held by the same portfolio account.

### Advantages

- One permission change applies to the entire portfolio.
- Efficient batch record updates.
- One reverse registrar can cover every managed name.
- Lower deployment and administration costs.
- Suitable when one team manages all names under one security policy.

### Disadvantages

- A compromised delegate may affect every name.
- Per-name exceptions are difficult.
- Every name shares one controller and permission policy.
- Transfer authority has portfolio-wide significance.
