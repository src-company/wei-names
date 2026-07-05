#!/usr/bin/env python3
"""
Time-budgeted CreateX CREATE3 vanity miner. Collects every hit with >= MINBYTES leading zero bytes for
a sender-bound salt (first 20 bytes = caller) and keeps the one with the MOST leading zero nibbles —
so a lucky extra zero byte or two after the target wins. Same derivation as ops/mine_create3.py.

Usage: python3 ops/mine_best.py <CALLER_EOA> [budget_seconds=480] [min_zero_bytes=3]
"""
import sys
import time
import secrets
from multiprocessing import Process, Queue, cpu_count
from Crypto.Hash import keccak as _K

CREATEX = bytes.fromhex("ba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed")
PROXY_HASH = bytes.fromhex("21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f")
_FF = b"\xff" + CREATEX
_D694 = b"\xd6\x94"


def k(b):
    h = _K.new(digest_bits=256)
    h.update(b)
    return h.digest()


def addr_for(pad, salt):
    return k(_D694 + k(_FF + k(pad + salt) + PROXY_HASH)[12:] + b"\x01")[12:]


def nibbles(a):
    n = 0
    for c in a.hex():
        if c == "0":
            n += 1
        else:
            break
    return n


def worker(caller, minb, end, q):
    pad = caller.rjust(32, b"\0")
    base = caller + b"\x00"
    n = int.from_bytes(secrets.token_bytes(11), "big")
    cnt = 0
    prefix = b"\x00" * minb
    while time.time() < end:
        for _ in range(50000):
            salt = base + (n & ((1 << 88) - 1)).to_bytes(11, "big")
            a = addr_for(pad, salt)
            if a[:minb] == prefix:
                q.put((nibbles(a), salt.hex(), a.hex()))
            n += 1
            cnt += 1
    q.put(("COUNT", cnt))


def main():
    caller = bytes.fromhex(sys.argv[1][2:] if sys.argv[1].startswith("0x") else sys.argv[1])
    assert len(caller) == 20
    budget = float(sys.argv[2]) if len(sys.argv) > 2 else 480
    minb = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    end = time.time() + budget
    q = Queue()
    procs = [Process(target=worker, args=(caller, minb, end, q)) for _ in range(cpu_count())]
    for p in procs:
        p.start()
    best = None
    total = 0
    done = 0
    while done < len(procs):
        item = q.get()
        if item[0] == "COUNT":
            total += item[1]
            done += 1
            continue
        nb, salt, a = item
        print(f"  hit 0x{a}  ({nb} zero-nibbles)  salt 0x{salt}", flush=True)
        if best is None or nb > best[0]:
            best = (nb, salt, a)
    for p in procs:
        p.join()
    print(f"\nattempts ~{total:,}  ({total / budget:,.0f}/s over {cpu_count()} cores)")
    if best:
        print(f"BEST 0x{best[2]}  ({best[0]} leading zero nibbles)")
        print(f"SALT 0x{best[1]}")
    else:
        print("no hit within budget")


if __name__ == "__main__":
    main()
