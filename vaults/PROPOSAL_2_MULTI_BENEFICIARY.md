# Proposal 2: Multi-Tenant Name Permission Vault

*Ideal for* - A community wide deployment.

`MultiTenantNameVault` holds names for many unrelated beneficial owners.

Each name has its own controller and permission table.

```text
MultiTenantNameVault
   ├── alice.wei      → controlled by Alice
   ├── project.wei    → controlled by Project Multisig
   ├── community.wei  → controlled by Community DAO
   └── bob.wei        → controlled by Bob
```

The WNS contract sees one NFT owner—the vault—but the vault separately records control over each token.

## Suggested storage

```solidity
contract MultiTenantNameVault is IERC721Receiver {
    IWNS public immutable wns;

    struct NameState {
        address controller;
        uint32 policyEpoch;
        bool managed;
    }

    mapping(uint256 tokenId => NameState state)
        public names;

    mapping(
        uint256 tokenId =>
        mapping(address delegate => Grant grant)
    ) public grants;

    mapping(address subject => uint256 tokenId)
        public vaultPrimaryToken;

    mapping(uint256 tokenId => address subject)
        public primarySubject;
}
```

## Per-name authorization

```solidity
function _authorize(
    uint256 tokenId,
    uint256 permission
) internal view {
    NameState memory state = names[tokenId];

    if (!state.managed) revert UnknownName();

    if (msg.sender == state.controller) {
        return;
    }

    Grant memory grant =
        grants[tokenId][msg.sender];

    if (grant.policyEpoch != state.policyEpoch) {
        revert StaleGrant();
    }

    if (block.timestamp < grant.validAfter) {
        revert GrantNotStarted();
    }

    if (block.timestamp > grant.validUntil) {
        revert GrantExpired();
    }

    if (grant.permissions & permission == 0) {
        revert Unauthorized();
    }
}
```

## Example interface

```solidity
interface IMultiTenantNameVault {
    function grant(
        uint256 tokenId,
        address delegate,
        uint256 permissions,
        uint48 validAfter,
        uint48 validUntil
    ) external;

    function revoke(
        uint256 tokenId,
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

    function setAddrForCoin(
        uint256 tokenId,
        uint256 coinType,
        bytes calldata addr
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

    function vaultReverseResolve(
        address subject
    ) external view returns (
        uint256 tokenId,
        string memory name
    );

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
        string calldata label,
        address childController
    ) external returns (
        uint256 childTokenId
    );

    function createExternalSubdomain(
        uint256 parentId,
        string calldata label,
        address recipient
    ) external returns (
        uint256 childTokenId
    );

    function transferControl(
        uint256 tokenId,
        address newController
    ) external;

    function withdrawName(
        uint256 tokenId,
        address recipient
    ) external;
}
```

## Multi-tenant primary-name behavior

The shared vault can maintain independent reverse records for many users:

```text
Alice            → alice.wei
Bob              → bob.wei
ProjectMultisig  → project.wei
CommunityDAO     → community.wei
```

All four NFTs may be owned by the same vault address at the WNS level.

The vault-aware resolver distinguishes them using:

```solidity
vaultPrimaryToken[subject]
```

rather than using the vault’s own native WNS primary name.

This avoids the problem where every proxied `setPrimaryName` call would otherwise modify only:

```text
primary name of MultiTenantNameVault
```

## Setting a primary name

A primary-name request should pass all of the following checks:

```solidity
function _validatePrimaryNameRequest(
    address subject,
    uint256 tokenId,
    bytes calldata authorization
) internal view {
    if (!names[tokenId].managed) {
        revert UnknownName();
    }

    if (!wns.isActive(tokenId)) {
        revert Expired();
    }

    if (wns.resolve(tokenId) != subject) {
        revert ForwardResolutionMismatch();
    }

    if (!_isAuthorizedBySubject(
        subject,
        tokenId,
        authorization
    )) {
        revert InvalidSubjectAuthorization();
    }
}
```

The controller of the name may initiate or relay the request, but the subject should authorize being represented by that name.

## Replacing an existing selection

When a subject chooses a new primary name:

```solidity
function _setVaultPrimaryName(
    address subject,
    uint256 tokenId
) internal {
    uint256 previous =
        vaultPrimaryToken[subject];

    if (previous != 0) {
        primarySubject[previous] = address(0);
    }

    address previousSubject =
        primarySubject[tokenId];

    if (previousSubject != address(0)) {
        vaultPrimaryToken[previousSubject] = 0;
    }

    vaultPrimaryToken[subject] = tokenId;
    primarySubject[tokenId] = subject;

    emit VaultPrimaryNameSet(
        subject,
        tokenId
    );
}
```

This enforces a simple one-to-one relationship:

```text
One selected primary name per subject
One selected subject per token
```

## Changes to name control

Transferring beneficial control of a name should:

1. Increment the token’s policy epoch.
2. Invalidate all previous delegate grants.
3. Clear any vault primary-name association unless the existing subject explicitly reauthorizes it.
4. Emit a control-transfer event.

```solidity
function transferControl(
    uint256 tokenId,
    address newController
) external {
    NameState storage state = names[tokenId];

    if (msg.sender != state.controller) {
        revert Unauthorized();
    }

    address oldController = state.controller;

    state.controller = newController;
    state.policyEpoch++;

    _clearPrimaryAssociation(tokenId);

    emit ControlTransferred(
        tokenId,
        oldController,
        newController
    );
}
```

Clearing the association is conservative. An alternative is to retain the stored association but rely on forward-resolution validation. Explicit clearing is easier for users and indexers to understand.

## Withdrawing a name

When a name leaves the vault, its vault-defined primary-name association must be cleared:

```solidity
function withdrawName(
    uint256 tokenId,
    address recipient
) external {
    _authorize(tokenId, TRANSFER_NAME);

    _clearPrimaryAssociation(tokenId);
    delete names[tokenId];

    wns.safeTransferFrom(
        address(this),
        recipient,
        tokenId
    );
}
```

After withdrawal, the recipient can use native WNS primary-name functionality directly.
