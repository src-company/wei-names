# WeiRoll deployment — atomic roll.wei handover, funded on the way in

Goal: deploy `WeiRoll` so that it **owns `roll.wei`, reverse-resolves to it, and has its first round
already open** the moment it lands — no separate handover or kick-off tx.

Unlike WeiDAO, **nothing here is load-bearing.** The constructor's name pull is best-effort: with no
pre-approval the deploy still succeeds, and you hand `roll.wei` over later with a plain transfer. The
lottery draws and pays out either way — only the `<r>.roll.wei` namespace stops. If any of the below
looks fiddly, take the boring path in §5.

## What the constructor does

```solidity
WeiRoll(address nameNFT, address weiDAO, address vrfWrapper, address steth) payable
```

1. Stores the four immutables, refusing any that is zero.
2. If `roll.wei`'s holder pre-approved this address, pulls it in and calls `setPrimaryName(roll.wei)`
   so `reverseResolve(weiRoll) == "roll.wei"`. Every step swallowed.
3. Stakes its whole balance into stETH — `msg.value` plus any stray wei already sitting at the
   address — and opens the first entry window if that leaves anything in the pot.

## 0. Addresses

| | |
|---|---|
| `NameNFT` | `0x0000000000696760E15f265e828DB644A0c242EB` |
| `WeiDAO` | `0x00000007988A79d16cf76B5dc4cF54dc3Af24936` |
| VRF v2.5 wrapper (mainnet) | `0x02aae1A04f9828517b3007f83f6181900CaD910c` |
| Lido stETH (mainnet) | `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84` |
| `roll.wei` tokenId | `0xf218d633879b71231b282e26380ab665b6d0defe8dafef3bfeac70dd46799d80` |

The wrapper address is compiled in as `PARENT`'s sibling constant — **verify it against
[Chainlink's supported networks page](https://docs.chain.link/vrf/v2-5/supported-networks) before
deploying**, and re-run the fork test (§2), which will fail loudly if the wrapper has moved.

## 1. Decide the pot

Start small. The pot is **top-up-able by anyone at any time** and compounds through forfeits, so
there is no cost to starting at a few tenths of an ETH and raising it once a couple of real rounds
have settled. It also caps what a bug — or a grinding oracle, see the re-request caveat in the
README — can reach while the contract is young.

The VRF fee is paid by whoever calls `draw`, not out of the pot, so the whole pot is prize money
however small it is. Send at least `drawPrice()` with the call — at mainnet's typical sub-gwei
basefee that is a couple of cents, since the fee scales linearly with gas price.

## 2. Rehearse on a mainnet fork

```
RUN_FORK_VRF=true forge test --match-contract ForkWeiRollVRF -vv
```

This makes a **real paid VRF request** against the live wrapper and settles the round through the
genuine coordinator → wrapper → callback path under the real `callbackGasLimit`. The wrapper swallows
a failed callback rather than reverting, so the winner assertion is what proves settlement fits.
If this fails, do not deploy.

## 3. Pre-approve (optional — skip to §5 if you'd rather not)

The address must be known before it has code, which means a deterministic deploy. Use canonical
**CreateX** CREATE3 exactly as in [DEPLOY.md](DEPLOY.md) — CREATE3 keeps the address stable if you
retune constructor args.

> **⚠️ Use a sender-protected salt — REQUIRED, not optional.** You are approving `roll.wei` to an
> address before code exists there. If anyone else could deploy there first, their contract could
> spend the approval and take the name. CreateX only prevents this when the salt's first 20 bytes
> equal the deployer address (`--caller <YOUR_DEPLOYER_EOA>`); it then reverts a deploy from any
> other sender. Never use a zero/open salt here. The safe alternative is §5.

```
cast send $NFT "approve(address,uint256)" <PREDICTED> $ROLL_WEI --rpc-url $RPC ...
```

## 4. Deploy

One command deploys, funds+stakes, and — because you hold `roll.wei` — pre-approves the mined
address and pulls the name in, all in one atomic broadcast. The script `require()`s a sender-bound
salt, so the pre-approval cannot be front-run.

```
# import your deployer key once (keystore, not a plaintext key on the CLI)
cast wallet import deployer --interactive     # paste the key that owns roll.wei

export SALT=<mined salt>            # sender-bound: first 20 bytes == your deployer
export ROLL_ADDR=<mined address>    # what SALT yields
export VALUE=$(cast to-wei 0.05ether)   # start small; 0 to launch dormant

forge script script/DeployWeiRoll.s.sol:DeployWeiRoll \
  --rpc-url <your-node> --account deployer \
  --broadcast --verify
```

The script refuses to proceed unless `ROLL_ADDR` matches the CREATE3 address for `SALT`, so a
mistyped salt/address can't misdeploy. It prints the address and the staked pot.

> Two things make `pot()` differ from what you sent: a deploy address may already hold stray ETH
> (staked along with your deposit), and Lido credits ~2 wei under 1:1. Expect a few wei either way.

Then assert the end state:

```
cast call $ROLL_ADDR "roundEnd()(uint256)"                     # non-zero: first round open
cast call $ROLL_ADDR "pot()(uint256)"                          # staked pot, in stETH
cast call $NFT "ownerOf(uint256)(address)" $ROLL_WEI           # == $ROLL_ADDR
cast call $NFT "reverseResolve(address)(string)" $ROLL_ADDR    # == "roll.wei"
```

## 5. Boring path (no pre-approval, no vanity)

If you'd rather not mine or pre-approve: deploy plain, then transfer `roll.wei` in afterward. The
contract only checks `ownerOf(PARENT) == address(this)` at claim time, so a later transfer works
identically — you lose only the reverse record (`setPrimaryName` runs only in the constructor).

```
forge create src/WeiRoll.sol:WeiRoll --constructor-args $NFT $DAO $WRAPPER $STETH \
  --value 0.05ether --rpc-url <your-node> --account deployer --verify
cast send $NFT "transferFrom(address,address,uint256)" $YOU <ROLL> $ROLL_WEI --account deployer ...
```

## 6. Hand funding to governance## 6. Hand funding to governance

Ongoing top-ups should come from WeiDAO, as an ordinary proposal with `value` set and empty calldata:

```
propose(target = $ROLL, value = <amount>, data = "", description = "fund the roll")
```

No allowlisting, no registration — the contract takes ETH from anyone and a top-up mid-round does not
extend the window.

## Running it

Nothing needs an operator. For the record, the whole loop is:

| Who | When | Call |
|---|---|---|
| holders | while `roundEnd` is in the future | `enter(tokenId, boostPid)` |
| anyone | once `block.timestamp >= roundEnd` | `draw{value: drawPrice()}()` |
| Chainlink | ~13 min later (64 confirmations) | callback settles the round |
| the winner | within `CLAIM_WINDOW` (30 days) | `claim(r)` |
| anyone | if that window lapses | `rollOver(r)` — returns the prize to the pot and reopens |
| anyone | if a request is never fulfilled | `resetRequest()` after 3 days, then `draw()` again |

A round that can't settle — under two tickets, or a pot too thin for the VRF fee — **reopens itself**
rather than reverting, so the contract can't be wedged with entries shut and no way forward.

## Keeping the namespace alive

`roll.wei` needs renewing (0.01 ETH/yr at the current 4-char tier; expires **2027-08-19**). This is
deliberately *not* in the contract: `NameNFT.renew` has no ownership check, so anyone can pay it —

```
cast send $NFT "renew(uint256)" $ROLL_WEI --value 0.01ether ...
```

Badge holders have their own reason to: `NameNFT` blocks transfers of inactive names, so a lapsed
`roll.wei` freezes every `<label>.<r>.roll.wei` under it. Governance can also renew by proposal.
