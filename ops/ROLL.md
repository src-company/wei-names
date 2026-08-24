# WeiRoll deployment — atomic roll.wei handover, funded on the way in

Goal: deploy `WeiRoll` so that it **owns `roll.wei`, reverse-resolves to it, and has its first round
already open** the moment it lands — no separate handover or kick-off tx.

Unlike WeiDAO, **nothing here is load-bearing.** The constructor's name pull is best-effort: with no
pre-approval the deploy still succeeds, and you hand `roll.wei` over later with a plain transfer. The
lottery draws and pays out either way — only the `<r>.roll.wei` namespace stops. If any of the below
looks fiddly, take the boring path in §5.

## What the constructor does

```solidity
WeiRoll(address nameNFT, address weiDAO, address vrfWrapper) payable
```

1. Stores the three immutables.
2. If `roll.wei`'s holder pre-approved this address, pulls it in and calls `setPrimaryName(roll.wei)`
   so `reverseResolve(weiRoll) == "roll.wei"`. Every step swallowed.
3. Opens the first entry window **if** `msg.value > 0`.

## 0. Addresses

| | |
|---|---|
| `NameNFT` | `0x0000000000696760E15f265e828DB644A0c242EB` |
| `WeiDAO` | `0x00000007988A79d16cf76B5dc4cF54dc3Af24936` |
| VRF v2.5 wrapper (mainnet) | `0x02aae1A04f9828517b3007f83f6181900CaD910c` |
| `roll.wei` tokenId | `0xf218d633879b71231b282e26380ab665b6d0defe8dafef3bfeac70dd46799d80` |

The wrapper address is compiled in as `PARENT`'s sibling constant — **verify it against
[Chainlink's supported networks page](https://docs.chain.link/vrf/v2-5/supported-networks) before
deploying**, and re-run the fork test (§2), which will fail loudly if the wrapper has moved.

## 1. Decide the pot

Start small. The pot is **top-up-able by anyone at any time** and compounds through forfeits, so
there is no cost to starting at a few tenths of an ETH and raising it once a couple of real rounds
have settled. It also caps what a bug — or a grinding oracle, see the re-request caveat in the
README — can reach while the contract is young.

Each `draw` burns a VRF fee from the pot (~0.0075 ETH at 20 gwei), so a pot in the low hundredths of
an ETH is mostly fee. Keep it comfortably above that.

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

## 4. Deploy with value

```
forge create src/WeiRoll.sol:WeiRoll \
  --constructor-args $NFT $DAO $WRAPPER \
  --value 0.25ether --rpc-url $RPC --verify ...
```

(Or the CreateX CREATE3 call with the mined salt and the same args, per [DEPLOY.md](DEPLOY.md).)

Then assert the end state:

```
cast call $ROLL "roundEnd()(uint256)"          # non-zero: first round is open
cast call $ROLL "pot()(uint256)"               # what you funded
cast call $NFT  "ownerOf(uint256)(address)" $ROLL_WEI          # == $ROLL
cast call $NFT  "reverseResolve(address)(string)" $ROLL         # == "roll.wei"
```

If `ownerOf` is not the contract, the pull didn't happen — that's fine, do §5.

## 5. The boring path (no pre-approval)

Deploy first, verify the address, then hand the name over and fund it:

```
cast send $NFT  "transferFrom(address,address,uint256)" $YOU $ROLL $ROLL_WEI ...
cast send $ROLL --value 0.25ether ...
```

`roll.wei` arriving after deployment works identically — the contract only ever checks
`ownerOf(PARENT) == address(this)` at claim time. The one thing you lose is the primary name: the
constructor is the only place `setPrimaryName` is called, so `reverseResolve` stays unset. Cosmetic.

## 6. Hand funding to governance

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
| anyone | once `block.timestamp >= roundEnd` | `draw()` |
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
