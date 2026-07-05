#!/usr/bin/env python3
"""
Mine a CreateX CREATE3 vanity salt for WeiDAO — an address with N leading zero bytes.

Derivation is verified byte-for-byte against `cast` (guardedSalt -> proxy CREATE2 -> CREATE nonce 1).
The salt is SENDER-PROTECTED: first 20 bytes = your deployer EOA, byte 21 = 0x00 (no cross-chain
redeploy flag). CreateX then requires that *same* EOA to call deployCreate3, so nobody can front-run
the salt or the dao.wei pre-approval that rides on the predicted address.

Usage:
    python3 ops/mine_create3.py <DEPLOYER_EOA> [leading_zero_bytes=4]
    python3 ops/mine_create3.py verify <DEPLOYER_EOA> <salt_hex>   # confirm a salt -> address

Note: leading-4-zero-bytes is ~2^32 work; on a few CPU cores this is hours. For real use prefer a
GPU miner (createxcrunch, by the CreateX author) and then `verify` its output with this script.
"""
import sys
import secrets
from multiprocessing import Process, Queue, cpu_count
from eth_hash.auto import keccak

CREATEX = bytes.fromhex("ba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed")
PROXY_HASH = bytes.fromhex("21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f")
_FF = b"\xff" + CREATEX
_D694 = b"\xd6\x94"


def address_for(caller: bytes, salt: bytes) -> bytes:
    gsalt = keccak(caller.rjust(32, b"\0") + salt)  # CreateX _guard: MsgSender + no-redeploy flag
    proxy = keccak(_FF + gsalt + PROXY_HASH)[12:]  # minimal CREATE3 proxy via CREATE2
    return keccak(_D694 + proxy + b"\x01")[12:]  # deployed contract = CREATE(proxy, nonce 1)


def _worker(caller: bytes, nzero: int, q: Queue) -> None:
    prefix = b"\x00" * nzero
    pad = caller.rjust(32, b"\0")
    base = caller + b"\x00"
    n = int.from_bytes(secrets.token_bytes(11), "big")
    while q.empty():
        salt = base + (n & ((1 << 88) - 1)).to_bytes(11, "big")
        proxy = keccak(_FF + keccak(pad + salt) + PROXY_HASH)[12:]
        if keccak(_D694 + proxy + b"\x01")[12:nzero + 12].startswith(prefix):
            q.put(salt.hex())
            return
        n += 1


def _as20(h: str) -> bytes:
    b = bytes.fromhex(h[2:] if h.startswith("0x") else h)
    assert len(b) == 20, "deployer EOA must be a 20-byte address"
    return b


def mine(caller_hex: str, nzero: int) -> None:
    caller = _as20(caller_hex)
    q: Queue = Queue()
    procs = [Process(target=_worker, args=(caller, nzero, q)) for _ in range(cpu_count())]
    for p in procs:
        p.start()
    salt = q.get()
    for p in procs:
        p.terminate()
    addr = address_for(caller, bytes.fromhex(salt))
    assert addr.startswith(b"\x00" * nzero)
    print("SALT     0x" + salt)
    print("ADDRESS  0x" + addr.hex())


def verify(caller_hex: str, salt_hex: str) -> None:
    caller = _as20(caller_hex)
    salt = bytes.fromhex(salt_hex[2:] if salt_hex.startswith("0x") else salt_hex)
    assert len(salt) == 32, "salt must be 32 bytes"
    assert salt[:20] == caller, "salt is NOT sender-bound to this caller (front-run risk)"
    assert salt[20] == 0, "flag byte (index 20) must be 0x00"
    print("ADDRESS  0x" + address_for(caller, salt).hex())


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "verify":
        verify(sys.argv[2], sys.argv[3])
    else:
        mine(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 4)
