#!/usr/bin/env python3
"""
Estimate WeiDAO's total *live voting weight* from the real WNS NameNFT on mainnet, so `threshold`
can be set from data instead of a guess.

Weight (matching WeiDAO.weightOf): for an ACTIVE TOP-LEVEL name,
    weight = getFee(byteLength(label)) * (expiresAt - now) / 365 days
Subdomains (parent != 0) and expired names count 0.

Method (Etherscan API, gracefully rate-limited):
  1. Pull every ERC-721 mint (Transfer from 0x0) via getLogs -> the set of token ids ever created.
  2. eth_call records(id) for each unique id -> current label/parent/expiry.
  3. Keep active top-level names, compute weight (getFee cached per length), and sum.
  4. Print totals + a distribution and suggested W_req / threshold values.

Usage:  ETHERSCAN_API_KEY=... python3 ops/weight_scan.py
"""

import json
import os
import time
import urllib.request
import urllib.parse

API = "https://api.etherscan.io/v2/api"
CHAIN = 1
NFT = "0x0000000000696760e15f265e828db644a0c242eb"
KEY = os.environ.get("ETHERSCAN_API_KEY", "")
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO_TOPIC = "0x" + "0" * 64
RECORDS_SEL = "0x34461067"  # records(uint256)
GETFEE_SEL = "0xfcee45f4"  # getFee(uint256)
YEAR = 365 * 24 * 3600
SCALE = 10**18

_last = [0.0]


def call(params, tries=6):
    """One rate-limited Etherscan request with backoff on rate-limit / transient errors."""
    params = {**params, "chainid": CHAIN, "apikey": KEY}
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(tries):
        gap = time.time() - _last[0]
        if gap < 0.22:  # ~4.5 req/s, under the 5/s free-tier cap
            time.sleep(0.22 - gap)
        _last[0] = time.time()
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.loads(r.read())
        except Exception as e:
            time.sleep(1.5 * (attempt + 1))
            continue
        msg = str(data.get("result", "")) + str(data.get("message", ""))
        if "rate limit" in msg.lower() or "Max calls" in msg:
            time.sleep(1.5 * (attempt + 1))
            continue
        return data
    raise RuntimeError("Etherscan request failed after retries: " + url)


def mint_token_ids():
    """All token ids ever minted (Transfer from 0x0), paged by block."""
    ids, from_block, seen_blocks = set(), 0, None
    while True:
        d = call({
            "module": "logs", "action": "getLogs", "address": NFT,
            "fromBlock": from_block, "toBlock": "latest",
            "topic0": TRANSFER, "topic0_1_opr": "and", "topic1": ZERO_TOPIC,
            "page": 1, "offset": 1000,
        })
        logs = d.get("result") or []
        if not isinstance(logs, list) or not logs:
            break
        for lg in logs:
            ids.add(int(lg["topics"][3], 16))  # tokenId is the 4th indexed topic
        last = int(logs[-1]["blockNumber"], 16)
        if len(logs) < 1000:
            break
        if last == seen_blocks:  # a single block saturated the page — nudge forward
            last += 1
        seen_blocks, from_block = last, last
    return ids


def eth_call(data):
    d = call({"module": "proxy", "action": "eth_call", "to": NFT, "data": data, "tag": "latest"})
    return d.get("result") or "0x"


def records(token_id):
    """records(id) -> (label, parent, expiresAt) or None if the token doesn't exist."""
    h = eth_call(RECORDS_SEL + f"{token_id:064x}")
    h = h[2:] if h.startswith("0x") else h
    if len(h) < 6 * 64:
        return None
    parent = int(h[64:128], 16)
    expires = int(h[128:192], 16)
    off = int(h[0:64], 16) * 2  # byte offset -> hex offset to the label
    ln = int(h[off:off + 64], 16)
    label = bytes.fromhex(h[off + 64: off + 64 + ln * 2])
    if not label:
        return None
    return label, parent, expires


_fee = {}


def get_fee(length):
    if length not in _fee:
        h = eth_call(GETFEE_SEL + f"{length:064x}")
        _fee[length] = int(h, 16) if h and h != "0x" else 0
    return _fee[length]


def main():
    if not KEY:
        raise SystemExit("Set ETHERSCAN_API_KEY")
    now = int(time.time())
    print("Fetching mint logs...")
    ids = mint_token_ids()
    print(f"{len(ids)} unique token ids ever minted. Reading records (rate-limited)...")

    total_weight = 0
    top_active = 0
    subdomains = 0
    expired = 0
    by_len = {}
    for i, tid in enumerate(sorted(ids)):
        if i % 100 == 0:
            print(f"  {i}/{len(ids)} ... running weight {total_weight/SCALE:.4f} ETH")
        rec = records(tid)
        if rec is None:
            continue
        label, parent, expires = rec
        if parent != 0:
            subdomains += 1
            continue
        if expires <= now:
            expired += 1
            continue
        L = len(label)
        w = get_fee(L) * (expires - now) // YEAR
        total_weight += w
        top_active += 1
        by_len[L] = by_len.get(L, 0) + w

    print("\n===== WNS live weight =====")
    print(f"active top-level names : {top_active}")
    print(f"subdomains (0 weight)  : {subdomains}")
    print(f"expired (0 weight)     : {expired}")
    print(f"TOTAL LIVE WEIGHT      : {total_weight/SCALE:.4f} ETH  ({total_weight} wei)")
    print("\nweight by label byte-length (top tiers carry the most):")
    for L in sorted(by_len):
        print(f"  len {L:>2}: {by_len[L]/SCALE:.4f} ETH")

    print("\n===== suggested threshold (7-day alpha) =====")
    alpha = 999998853923940000
    cmax_per = SCALE / (SCALE - alpha)  # convictionMax multiplier ~= 872,540
    for pct in (0.05, 0.10, 0.15):
        w_req = int(total_weight * pct)
        threshold = int(w_req * cmax_per / 2)
        print(f"  W_req = {pct*100:>4.0f}% of live weight = {w_req/SCALE:.4f} ETH"
              f"  -> THRESHOLD = {threshold}")
    print("\nPick W_req so a real coalition (not one short-name whale) passes; "
          "threshold is exec/gov-adjustable later.")


if __name__ == "__main__":
    main()
